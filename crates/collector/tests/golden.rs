//! Plays every synthetic fixture case and compares each expected file (JSON values, exact revisions and CSV bytes),
//! the hand-written token total and privacy canaries. `fixtures/README.md` specifies the input protocol.
//! `TOKENTRACKY_BLESS=1` writes intended changes to `rust-expected/`; review them as accounting changes.
mod support;

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use support::{Case, HISTORY_START, NOW, Op, Price, Query, SqlDatabases, cases, files_below, target};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokentracky_collector::readers::{SourceKind, source_kind};
use tokentracky_collector::store::{
    PricedCost, Pricer, PublicationOptions, QueryOptions, SourceConfiguration, StoreError, UsageStore,
};
use tokentracky_collector::{IngestionOptions, IngestionService, ScanResult};
use tokentracky_core::{CostParts, TOOL_IDS, ToolId, UsageEvent};

/// What one case left behind: each step's files as text, the temporary root, and the database after closing.
struct Played {
    steps: Vec<BTreeMap<String, String>>,
    root: String,
    database: Vec<u8>,
}
type Store = Arc<Mutex<UsageStore>>;

fn time(value: &str) -> OffsetDateTime {
    OffsetDateTime::parse(value, &Rfc3339).unwrap_or_else(|error| panic!("{value}: {error}"))
}
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn tool_text(tool: ToolId) -> String {
    serde_json::to_value(tool).unwrap().as_str().unwrap().to_owned()
}
/// Synthetic price table: each token kind times its rate, in micro-USD; `unpriced` models have no price.
fn pricer(price: &Option<Price>) -> Option<Pricer> {
    let price = price.clone()?;
    Some(Box::new(move |event: &UsageEvent| {
        let (rates, tokens) = (&price.rates, &event.tokens);
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
    }))
}
/// Golden JSON: keys sorted, two-space indent, trailing newline.
fn stringify(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap() + "\n"
}
/// `relative(root, path) || '.'`.
fn relative(root: &Path, path: &str) -> String {
    match Path::new(path).strip_prefix(root) {
        Ok(inner) if inner.as_os_str().is_empty() => ".".to_owned(),
        Ok(inner) => text(inner),
        Err(_) => path.to_owned(),
    }
}
fn queried(store: &UsageStore, options: &QueryOptions) -> Result<Value, StoreError> {
    Ok(json!({
        "summary": store.summary(options)?,
        "sessions": store.sessions(options)?,
        "projects": store.projects(options)?,
        "breakdown": store.breakdown(options)?,
        "events": store.events(options)?,
        "csv": store.export_csv(options)?,
    }))
}

/// The expected files of one step: every output of the store after the step's scan, as text.
fn collect(
    store: &mut UsageStore,
    scan: &ScanResult,
    root: &Path,
    seen: &BTreeSet<String>,
    now: OffsetDateTime,
    queries: &BTreeMap<String, Query>,
    about: &BTreeSet<String>,
) -> BTreeMap<String, String> {
    let all = QueryOptions::default();
    let mut files = BTreeMap::new();
    let mut json = |name: &str, value: Value| files.insert(format!("{name}.json"), stringify(&value));
    json("events", json!(store.events(&all).unwrap()));
    let at = QueryOptions {
        now: Some(now),
        ..Default::default()
    };
    json("summary", json!(store.summary(&at).unwrap()));
    json("sessions", json!(store.sessions(&all).unwrap()));
    json("projects", json!(store.projects(&all).unwrap()));
    json("breakdown", json!(store.breakdown(&all).unwrap()));
    json("period-totals", json!(store.period_totals(now, None).unwrap()));
    json("diagnostics", json!(scan.diagnostics));
    // The tools a case is about: its own and those it grants, and any enabled or holding usage.
    let sources: Vec<Value> = scan
        .status
        .sources
        .iter()
        .filter(|source| about.contains(&tool_text(source.id)) || source.enabled || source.event_count > 0)
        .map(|source| {
            let mut value = json!(source);
            value["paths"] = json!(source.paths.iter().map(|path| relative(root, path)).collect::<Vec<_>>());
            value
        })
        .collect();
    json(
        "source-status",
        json!({"lastScanAt": scan.status.last_scan_at, "sources": sources}),
    );
    let mut checkpoints = serde_json::Map::new();
    for &tool in TOOL_IDS {
        for path in seen {
            let file = root.join(path);
            if let Some(checkpoint) = store.checkpoint(&text(&file), Some(tool)).unwrap() {
                let mut entry = json!({"diagnostics": checkpoint.diagnostics});
                if source_kind(tool, &file) == Some(SourceKind::Jsonl) {
                    entry["offset"] = json!(checkpoint.offset);
                }
                checkpoints.insert(format!("{}:{path}", tool_text(tool)), entry);
            }
        }
    }
    json("files", Value::Object(checkpoints));
    // Revisions come from one counter shared with event commits, so the order of these projections is part of the
    // contract. It is the order of the keys.
    let mut buckets = serde_json::Map::new();
    let word = |on: bool| if on { "on" } else { "off" };
    for share_tools in [false, true] {
        for share_cost in [false, true] {
            for share_models in [false, true] {
                for history_start in [Some(HISTORY_START), None] {
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
                    buckets.insert(variant, json!(store.project_public_buckets(&options).unwrap()));
                }
            }
        }
    }
    json("public-buckets", Value::Object(buckets));
    if !queries.is_empty() {
        let mut results = serde_json::Map::new();
        for (name, query) in queries {
            let days = query.days.map(|days| {
                assert_eq!(days.fract(), 0.0, "{name}: the runner passes whole days");
                days as i64
            });
            let tool = query.tool.as_deref().filter(|tool| *tool != "all");
            let options = QueryOptions {
                days,
                offset: None,
                from: query.from.clone(),
                to: query.to.clone(),
                since: None,
                until: None,
                tool: tool.map(|tool| serde_json::from_value(json!(tool)).unwrap()),
                q: query.q.clone(),
                now: Some(query.now.as_deref().map_or(now, time)),
                tz: None,
            };
            let result = queried(store, &options).unwrap_or_else(|error| json!({"error": error.to_string()}));
            results.insert(name.clone(), result);
        }
        json("queries", Value::Object(results));
    }
    files.insert("export.csv".to_owned(), store.export_csv(&all).unwrap());
    files
}

fn open(database: &Path, price: &Option<Price>, clock: &Arc<Mutex<OffsetDateTime>>) -> (Store, IngestionService) {
    let mut store = UsageStore::open(database).unwrap();
    store.set_pricer(pricer(price), price.as_ref().map(|price| price.version.as_str()));
    let store = Arc::new(Mutex::new(store));
    let clock = clock.clone();
    let options = IngestionOptions {
        now: Some(Arc::new(move || *clock.lock().unwrap_or_else(PoisonError::into_inner))),
        ..Default::default()
    };
    (store.clone(), IngestionService::new(store, options).unwrap())
}
fn close(store: Store, service: IngestionService) {
    service.stop();
    drop(service);
    let store = Arc::try_unwrap(store).unwrap_or_else(|_| panic!("the store has one owner"));
    store.into_inner().unwrap().close().unwrap();
}

/// Plays a case in a temporary folder (`play` in runner.ts). Per step: the ops, then the files of the step's `root/`
/// (a file that exists is rewritten in place, `X.db.sql` runs against its database), then, in the first step, the
/// case's `sources` are granted, then one scan, then the outputs are collected.
fn play(case: &Case) -> Played {
    let temporary = tempfile::Builder::new()
        .prefix("tokentracky-fixture-")
        .tempdir()
        .unwrap();
    let directory = fs::canonicalize(temporary.path()).unwrap();
    let root = directory.join("root");
    let database = directory.join("usage.sqlite");
    let mut databases = SqlDatabases::default();
    let mut seen = BTreeSet::new();
    let sources = case.sources();
    let clock = Arc::new(Mutex::new(time(case.config.now.as_deref().unwrap_or(NOW))));
    let mut price = case.config.price.clone();
    let (mut store, mut service) = open(&database, &price, &clock);
    fs::create_dir(&root).unwrap();
    let mut steps = Vec::new();
    for (index, step) in case.steps.iter().enumerate() {
        if let Some(now) = &step.config.now {
            *clock.lock().unwrap() = time(now);
        }
        for op in &step.config.ops {
            match op {
                Op::Rename { from, to } => {
                    fs::rename(root.join(from), root.join(to)).unwrap();
                    seen.insert(to.clone());
                }
                Op::Remove { path } => fs::remove_file(root.join(path)).unwrap(),
                Op::Restart => {
                    close(store, service);
                    (store, service) = open(&database, &price, &clock);
                }
                Op::Configure { tool, enabled, paths } => {
                    let paths = paths.iter().map(|path| text(&root.join(path))).collect();
                    let configuration = SourceConfiguration {
                        enabled: *enabled,
                        paths,
                    };
                    service.configure_source(*tool, &configuration).unwrap();
                }
                Op::Price { price: next } => {
                    price = next.clone();
                    let version = price.as_ref().map(|price| price.version.as_str());
                    store.lock().unwrap().set_pricer(pricer(&price), version);
                }
            }
        }
        for path in files_below(&step.root()) {
            let source = step.root().join(&path);
            let file = root.join(target(&path));
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            if target(&path) != path {
                databases.apply(&source, &file);
            } else {
                // `writeFile` truncates an existing file in place: same inode, as a tool rewriting its log.
                fs::write(&file, fs::read(&source).unwrap()).unwrap();
            }
            seen.insert(target(&path).to_owned());
        }
        if index == 0 {
            for (tool, paths) in &sources {
                let configuration = SourceConfiguration {
                    enabled: true,
                    paths: paths.iter().map(|path| text(&root.join(path))).collect(),
                };
                service.configure_source(*tool, &configuration).unwrap();
            }
        }
        let scan = service
            .scan()
            .unwrap_or_else(|error| panic!("{} {}: scan: {error}", case.name, step.name));
        let now = *clock.lock().unwrap();
        let mut locked = store.lock().unwrap();
        let about: BTreeSet<String> = sources
            .keys()
            .map(|tool| tool_text(*tool))
            .chain([case.tool.clone()])
            .collect();
        steps.push(collect(
            &mut locked,
            &scan,
            &root,
            &seen,
            now,
            &case.config.queries,
            &about,
        ));
    }
    close(store, service);
    databases.close();
    Played {
        steps,
        root: text(&root),
        database: fs::read(&database).unwrap(),
    }
}

/// JSON equality with numbers compared by value (JavaScript writes `0` where Rust writes `0.0`); the first difference.
fn difference(actual: &Value, expected: &Value, at: &str) -> Option<String> {
    let differ = || Some(format!("{at}: actual {actual}, expected {expected}"));
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => (a.as_f64() != b.as_f64()).then(differ).flatten(),
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .find_map(|(index, (a, b))| difference(a, b, &format!("{at}[{index}]"))),
        (Value::Object(a), Value::Object(b)) if a.keys().eq(b.keys()) => a
            .iter()
            .find_map(|(key, value)| difference(value, &b[key], &format!("{at}.{key}"))),
        _ => (actual != expected).then(differ).flatten(),
    }
}
/// Numbers as JavaScript writes them: a whole float as an integer.
fn js_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 9_007_199_254_740_992.0 => json!(float as i64),
            _ => Value::Number(number),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(js_numbers).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(key, value)| (key, js_numbers(value))).collect()),
        other => other,
    }
}
fn blessing() -> bool {
    std::env::var("TOKENTRACKY_BLESS").is_ok_and(|value| value == "1")
}
/// Writes `actual` as the step's Rust override, or removes the override when the TypeScript golden already says it.
fn bless(step: &support::Step, name: &str, actual: &str) {
    let override_path = step.dir.join("rust-expected").join(name);
    let golden = fs::read(step.dir.join("expected").join(name)).ok();
    let same = |golden: &[u8]| {
        if name.ends_with(".json") {
            let golden: Value = serde_json::from_slice(golden).unwrap();
            difference(&serde_json::from_str(actual).unwrap(), &golden, "").is_none()
        } else {
            actual.as_bytes() == golden
        }
    };
    if golden.as_deref().is_some_and(same) {
        let _ = fs::remove_file(&override_path);
        return;
    }
    fs::create_dir_all(override_path.parent().unwrap()).unwrap();
    let text = if name.ends_with(".json") {
        stringify(&js_numbers(serde_json::from_str(actual).unwrap()))
    } else {
        actual.to_owned()
    };
    fs::write(&override_path, text).unwrap();
}
/// Every row's kinds add up to its tokens, and each kind reconciles across summary, tools, models, days, breakdown
/// rows and the CSV columns.
fn kind_mismatches(files: &BTreeMap<String, String>) -> Vec<String> {
    const KINDS: [&str; 5] = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
    let read = |name: &str| -> Value { serde_json::from_str(&files[name]).unwrap() };
    let (summary, events) = (read("summary.json"), read("events.json"));
    let list = |value: &Value| value.as_array().cloned().unwrap_or_default();
    let count = |value: &Value, kind: &str| value[kind].as_u64().unwrap_or(0);
    let of = |events: &[Value]| KINDS.map(|kind| events.iter().map(|event| count(&event["tokens"], kind)).sum::<u64>());
    let added = |rows: &[Value]| KINDS.map(|kind| rows.iter().map(|row| count(&row["breakdown"], kind)).sum::<u64>());
    let all = list(&events);
    let dated: Vec<Value> = all
        .iter()
        .filter(|event| !event["occurredAt"].is_null())
        .cloned()
        .collect();
    let mut found = Vec::new();
    let (projects, breakdown) = (list(&read("projects.json")), list(&read("breakdown.json")));
    let typed = [
        vec![summary.clone()],
        list(&summary["byTool"]),
        list(&summary["byModel"]),
        list(&summary["daily"]),
        projects,
        breakdown.clone(),
    ];
    for row in typed.iter().flatten() {
        let total: u64 = KINDS[..4].iter().map(|kind| count(&row["breakdown"], kind)).sum();
        if Some(total) != row["tokens"].as_u64() {
            found.push(format!("kinds add up to {total}, not {}", row["tokens"]));
        }
    }
    // Cost by kind is known exactly when the cost is, and adds up to it.
    for row in typed[..4].iter().flatten() {
        let parts = &row["costParts"];
        let added = ["input", "output", "cacheRead", "cacheWrite"]
            .map(|kind| count(parts, kind))
            .iter()
            .sum::<u64>();
        if parts.is_null() != row["costMicrousd"].is_null()
            || (!parts.is_null() && Some(added) != row["costMicrousd"].as_u64())
        {
            found.push(format!("cost parts {parts} for cost {}", row["costMicrousd"]));
        }
    }
    let csv = csv_rows(&files["export.csv"]);
    let columns = KINDS.map(|kind| {
        let column = 5 + KINDS.iter().position(|k| *k == kind).unwrap();
        csv[1..]
            .iter()
            .map(|row| row[column].parse::<u64>().unwrap())
            .sum::<u64>()
    });
    for (name, actual, wanted) in [
        ("summary", added(std::slice::from_ref(&summary)), of(&all)),
        ("tools", added(&list(&summary["byTool"])), of(&all)),
        ("models", added(&list(&summary["byModel"])), of(&all)),
        ("days", added(&list(&summary["daily"])), of(&dated)),
        ("breakdown", added(&breakdown), of(&dated)),
        ("csv", columns, of(&all)),
    ] {
        if actual != wanted {
            found.push(format!("{name} kinds {actual:?}, events {wanted:?}"));
        }
    }
    found
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

/// The token kinds of `breakdown`, in CSV column order, then the 1-hour cache-write part.
const KINDS: [&str; 6] = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "cacheWrite1h",
];
fn kinds(breakdown: &Value) -> [u64; 6] {
    KINDS.map(|kind| breakdown[kind].as_u64().unwrap_or(0))
}
fn add(a: [u64; 6], b: [u64; 6]) -> [u64; 6] {
    std::array::from_fn(|at| a[at] + b[at])
}
/// The cells of each CSV row, every cell quoted with doubled quotes.
fn csv_rows(csv: &str) -> Vec<Vec<String>> {
    let cells = |row: &str| {
        let (mut cells, mut cell, mut inside, mut chars) = (Vec::new(), String::new(), false, row.chars().peekable());
        while let Some(c) = chars.next() {
            match (c, inside) {
                ('"', true) if chars.peek() == Some(&'"') => {
                    cell.push('"');
                    chars.next();
                }
                ('"', _) => inside = !inside,
                (',', false) => cells.push(std::mem::take(&mut cell)),
                _ => cell.push(c),
            }
        }
        cells.push(cell);
        cells
    };
    csv.split("\r\n").filter(|row| !row.is_empty()).map(cells).collect()
}
/// The kinds of `items` summed, noting any row whose `breakdown` does not add up to its `tokens`.
fn total(label: &str, items: &[Value], found: &mut Vec<String>) -> [u64; 6] {
    let mut sum = [0; 6];
    for item in items {
        let counts = kinds(&item["breakdown"]);
        let tokens = item["tokens"].as_u64().unwrap();
        if counts[..4].iter().sum::<u64>() != tokens || counts[4] > counts[1] || counts[5] > counts[3] {
            found.push(format!(
                "{label}: breakdown {} against tokens {tokens}",
                item["breakdown"]
            ));
        }
        sum = add(sum, counts);
    }
    sum
}
/// Every row's `breakdown` adds up to its `tokens`, and the kinds reconcile across the summary, its tools, models and
/// days, the breakdown rows, sessions and the CSV columns (days and breakdown rows hold dated events only).
fn breakdown_mismatches(files: &BTreeMap<String, String>) -> Vec<String> {
    let json = |name: &str| serde_json::from_str::<Value>(&files[&format!("{name}.json")]).unwrap();
    let list = |value: Value| value.as_array().cloned().unwrap_or_default();
    let summary = json("summary");
    let mut found = Vec::new();
    // Cost parts add up to the cost, and are null exactly when it is.
    for row in [&summary].into_iter().chain(
        ["byTool", "byModel", "daily"]
            .iter()
            .flat_map(|key| summary[*key].as_array().into_iter().flatten()),
    ) {
        let parts = &row["costParts"];
        let added = ["input", "output", "cacheRead", "cacheWrite"]
            .iter()
            .map(|kind| parts[kind].as_u64())
            .sum::<Option<u64>>();
        if added != row["costMicrousd"].as_u64() {
            found.push(format!("costParts {parts} against cost {}", row["costMicrousd"]));
        }
    }
    let all = total("summary", std::slice::from_ref(&summary), &mut found);
    for (label, items) in [
        ("byTool", list(summary["byTool"].clone())),
        ("byModel", list(summary["byModel"].clone())),
        ("sessions", list(json("sessions"))),
    ] {
        if total(label, &items, &mut found) != all {
            found.push(format!("{label} kinds do not add up to the summary"));
        }
    }
    total("projects", &list(json("projects")), &mut found);
    let daily = total("daily", &list(summary["daily"].clone()), &mut found);
    if daily != total("breakdown rows", &list(json("breakdown")), &mut found) {
        found.push("daily and breakdown-row kinds differ".into());
    }
    let mut columns = [0; 5];
    for row in csv_rows(&files["export.csv"]).iter().skip(1) {
        for (at, column) in columns.iter_mut().enumerate() {
            *column += row[5 + at].parse::<u64>().unwrap();
        }
    }
    if columns[..] != all[..5] {
        found.push(format!("CSV kinds {columns:?} against summary {all:?}"));
    }
    found
}

/// Every mismatch of one played case against its expected files.
fn mismatches(case: &Case, played: &Played) -> Vec<String> {
    let mut found = Vec::new();
    let forbidden: Vec<&str> = ["PRIVATE_"]
        .into_iter()
        .chain(case.config.forbidden.iter().map(String::as_str))
        .collect();
    for needle in &forbidden {
        if contains(&played.database, needle) {
            found.push(format!("database contains {needle}"));
        }
    }
    for (step, files) in case.steps.iter().zip(&played.steps) {
        let expected = if step.dir.join("expected").exists() {
            step.dir.join("expected")
        } else {
            step.dir.join("rust-expected")
        };
        let mut names: Vec<String> = fs::read_dir(&expected)
            .or_else(|_| fs::read_dir(step.dir.join("expected")))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name != "tokens.json")
            .collect();
        names.sort();
        if !names.iter().eq(files.keys()) {
            found.push(format!("{}: files {:?}, expected {names:?}", step.name, files.keys()));
        }
        for (name, actual) in files {
            if blessing() {
                if case.config.rust_only {
                    let path = expected.join(name);
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(path, actual).unwrap();
                } else {
                    bless(step, name, actual);
                }
            }
            let Ok(wanted) = fs::read(step.expected_path(name)) else {
                continue;
            };
            if name.ends_with(".json") {
                let actual: Value = serde_json::from_str(actual).unwrap();
                let wanted: Value = serde_json::from_slice(&wanted).unwrap();
                if let Some(difference) = difference(&actual, &wanted, "") {
                    found.push(format!("{}/{name}{difference}", step.name));
                }
            } else if actual.as_bytes() != wanted {
                let wanted = String::from_utf8_lossy(&wanted);
                found.push(format!("{}/{name}: actual {actual:?}, expected {wanted:?}", step.name));
            }
            for needle in forbidden.iter().copied().chain([played.root.as_str()]) {
                if actual.contains(needle) {
                    found.push(format!("{}/{name} contains {needle}", step.name));
                }
            }
        }
        found.extend(
            kind_mismatches(files)
                .into_iter()
                .map(|mismatch| format!("{}: {mismatch}", step.name)),
        );
        // Written by hand from the input, so a regenerated golden cannot drift from the intended accounting.
        let summary: Value = serde_json::from_str(&files["summary.json"]).unwrap();
        if summary["tokens"].as_u64() != step.config.tokens {
            found.push(format!(
                "{}: total {} but step.json says {:?}",
                step.name, summary["tokens"], step.config.tokens
            ));
        }
        found.extend(
            breakdown_mismatches(files)
                .into_iter()
                .map(|m| format!("{}: {m}", step.name)),
        );
        // A public bucket exposes only day, tool, model, tokens, cost and revision, as its variant allows.
        let variants: BTreeMap<String, Vec<BTreeMap<String, Value>>> =
            serde_json::from_str(&files["public-buckets.json"]).unwrap();
        for (variant, buckets) in &variants {
            let on = |part: &str| variant.contains(&format!("{part}=on"));
            for bucket in buckets {
                let keys: Vec<&str> = bucket
                    .keys()
                    .map(String::as_str)
                    .filter(|key| *key != "model")
                    .collect();
                let kinds = bucket.get("breakdown").and_then(Value::as_object);
                let kind = |name: &str| kinds.and_then(|kinds| kinds.get(name)).and_then(Value::as_u64);
                let typed = kinds.is_some_and(|kinds| {
                    kinds
                        .keys()
                        .eq(["cacheRead", "cacheWrite", "input", "output", "reasoning"].iter())
                        && kinds.values().all(Value::is_u64)
                }) && ["input", "output", "cacheRead", "cacheWrite"]
                    .iter()
                    .map(|name| kind(name).unwrap_or(0))
                    .sum::<u64>()
                    == bucket["tokens"].as_u64().unwrap_or(u64::MAX)
                    && kind("reasoning") <= kind("output");
                let shaped = keys == ["breakdown", "costMicrousd", "day", "revision", "tokens", "tool"]
                    && typed
                    && (bucket["tool"] == "all") != on("tools")
                    && bucket.contains_key("model") == on("models")
                    && (on("cost") || bucket["costMicrousd"].is_null());
                if !shaped {
                    found.push(format!("{} {variant}: bucket {bucket:?}", step.name));
                }
            }
        }
    }
    found
}

#[test]
fn every_case_reproduces_every_expected_file() {
    let all = cases();
    let results: Vec<(String, usize, Vec<String>)> = std::thread::scope(|scope| {
        let running: Vec<_> = all
            .iter()
            .map(|case| {
                scope.spawn(move || {
                    let played = play(case);
                    (case.name.clone(), case.steps.len(), mismatches(case, &played))
                })
            })
            .collect();
        running.into_iter().map(|run| run.join().unwrap()).collect()
    });
    let steps: usize = results.iter().map(|(_, steps, _)| steps).sum();
    let failed: Vec<_> = results.iter().filter(|(_, _, found)| !found.is_empty()).collect();
    for (name, steps, found) in &failed {
        eprintln!("FAIL {name} ({steps} steps, {} mismatches)", found.len());
        for mismatch in found.iter().take(8) {
            eprintln!("  {mismatch}");
        }
    }
    eprintln!(
        "{} cases and {steps} steps compared; {} cases differ",
        results.len(),
        failed.len()
    );
    if std::env::var_os("TOKENTRACKY_CASES").is_none() {
        assert!(results.len() >= 69 && steps >= 115, "fixtures are missing");
    }
    assert!(failed.is_empty(), "{} of {} cases differ", failed.len(), results.len());
}
