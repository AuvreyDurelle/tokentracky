//! The store's golden oracle, without readers: each case's expected events, committed into a fresh store, must give
//! the expected summary, sessions, projects, breakdown, period totals, queries and CSV exactly, and the expected
//! public buckets of every variant apart from `revision` (it depends on the ingestion order the scan test checks).
//! A multi-step case is played at its last step; its buckets are skipped when they hold zero tombstones of earlier
//! steps, which a fresh store cannot have. fixtures/README.md specifies every file.
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokentracky_collector::store::{
    FileCheckpoint, PricedCost, Pricer, PublicationOptions, QueryOptions, StoreError, UsageStore,
};
use tokentracky_core::{CostParts, TOOL_IDS, ToolId, UsageEvent};

const NOW: &str = "2026-10-23T12:00:00.000Z";
const HISTORY_START: &str = "2026-10-21";

#[derive(Deserialize, Clone)]
struct Price {
    version: String,
    rates: Rates,
    #[serde(default)]
    unpriced: Vec<String>,
}
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Rates {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}
#[derive(Deserialize)]
struct Query {
    days: Option<i64>,
    from: Option<String>,
    to: Option<String>,
    tool: Option<String>,
    q: Option<String>,
    now: Option<String>,
}
#[derive(Deserialize)]
struct CaseConfig {
    now: Option<String>,
    price: Option<Price>,
    #[serde(default)]
    queries: BTreeMap<String, Query>,
}
#[derive(Deserialize, Default)]
struct StepConfig {
    #[serde(default)]
    ops: Vec<Value>,
    now: Option<String>,
}

// Private helpers until the shared tests/support module replaces them.
fn read(path: &Path) -> String {
    let override_path = path
        .parent()
        .filter(|parent| parent.ends_with("expected"))
        .and_then(|parent| Some(parent.parent()?.join("rust-expected").join(path.file_name()?)));
    let path = override_path.as_deref().filter(|path| path.exists()).unwrap_or(path);
    fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}
fn json<T: for<'de> Deserialize<'de>>(path: &Path) -> T {
    serde_json::from_str(&read(path)).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}
fn directories(path: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = fs::read_dir(path)
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}
/// Every case as `(tool/name, directory, step directories)`; a case without `steps/` is its own single step.
fn cases() -> Vec<(String, PathBuf, Vec<PathBuf>)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut found = Vec::new();
    for tool in directories(&root) {
        for dir in directories(&tool) {
            let name = format!(
                "{}/{}",
                tool.file_name().unwrap().to_string_lossy(),
                dir.file_name().unwrap().to_string_lossy()
            );
            let steps = directories(&dir.join("steps"));
            let steps = if steps.is_empty() { vec![dir.clone()] } else { steps };
            found.push((name, dir, steps));
        }
    }
    found
}
fn time(value: &str) -> OffsetDateTime {
    OffsetDateTime::parse(value, &Rfc3339).unwrap()
}
/// The synthetic price table: each token kind times its rate; `unpriced` models get no price.
fn pricer(price: Price) -> Pricer {
    Box::new(move |event: &UsageEvent| {
        let (rates, tokens) = (price.rates, &event.tokens);
        (!price.unpriced.contains(&event.model)).then(|| {
            let parts = CostParts {
                input: rates.input * tokens.input,
                output: rates.output * tokens.output,
                cache_read: rates.cache_read * tokens.cache_read,
                cache_write: rates.cache_write * tokens.cache_write,
                cache_savings: rates.input.saturating_sub(rates.cache_read) * tokens.cache_read,
            };
            PricedCost {
                cost_microusd: parts.input + parts.output + parts.cache_read + parts.cache_write,
                pricing_version: price.version.clone(),
                parts,
            }
        })
    })
}
/// JSON equality with numbers compared by value, since Rust writes `0.0` where JavaScript writes `0`.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b)),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => a == b,
    }
}
fn without_revisions(mut variants: Value) -> Value {
    for bucket in variants
        .as_object_mut()
        .unwrap()
        .values_mut()
        .flat_map(|buckets| buckets.as_array_mut().unwrap())
    {
        bucket.as_object_mut().unwrap().remove("revision");
    }
    variants
}
fn queried(store: &UsageStore, options: &QueryOptions) -> Result<Value, StoreError> {
    Ok(json!({
        "summary": store.summary(options)?,
        "sessions": store.sessions(options)?,
        "projects": store.projects(options)?,
        "breakdown": store.breakdown(options)?,
        "events": store.export_data(options)?,
        "csv": store.export_csv(options)?,
    }))
}

#[test]
fn every_case_reproduces_its_expected_outputs_from_its_events() {
    let (mut failures, mut covered, mut skipped) = (Vec::new(), 0, Vec::new());
    for (name, dir, steps) in cases() {
        let config: CaseConfig = json(&dir.join("case.json"));
        let (mut now, mut price) = (time(config.now.as_deref().unwrap_or(NOW)), config.price.clone());
        for step in &steps {
            let file = step.join("step.json");
            let step: StepConfig = if file.exists() {
                json(&file)
            } else {
                StepConfig::default()
            };
            now = step.now.as_deref().map_or(now, time);
            for op in step.ops.iter().filter(|op| op["op"] == "price") {
                price = serde_json::from_value(op["price"].clone()).unwrap();
            }
        }
        let expected = steps.last().unwrap().join("expected");
        let mut events: Vec<UsageEvent> = json(&expected.join("events.json"));
        if price.is_some() {
            // Committed unpriced, so the store's read-time pricing must produce every expected cost. A cost without a
            // table version is the tool's own (Grok Build's) and is committed as read.
            for event in events.iter_mut().filter(|event| event.pricing_version.is_some()) {
                (event.cost_microusd, event.pricing_version) = (None, None);
            }
        }
        let mut store = UsageStore::open(":memory:").unwrap();
        let version = price.as_ref().map(|price| price.version.clone());
        store.set_pricer(price.map(pricer), version.as_deref());
        for &tool in TOOL_IDS {
            let file: Vec<UsageEvent> = events.iter().filter(|event| event.tool == tool).cloned().collect();
            if !file.is_empty() {
                store.commit_file(&checkpoint(tool), &file, true).unwrap();
            }
        }

        let at = QueryOptions {
            now: Some(now),
            ..Default::default()
        };
        let all = QueryOptions::default();
        let mut actual = BTreeMap::from([
            ("events", json!(store.export_data(&all).unwrap())),
            ("summary", json!(store.summary(&at).unwrap())),
            ("sessions", json!(store.sessions(&all).unwrap())),
            ("projects", json!(store.projects(&all).unwrap())),
            ("breakdown", json!(store.breakdown(&all).unwrap())),
            ("period-totals", json!(store.period_totals(now, None).unwrap())),
        ]);
        if !config.queries.is_empty() {
            let queries: serde_json::Map<String, Value> = config
                .queries
                .iter()
                .map(|(query_name, query)| {
                    let options = QueryOptions {
                        days: query.days,
                        offset: None,
                        tz: None,
                        from: query.from.clone(),
                        to: query.to.clone(),
                        since: None,
                        until: None,
                        tool: query
                            .tool
                            .as_deref()
                            .filter(|tool| *tool != "all")
                            .map(|tool| serde_json::from_value::<ToolId>(json!(tool)).unwrap()),
                        q: query.q.clone(),
                        now: Some(query.now.as_deref().map_or(now, time)),
                    };
                    let result = queried(&store, &options).unwrap_or_else(|error| json!({"error": error.to_string()}));
                    (query_name.clone(), result)
                })
                .collect();
            actual.insert("queries", Value::Object(queries));
        }
        let mut variants = serde_json::Map::new();
        for share_tools in [false, true] {
            for share_cost in [false, true] {
                for share_models in [false, true] {
                    for history_start in [Some(HISTORY_START), None] {
                        let word = |on: bool| if on { "on" } else { "off" };
                        let variant = format!(
                            "tools={},cost={},models={},history={}",
                            word(share_tools),
                            word(share_cost),
                            word(share_models),
                            history_start.unwrap_or("none")
                        );
                        let options = PublicationOptions {
                            history_start: history_start.map(str::to_owned),
                            share_tools,
                            share_cost,
                            share_models,
                        };
                        variants.insert(variant, json!(store.project_public_buckets(&options).unwrap()));
                    }
                }
            }
        }
        let expected_buckets: Value = json(&expected.join("public-buckets.json"));
        let tombstones = expected_buckets
            .as_object()
            .unwrap()
            .values()
            .flat_map(|buckets| buckets.as_array().unwrap())
            .any(|bucket| bucket["tokens"] == 0);
        // These cases also carry database-origin verification outside UsageEvent. A fresh event-only store cannot
        // reconstruct their public exclusions; the full golden and accounting-reconciliation tests check them.
        let needs_origins = matches!(
            name.as_str(),
            "kilo/database-supersedes-tasks" | "kilo/v5-kept-until-database-read" | "kilo/v7-database"
        );
        if (steps.len() > 1 && tombstones) || needs_origins {
            skipped.push(name.clone());
        } else {
            actual.insert("public-buckets", without_revisions(Value::Object(variants)));
        }

        for (file, value) in &actual {
            // Through text, as the expected file is read: serde_json's float parsing can be one unit off.
            let value: Value = serde_json::from_str(&value.to_string()).unwrap();
            let mut wanted: Value = json(&expected.join(format!("{file}.json")));
            if *file == "public-buckets" {
                wanted = without_revisions(wanted);
            }
            if !same(&value, &wanted) {
                failures.push(format!("{name} {file}.json\n  actual:   {value}\n  expected: {wanted}"));
            }
        }
        let csv = store.export_csv(&all).unwrap();
        if csv.as_bytes() != read(&expected.join("export.csv")).into_bytes() {
            failures.push(format!(
                "{name} export.csv\n  actual:   {csv:?}\n  expected: {:?}",
                read(&expected.join("export.csv"))
            ));
        }
        covered += 1;
    }
    eprintln!("{covered} cases compared; public buckets skipped for tombstones in: {skipped:?}");
    assert!(covered > 60, "only {covered} cases found");
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// One synthetic file per tool: the events carry no source path.
fn checkpoint(tool: ToolId) -> FileCheckpoint {
    FileCheckpoint {
        path: format!("/fixture/{}", serde_json::to_value(tool).unwrap().as_str().unwrap()),
        tool,
        identity: "1:1".to_owned(),
        offset: 0,
        prefix_hash: "0".repeat(64),
        parser_version: 1,
        state: json!({"sessionId": null, "project": null, "model": "unknown", "turnId": null, "previous": null, "baselines": [], "seenDeltaIds": []}),
        diagnostics: Vec::new(),
        file_size: None,
        mtime_ms: None,
        ctime_ms: None,
    }
}
