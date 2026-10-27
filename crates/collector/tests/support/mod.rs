//! Fixture support for the collector's tests: discovers `fixtures/<tool>/<case>/` and
//! materialises `X.db.sql` scripts as `fixtures/sqlite.ts` does. `fixtures/README.md` specifies every file and field.
// Each test crate uses a different part of this module.
#![allow(dead_code)]
use rusqlite::Connection;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokentracky_core::ToolId;

/// The clock every case runs on unless it sets `now`.
pub const NOW: &str = "2026-10-23T12:00:00.000Z";
/// The history cut-off of the `history=` public-bucket variants.
pub const HISTORY_START: &str = "2026-10-21";

/// `fixtures/` at the repository root.
pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}
/// A file below `fixtures/`, decoded as lossy UTF-8 as the collector decodes what it reads (`fixtureText`).
pub fn fixture_text(path: impl AsRef<Path>) -> String {
    String::from_utf8_lossy(&fs::read(fixtures().join(path)).unwrap()).into_owned()
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rates {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}
/// Synthetic price table: cost is the sum of each token kind times its rate, in micro-USD; `unpriced` models have none.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Price {
    pub version: String,
    pub rates: Rates,
    #[serde(default)]
    pub unpriced: Vec<String>,
}
/// `tool` is a tool id or `all`; values are passed on unvalidated, as the store must reject bad ones itself.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub days: Option<f64>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub tool: Option<String>,
    pub q: Option<String>,
    pub now: Option<String>,
}
/// Paths are relative to the authorized folder (`root`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    Rename {
        from: String,
        to: String,
    },
    Remove {
        path: String,
    },
    Restart,
    Configure {
        tool: ToolId,
        enabled: bool,
        paths: Vec<String>,
    },
    Price {
        price: Option<Price>,
    },
}
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaseConfig {
    pub description: String,
    pub now: Option<String>,
    pub sources: Option<BTreeMap<ToolId, Vec<String>>>,
    pub price: Option<Price>,
    #[serde(default)]
    pub queries: BTreeMap<String, Query>,
    #[serde(default)]
    pub forbidden: Vec<String>,
    /// A tool the TypeScript collector does not read: these expected files are written by the Rust collector.
    #[serde(default, rename = "rustOnly")]
    pub rust_only: bool,
}
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepConfig {
    #[serde(default)]
    pub ops: Vec<Op>,
    pub now: Option<String>,
    /// The all-time token total after the step, written by hand.
    pub tokens: Option<u64>,
}
#[derive(Debug, Clone)]
pub struct Step {
    pub name: String,
    /// Holds the step's `root/`, `step.json` and `expected/`.
    pub dir: PathBuf,
    pub config: StepConfig,
}
#[derive(Debug, Clone)]
pub struct Case {
    /// `<tool>/<case>`.
    pub name: String,
    /// The case's folder: a tool id or `multi-tool`.
    pub tool: String,
    pub dir: PathBuf,
    pub config: CaseConfig,
    pub steps: Vec<Step>,
}
impl Case {
    /// The case's own tool, `None` for `multi-tool`.
    pub fn tool_id(&self) -> Option<ToolId> {
        serde_json::from_value(Value::from(self.tool.as_str())).ok()
    }
    /// Sources granted in the first step: `case.json` `sources`, or else the case's own tool on the whole folder (`.`).
    pub fn sources(&self) -> BTreeMap<ToolId, Vec<String>> {
        self.config.sources.clone().unwrap_or_else(|| {
            let tool = self
                .tool_id()
                .unwrap_or_else(|| panic!("{}: case.json needs sources", self.name));
            BTreeMap::from([(tool, vec![".".to_owned()])])
        })
    }
}
impl Step {
    pub fn root(&self) -> PathBuf {
        self.dir.join("root")
    }
    /// Intentional accounting fixes live in `rust-expected/` beside the `expected/` goldens, one override per changed file.
    pub fn expected_path(&self, name: &str) -> PathBuf {
        let rust = self.dir.join("rust-expected").join(name);
        if rust.exists() {
            rust
        } else {
            self.dir.join("expected").join(name)
        }
    }
    /// An expected JSON file, such as `events.json`.
    pub fn expected(&self, name: &str) -> Value {
        read_json(&self.expected_path(name))
            .unwrap_or_else(|| panic!("{}: expected/{name} is missing", self.dir.display()))
    }
    /// An expected file as text, such as `export.csv`.
    pub fn expected_text(&self, name: &str) -> String {
        fs::read_to_string(self.expected_path(name)).unwrap()
    }
}

/// Every case in `fixtures/<tool>/<case>`, with its steps in name order. A case without `steps/` is its own single step.
/// `TOKENTRACKY_CASES` (comma-separated name prefixes such as `pi/,kimi/`) limits a run to some cases.
pub fn cases() -> Vec<Case> {
    let only: Vec<String> = std::env::var("TOKENTRACKY_CASES")
        .map(|value| {
            value
                .split(',')
                .filter(|prefix| !prefix.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut found = Vec::new();
    for tool in subdirectories(&fixtures()) {
        for name in subdirectories(&fixtures().join(&tool)) {
            let dir = fixtures().join(&tool).join(&name);
            let config =
                read_json(&dir.join("case.json")).unwrap_or_else(|| panic!("{tool}/{name}: case.json is missing"));
            let names = subdirectories(&dir.join("steps"));
            let steps = if names.is_empty() {
                vec![step("scan".into(), dir.clone())]
            } else {
                names
                    .into_iter()
                    .map(|step_name| step(step_name.clone(), dir.join("steps").join(step_name)))
                    .collect()
            };
            if !only.is_empty()
                && !only
                    .iter()
                    .any(|prefix| format!("{tool}/{name}").starts_with(prefix.as_str()))
            {
                continue;
            }
            found.push(Case {
                name: format!("{tool}/{name}"),
                tool: tool.clone(),
                dir,
                config,
                steps,
            });
        }
    }
    found
}
fn step(name: String, dir: PathBuf) -> Step {
    let mut config: StepConfig = read_json(&dir.join("step.json")).unwrap_or_default();
    if let Some(tokens) = read_json(&dir.join("rust-expected/tokens.json")) {
        config.tokens = Some(tokens);
    }
    Step { name, dir, config }
}
fn subdirectories(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(path)
        .into_iter()
        .flatten()
        .map(Result::unwrap)
        .filter(|entry| entry.file_type().unwrap().is_dir())
        .map(|entry| entry.file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}
/// A JSON file, or `None` when it does not exist.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    Some(serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display())))
}
/// Relative paths (`/`-separated) of every file below `directory`, each folder's entries in byte order (`filesBelow`).
/// Empty when the directory does not exist.
pub fn files_below(directory: &Path) -> Vec<String> {
    let mut found = Vec::new();
    collect(directory, "", &mut found);
    found
}
fn collect(directory: &Path, base: &str, found: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(directory.join(base)) else {
        return;
    };
    let mut entries: Vec<_> = entries.map(Result::unwrap).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().into_string().unwrap();
        let path = if base.is_empty() {
            name
        } else {
            format!("{base}/{name}")
        };
        if entry.file_type().unwrap().is_dir() {
            collect(directory, &path, found)
        } else {
            found.push(path)
        }
    }
}
/// The path a step file takes below `root/`: `X.db.sql` is materialised as the database `X.db` (and a Rust-only
/// case's `X.sqlite.sql` as `X.sqlite`).
pub fn target(path: &str) -> &str {
    path.strip_suffix(".sql")
        .filter(|database| database.ends_with(".db") || database.ends_with(".sqlite"))
        .unwrap_or(path)
}

/// Materialises `X.db.sql` fixtures (schema and inserts, as `sqlite3 .dump` writes them) as real databases. Each one
/// stays open until `close` or drop, like the tool that owns it, so a script may leave a transaction for a later one.
#[derive(Default)]
pub struct SqlDatabases {
    open: HashMap<PathBuf, Connection>,
}
impl SqlDatabases {
    /// Runs the script against the database file, creating it on first use.
    pub fn apply(&mut self, script: &Path, database: &Path) {
        let connection = self.open.entry(database.to_path_buf()).or_insert_with(|| {
            let connection = Connection::open(database).unwrap();
            // `node:sqlite` waits for no lock; neither does the fixture writer.
            connection.busy_timeout(Duration::ZERO).unwrap();
            connection
        });
        let sql = fs::read_to_string(script).unwrap();
        connection
            .execute_batch(&sql)
            .unwrap_or_else(|error| panic!("{}: {error}", script.display()));
    }
    pub fn close(&mut self) {
        self.open.clear();
    }
}
