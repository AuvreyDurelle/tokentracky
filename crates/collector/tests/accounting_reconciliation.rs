//! Section 3 regressions. These intentionally supersede frozen TypeScript accounting assumptions.
mod support;

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use support::fixture_text;
use tokentracky_collector::readers::{PARSER_VERSION, read_opencode_database};
use tokentracky_collector::store::{PricedCost, PublicationOptions, QueryOptions, SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService};
use tokentracky_core::{CostParts, ToolId, UsageEvent, total_tokens};

struct Collector {
    store: Arc<Mutex<UsageStore>>,
    service: IngestionService,
}
impl Collector {
    fn open(path: &Path) -> Self {
        let mut store = UsageStore::open(path).unwrap();
        store.set_pricer(
            Some(Box::new(|event| {
                let t = &event.tokens;
                let parts = CostParts {
                    input: 2 * t.input,
                    output: 5 * t.output,
                    cache_read: t.cache_read,
                    cache_write: 3 * t.cache_write,
                    cache_savings: t.cache_read,
                };
                Some(PricedCost {
                    cost_microusd: parts.input + parts.output + parts.cache_read + parts.cache_write,
                    pricing_version: "synthetic-v1".into(),
                    parts,
                })
            })),
            Some("synthetic-v1"),
        );
        let store = Arc::new(Mutex::new(store));
        let service = IngestionService::new(store.clone(), IngestionOptions::default()).unwrap();
        Self { store, service }
    }
    fn configure(&self, tool: ToolId, path: &Path, enabled: bool) {
        self.service
            .configure_source(
                tool,
                &SourceConfiguration {
                    enabled,
                    paths: vec![path.to_string_lossy().into_owned()],
                },
            )
            .unwrap();
    }
    fn scan(&self) {
        let result = self.service.scan().unwrap();
        assert!(
            result.diagnostics.iter().all(|d| d == "kilo_history_local_only"),
            "{:?}",
            result.diagnostics
        );
    }
    fn events(&self) -> Vec<UsageEvent> {
        self.store.lock().unwrap().events(&QueryOptions::default()).unwrap()
    }
    fn assert_totals(&self, count: usize, tokens: u64, cost: u64) {
        self.assert_local_totals(count, tokens, cost);
        self.assert_public_tokens(tokens);
    }
    fn assert_local_totals(&self, count: usize, tokens: u64, cost: u64) {
        let store = self.store.lock().unwrap();
        let options = QueryOptions::default();
        let events = store.events(&options).unwrap();
        assert_eq!(events.len(), count);
        assert_eq!(events.iter().map(|e| total_tokens(&e.tokens)).sum::<u64>(), tokens);
        let summary = store.summary(&options).unwrap();
        assert_eq!((summary.tokens, summary.cost_microusd), (tokens, Some(cost)));
        assert_eq!(store.events(&options).unwrap(), events);
        let csv = store.export_csv(&options).unwrap();
        assert_eq!(csv.lines().count(), count + 1);
        let csv_counts: Vec<Vec<_>> = csv
            .lines()
            .skip(1)
            .map(|line| line.trim_matches('"').split("\",\"").collect())
            .collect();
        assert_eq!(
            csv_counts
                .iter()
                .map(|row| row[10].parse::<u64>().unwrap())
                .sum::<u64>(),
            tokens
        );
        assert_eq!(
            csv_counts
                .iter()
                .map(|row| row[11].parse::<u64>().unwrap())
                .sum::<u64>(),
            cost
        );
        assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE_"));
        assert!(!csv.contains("PRIVATE_"));
    }
    fn assert_public_tokens(&self, expected: u64) {
        let mut store = self.store.lock().unwrap();
        assert_eq!(
            store
                .project_public_buckets(&PublicationOptions {
                    share_cost: true,
                    ..Default::default()
                })
                .unwrap()
                .iter()
                .map(|b| b.tokens)
                .sum::<u64>(),
            expected
        );
    }
}
fn source_db(root: &Path, name: &str, fixture: &str) -> (PathBuf, Connection) {
    let path = root.join(name);
    let db = Connection::open(&path).unwrap();
    db.execute_batch(&fixture_text(fixture)).unwrap();
    (fs::canonicalize(path).unwrap(), db)
}

#[test]
fn omo_and_claude_mirrors_count_once_in_both_orders_and_keep_unrelated_sdk_usage() {
    for omo_first in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let claude = temp.path().join("claude.jsonl");
        let omo = temp.path().join("omo.jsonl");
        let sdk = |id, input, output, read, write| {
            json!({
                "type":"assistant", "sessionId":"sdk-session", "cwd":"/synthetic/p",
                "timestamp":"2026-10-23T12:00:00.000Z", "entrypoint":"sdk-ts", "userType":"external",
                "message":{"id":id,"model":"claude-sonnet-4-6", "usage":{
                    "input_tokens":input, "output_tokens":output, "cache_read_input_tokens":read,
                    "cache_creation_input_tokens":write}}
            })
        };
        fs::write(
            &claude,
            format!(
                "{}\n{}\n",
                sdk("msg_shared", 10, 20, 30, 40),
                sdk("msg_unrelated", 7, 0, 0, 0)
            ),
        )
        .unwrap();
        let entry = |output| {
            json!({"type":"message", "id":"pi-entry", "timestamp":"2026-10-23T12:00:00.000Z",
            "message":{"role":"assistant", "api":"claude-sdk-oauth", "responseId":"msg_shared",
                "model":"claude-sonnet-4-6", "usage":{"input":10,"output":output,"cacheRead":30,"cacheWrite":40}}})
        };
        fs::write(
            &omo,
            format!(
                "{}\n{}\n",
                json!({"type":"session","id":"omo-session","cwd":"/synthetic/p"}),
                entry(20)
            ),
        )
        .unwrap();
        let database = temp.path().join("usage.sqlite");
        let collector = Collector::open(&database);
        let (first, first_path, second, second_path) = if omo_first {
            (ToolId::Omo, &omo, ToolId::Claude, &claude)
        } else {
            (ToolId::Claude, &claude, ToolId::Omo, &omo)
        };
        collector.configure(first, first_path, true);
        collector.scan();
        collector.configure(second, second_path, true);
        collector.scan();
        collector.assert_totals(2, 107, 284);
        let events = collector.events();
        assert_eq!(events.iter().filter(|e| e.tool == ToolId::Omo).count(), 1);
        assert_eq!(events.iter().filter(|e| e.tool == ToolId::Claude).count(), 1);
        assert!(
            events
                .iter()
                .all(|e| !serde_json::to_string(e).unwrap().contains("msg_shared"))
        );
        let statuses = collector.store.lock().unwrap().source_statuses().unwrap();
        for tool in [ToolId::Claude, ToolId::Omo] {
            assert_eq!(statuses.iter().find(|s| s.id == tool).unwrap().event_count, 1);
        }
        collector.scan();
        collector.assert_totals(2, 107, 284);
        use std::io::Write;
        writeln!(fs::OpenOptions::new().append(true).open(&omo).unwrap(), "{}", entry(40)).unwrap();
        collector.scan();
        collector.assert_totals(2, 127, 384);
        let mut store = collector.store.lock().unwrap();
        let public = store.project_public_buckets(&PublicationOptions::default()).unwrap();
        assert!(!serde_json::to_string(&public).unwrap().contains("claudeMirrorId"));
        store
            .forget_file(fs::canonicalize(&omo).unwrap().to_str().unwrap(), ToolId::Omo)
            .unwrap();
        drop(store);
        collector.assert_totals(2, 107, 284);
        drop(collector);
        // Opening an upgraded store again preserves the fallback and its revisions.
        Collector::open(&database).assert_totals(2, 107, 284);
    }
}
fn totals(events: &[UsageEvent]) -> (u64, u64) {
    events.iter().fold((0, 0), |(tokens, cost), event| {
        let t = &event.tokens;
        (
            tokens + total_tokens(t),
            cost + 2 * t.input + 5 * t.output + t.cache_read + 3 * t.cache_write,
        )
    })
}
fn correction(db: &Connection, id: &str, path: &str, value: Value) {
    db.execute(
        "UPDATE session_message SET data=json_set(data,?,?) WHERE id=?",
        params![path, value.to_string().parse::<i64>().unwrap(), id],
    )
    .unwrap();
}

#[test]
fn v2_counts_boundaries_nested_forks_and_independent_identical_usage() {
    let temp = tempfile::tempdir().unwrap();
    let (path, db) = source_db(
        temp.path(),
        "opencode.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    // Compare the synthetic SQL copy rows with the output of the actual pinned projector body.
    let upstream: Value = serde_json::from_str(&fixture_text(
        "opencode/v2-assistant-and-compaction-rows/upstream-fork-output.json",
    ))
    .unwrap();
    for row in upstream["projection"].as_array().unwrap() {
        let tokens: String = db
            .query_row(
                "SELECT json_extract(data,'$.tokens') FROM session_message WHERE id=? AND session_id=? AND seq=?",
                params![
                    row["id"].as_str().unwrap(),
                    row["session_id"].as_str().unwrap(),
                    row["seq"].as_i64().unwrap()
                ],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&tokens).unwrap(), row["tokens"]);
    }
    let read = read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap();
    assert!(read.diagnostics.is_empty());
    assert_eq!(read.events.len(), 6);
    assert_eq!(totals(&read.events), (339, 785));
    let collector = Collector::open(&temp.path().join("usage.sqlite"));
    collector.configure(ToolId::OpenCode, &path, true);
    collector.scan();
    collector.assert_totals(6, 339, 785);
    let statuses = collector.store.lock().unwrap().source_statuses().unwrap();
    assert_eq!(
        statuses.iter().find(|s| s.id == ToolId::OpenCode).unwrap().event_count,
        6
    );
}

#[test]
fn v2_backfills_old_checkpoints_corrects_snapshots_and_retries_publication_across_restart_and_deletion() {
    let temp = tempfile::tempdir().unwrap();
    let (path, db) = source_db(
        temp.path(),
        "opencode.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    let store_path = temp.path().join("usage.sqlite");
    let collector = Collector::open(&store_path);
    collector.configure(ToolId::OpenCode, &path, true);
    collector.scan();
    // Simulate the frozen collector: it had never counted post-fork requests and had an old checkpoint.
    {
        let mut store = collector.store.lock().unwrap();
        let checkpoint = store
            .checkpoint(path.to_str().unwrap(), Some(ToolId::OpenCode))
            .unwrap()
            .unwrap();
        let original: Vec<_> = store
            .file_events(path.to_str().unwrap(), ToolId::OpenCode)
            .unwrap()
            .into_iter()
            .filter(|e| matches!(e.session_id.as_str(), "ses_root" | "ses_unrelated"))
            .collect();
        store.commit_file(&checkpoint, &original, true).unwrap();
    }
    Connection::open(&store_path)
        .unwrap()
        .execute("DELETE FROM usage_origins", [])
        .unwrap();
    collector.assert_totals(4, 260, 600);
    let publication = PublicationOptions {
        share_cost: true,
        share_tools: true,
        share_models: true,
        ..Default::default()
    };
    let omitted = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("synthetic", &publication)
        .unwrap();
    {
        let mut store = collector.store.lock().unwrap();
        let mut checkpoint = store
            .checkpoint(path.to_str().unwrap(), Some(ToolId::OpenCode))
            .unwrap()
            .unwrap();
        checkpoint.parser_version = 1;
        store.commit_file(&checkpoint, &[], false).unwrap();
        // An upgrade cannot publish even a frozen receipt until its old database checkpoint is revalidated.
        assert!(store.pending_publication("synthetic", &publication).is_err());
    }
    collector.scan(); // Parser version invalidates the unchanged database checkpoint: backfill +79 tokens.
    collector.assert_totals(6, 339, 785);
    assert_eq!(
        collector
            .store
            .lock()
            .unwrap()
            .pending_publication("synthetic", &publication)
            .unwrap(),
        omitted
    );
    collector
        .store
        .lock()
        .unwrap()
        .acknowledge_publication("synthetic", &omitted.receipt)
        .unwrap();
    let full = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("synthetic", &publication)
        .unwrap();
    assert_eq!(full.buckets.iter().map(|b| b.tokens).sum::<u64>(), 339);
    assert!(full.checkpoint > omitted.checkpoint);
    collector
        .store
        .lock()
        .unwrap()
        .acknowledge_publication("synthetic", &full.receipt)
        .unwrap();
    correction(&db, "msg_original", "$.tokens.input", json!(80));
    correction(&db, "msg_newb", "$.tokens.input", json!(15));
    correction(&db, "msg_pending", "$.tokens.input", json!(8));
    correction(&db, "msg_pending", "$.tokens.output", json!(2));
    correction(&db, "msg_pending", "$.time.completed", json!(1792746004000_i64));
    collector.scan();
    collector.assert_totals(6, 309, 728);
    let corrected = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("synthetic", &publication)
        .unwrap();
    assert_eq!(corrected.buckets.iter().map(|b| b.tokens).sum::<u64>(), 309);
    assert!(corrected.buckets[0].revision > full.buckets[0].revision);
    assert_eq!(corrected.base_receipt.as_deref(), Some(full.receipt.as_str()));
    drop(collector);
    let collector = Collector::open(&store_path);
    assert_eq!(
        collector
            .store
            .lock()
            .unwrap()
            .pending_publication("synthetic", &publication)
            .unwrap(),
        corrected
    );
    // A corrected original of zero is authoritative over every nonzero inherited snapshot.
    for field in ["input", "output", "reasoning"] {
        correction(&db, "msg_original", &format!("$.tokens.{field}"), json!(0));
    }
    for field in ["read", "write"] {
        correction(&db, "msg_original", &format!("$.tokens.cache.{field}"), json!(0));
    }
    collector.scan();
    collector.assert_totals(5, 213, 502);
    db.execute(
        "DELETE FROM session_message WHERE session_id IN ('ses_root','ses_before')",
        [],
    )
    .unwrap();
    db.execute("DELETE FROM session_v2 WHERE id IN ('ses_root','ses_before')", [])
        .unwrap();
    collector.scan();
    collector.assert_totals(5, 213, 502);
    collector.configure(ToolId::OpenCode, &path, false);
    collector.scan();
    collector.assert_totals(5, 213, 502);
    collector.configure(ToolId::OpenCode, &path, true);
    collector.scan();
    collector.assert_totals(5, 213, 502);
    db.execute("INSERT INTO session_message SELECT 'msg_after','ses_nested','assistant',8,1792746010000,json_set(data,'$.time.created',1792746010000,'$.tokens.input',7,'$.tokens.output',1,'$.tokens.reasoning',0) FROM session_message WHERE id='msg_newc'",[]).unwrap();
    collector.scan();
    collector.assert_totals(6, 221, 521);
    // Replaying the physical database and reopening do not resurrect stale counters.
    drop(collector);
    let collector = Collector::open(&store_path);
    collector.scan();
    collector.assert_totals(6, 221, 521);
    const { assert!(PARSER_VERSION >= 6) };
}

fn roo_task(root: &Path) -> PathBuf {
    let task = root.join("synthetic-task");
    fs::create_dir_all(&task).unwrap();
    fs::write(task.join("ui_messages.json"),r#"[{"ts":1792746001000,"type":"say","say":"api_req_started","text":"{\"tokensIn\":1500,\"tokensOut\":200,\"cacheReads\":1000,\"cacheWrites\":100}"}]"#).unwrap();
    fs::write(
        task.join("api_conversation_history.json"),
        r#"[{"content":"PRIVATE_PROMPT_MARKER <model>synthetic-model</model>"}]"#,
    )
    .unwrap();
    task
}
fn native_kilo(db: &Connection) {
    let data = json!({"role":"assistant","time":{"created":1792746001000_i64,"completed":1792746001000_i64},
        "modelID":"synthetic-model","providerID":"synthetic","tokens":{"input":40,"output":20,"reasoning":5,"cache":{"read":7,"write":3}}});
    db.execute(
        "INSERT INTO message VALUES('msg_new','ses_native',1792746001000,?)",
        [data.to_string()],
    )
    .unwrap();
}

#[test]
fn pinned_roo_import_has_zero_usage_retains_real_roo_history_and_kilo_continuations_in_either_order() {
    for kilo_first in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let task = roo_task(&temp.path().join("roo"));
        let (path, db) = source_db(temp.path(), "kilo.db", "kilo/v7-database/pinned-roo-import.sql");
        assert!(
            read_opencode_database(ToolId::Kilo, &path, &[])
                .unwrap()
                .events
                .is_empty()
        );
        native_kilo(&db);
        let store_path = temp.path().join("usage.sqlite");
        let collector = Collector::open(&store_path);
        if kilo_first {
            collector.configure(ToolId::Kilo, &path, true);
        } else {
            collector.configure(ToolId::Roo, &task, true);
        }
        collector.scan();
        collector.configure(ToolId::Kilo, &path, true);
        collector.configure(ToolId::Roo, &task, true);
        collector.scan();
        collector.assert_local_totals(2, 1775, 3321);
        collector.assert_public_tokens(1700);
        let events = collector.events();
        assert_eq!(events.iter().filter(|e| e.tool == ToolId::Roo).count(), 1);
        assert_eq!(events.iter().filter(|e| e.tool == ToolId::Kilo).count(), 1);
        collector.configure(ToolId::Roo, &task, false);
        fs::remove_dir_all(&task).unwrap();
        collector.configure(ToolId::Kilo, &path, false);
        drop(collector);
        let collector = Collector::open(&store_path);
        collector.scan();
        collector.assert_local_totals(2, 1775, 3321);
        collector.assert_public_tokens(1700);
        collector.configure(ToolId::Kilo, &path, true);
        collector.scan();
        collector.assert_local_totals(2, 1775, 3321);
        collector.assert_public_tokens(1700);
    }
}

#[test]
fn kilo_keeps_legacy_history_with_zero_imports_locked_databases_and_independent_equal_requests() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("kilo");
    fs::create_dir(&root).unwrap();
    let task = roo_task(&root.join("tasks"));
    let collector = Collector::open(&temp.path().join("usage.sqlite"));
    collector.configure(ToolId::Kilo, &root, true);
    collector.scan();
    collector.assert_local_totals(1, 1700, 3100);
    let (_path, db) = source_db(&root, "kilo.db", "kilo/v7-database/pinned-roo-import.sql");
    native_kilo(&db);
    // A second genuinely different request can share every usage field and timestamp.
    db.execute("INSERT INTO message SELECT 'msg_independent','ses_independent',time_created,data FROM message WHERE id='msg_new'",[]).unwrap();
    collector.scan();
    collector.assert_local_totals(3, 1850, 3542);
    collector.assert_public_tokens(1700);
    // The old blanket supersession removed this ledger. Existing files are re-imported without resetting publication.
    let task_file = fs::canonicalize(task.join("ui_messages.json")).unwrap();
    collector
        .store
        .lock()
        .unwrap()
        .forget_file(task_file.to_str().unwrap(), ToolId::Kilo)
        .unwrap();
    collector.assert_local_totals(2, 150, 442);
    collector.assert_public_tokens(0);
    collector.scan();
    collector.assert_local_totals(3, 1850, 3542);
    collector.assert_public_tokens(1700);
    db.execute("UPDATE message SET time_created=time_created+1", [])
        .unwrap();
    db.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE message SET time_created=time_created")
        .unwrap();
    let scan = collector.service.scan().unwrap();
    assert!(scan.diagnostics.contains(&"file_read_failed".to_string()));
    collector.assert_local_totals(3, 1850, 3542);
    collector.assert_public_tokens(1700);
    db.execute_batch("COMMIT; PRAGMA locking_mode=NORMAL;").unwrap();
    drop(db);
    collector.scan();
    collector.assert_local_totals(3, 1850, 3542);
    collector.assert_public_tokens(1700);
    fs::remove_dir_all(task).unwrap();
    collector.scan();
    collector.assert_local_totals(3, 1850, 3542);
    collector.assert_public_tokens(1700);
}

#[test]
fn a_zero_import_correction_withdraws_previously_counted_usage_without_erasing_roo() {
    let temp = tempfile::tempdir().unwrap();
    let task = roo_task(&temp.path().join("roo"));
    let (path, db) = source_db(temp.path(), "kilo.db", "kilo/v7-database/pinned-roo-import.sql");
    db.execute(
        "UPDATE message SET data=json_set(data,'$.tokens.input',100) WHERE json_extract(data,'$.role')='assistant'",
        [],
    )
    .unwrap();
    let collector = Collector::open(&temp.path().join("usage.sqlite"));
    collector.configure(ToolId::Roo, &task, true);
    collector.configure(ToolId::Kilo, &path, true);
    collector.scan();
    collector.assert_local_totals(2, 1800, 3300);
    let options = PublicationOptions {
        share_tools: true,
        share_cost: true,
        ..Default::default()
    };
    let before = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("synthetic", &options)
        .unwrap();
    collector
        .store
        .lock()
        .unwrap()
        .acknowledge_publication("synthetic", &before.receipt)
        .unwrap();
    db.execute(
        "UPDATE message SET data=json_set(data,'$.tokens.input',0) WHERE json_extract(data,'$.role')='assistant'",
        [],
    )
    .unwrap();
    collector.scan();
    collector.assert_local_totals(1, 1700, 3100);
    let after = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("synthetic", &options)
        .unwrap();
    assert_eq!(after.buckets.iter().map(|b| b.tokens).sum::<u64>(), 1700);
    // The deliberately corrupted synthetic import remains local-only even before its zero correction.
    assert_eq!(before.buckets, after.buckets);
    assert_eq!(before.buckets.iter().map(|b| b.tokens).sum::<u64>(), 1700);
}

#[test]
fn v2_flat_file_overlap_and_late_physical_replays_cannot_undo_corrections() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("authorized");
    fs::create_dir(&root).unwrap();
    let (_path, db) = source_db(
        &root,
        "opencode.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    let data: String = db
        .query_row("SELECT data FROM session_message WHERE id='msg_original'", [], |row| {
            row.get(0)
        })
        .unwrap();
    let original: Value = serde_json::from_str(&data).unwrap();
    let flat = json!({"id":"msg_original","sessionID":"ses_root","role":"assistant","modelID":"synthetic-model",
        "path":{"cwd":"/synthetic/project"},"tokens":original["tokens"],"time":original["time"],"content":"PRIVATE_RESPONSE_MARKER"});
    let folder = root.join("storage/message/ses_root");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("msg_original.json"), flat.to_string()).unwrap();
    let store_path = temp.path().join("usage.sqlite");
    let collector = Collector::open(&store_path);
    collector.configure(ToolId::OpenCode, &root, true);
    collector.scan();
    collector.assert_totals(6, 339, 785);
    correction(&db, "msg_original", "$.tokens.input", json!(80));
    collector.scan();
    collector.assert_totals(6, 319, 745);
    drop(collector);
    // Same original request in a newly discovered file (explicit JSON id wins over its filename).
    fs::write(folder.join("msg_replayed.json"), flat.to_string()).unwrap();
    let collector = Collector::open(&store_path);
    collector.scan();
    collector.assert_totals(6, 319, 745);
    let public = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("synthetic", &PublicationOptions::default())
        .unwrap();
    let payload = serde_json::to_string(&public).unwrap();
    for private in [
        "ses_root",
        "msg_original",
        "PRIVATE_",
        "usage_origins",
        "synthetic/project",
    ] {
        assert!(!payload.contains(private));
    }
    drop(collector);
    for file in [store_path, temp.path().join("usage.sqlite-wal")] {
        if let Ok(bytes) = fs::read(file) {
            assert!(!bytes.windows(8).any(|w| w == b"PRIVATE_"));
        }
    }
}

#[test]
fn missing_unobserved_ancestry_is_diagnosed_and_counters_are_never_used_to_invent_identity() {
    let temp = tempfile::tempdir().unwrap();
    let (path, db) = source_db(
        temp.path(),
        "opencode.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    // Purging the intermediate parent before collection erases its link to the grandparent.
    db.execute("DELETE FROM session_v2 WHERE id='ses_before'", []).unwrap();
    db.execute("DELETE FROM session_message WHERE session_id='ses_before'", [])
        .unwrap();
    let read = read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap();
    assert_eq!(read.diagnostics, ["fork_lineage_unavailable"]);
    // This is a provisional upper bound, explicitly unresolved; matching counters cannot prove the missing link.
    assert_eq!(totals(&read.events), (455, 1051));
    assert_eq!(read.events.len(), 7);
}

#[test]
fn missing_parent_message_blocks_frozen_publication_until_restored_even_when_session_survives() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("authorized");
    fs::create_dir(&root).unwrap();
    let (path, db) = source_db(
        &root,
        "opencode.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    db.execute_batch("CREATE TEMP TABLE saved_messages AS SELECT * FROM session_message WHERE session_id='ses_before'; DELETE FROM session_message WHERE session_id='ses_before';").unwrap();
    let read = read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap();
    assert_eq!(read.diagnostics, ["fork_lineage_unavailable"]);
    let store_path = temp.path().join("usage.sqlite");
    let collector = Collector::open(&store_path);
    let options = PublicationOptions::default();
    let frozen = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("synthetic", &options)
        .unwrap();
    collector.configure(ToolId::OpenCode, &root, true);
    let scan = collector.service.scan().unwrap();
    assert_eq!(scan.diagnostics, ["fork_lineage_unavailable"]);
    assert!(scan.status.sources.iter().any(|s| s.message.contains("provisional")));
    assert!(
        collector
            .store
            .lock()
            .unwrap()
            .pending_publication("synthetic", &options)
            .is_err()
    );
    collector.configure(ToolId::OpenCode, &root, false);
    drop(collector);
    let collector = Collector::open(&store_path);
    assert!(
        collector
            .store
            .lock()
            .unwrap()
            .pending_publication("synthetic", &options)
            .is_err()
    );
    collector.configure(ToolId::OpenCode, &root, true);
    db.execute_batch("INSERT INTO session_message SELECT * FROM saved_messages;")
        .unwrap();
    collector.scan();
    let mut store = collector.store.lock().unwrap();
    assert_eq!(store.pending_publication("synthetic", &options).unwrap(), frozen);
    store.acknowledge_publication("synthetic", &frozen.receipt).unwrap();
    let corrected = store.pending_publication("synthetic", &options).unwrap();
    assert_eq!(corrected.buckets.iter().map(|b| b.tokens).sum::<u64>(), 339);
    assert_eq!(corrected.base_receipt, Some(frozen.receipt));
    assert_eq!(
        store
            .source_statuses()
            .unwrap()
            .iter()
            .find(|s| s.id == ToolId::OpenCode)
            .unwrap()
            .event_count,
        6
    );
}

#[test]
fn v2_missing_copy_metadata_never_becomes_verified_or_erases_persisted_edges() {
    for damage in [
        "DROP TABLE session_v2",
        "ALTER TABLE session_v2 DROP COLUMN fork_session_id",
        "DELETE FROM session_v2 WHERE id='ses_before'",
        "UPDATE session_v2 SET fork_session_id=NULL WHERE id='ses_before'",
        "ALTER TABLE session_message DROP COLUMN seq",
        "ALTER TABLE session_message DROP COLUMN type",
        "UPDATE session_message SET seq=99 WHERE id='msg_forkb_2'",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let (path, db) = source_db(
            temp.path(),
            "opencode.db",
            "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
        );
        let collector = Collector::open(&temp.path().join("usage.sqlite"));
        collector.configure(ToolId::OpenCode, &path, true);
        collector.scan();
        db.execute_batch(damage).unwrap();
        let read = read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap();
        assert!(
            read.diagnostics.contains(&"fork_lineage_unavailable".into()),
            "{damage}"
        );
        let scan = collector.service.scan().unwrap();
        assert!(
            scan.diagnostics.contains(&"fork_lineage_unavailable".into()),
            "{damage}"
        );
        assert!(
            collector.store.lock().unwrap().ensure_publication_ready().is_err(),
            "{damage}"
        );
        // The last valid immutable edges survive incomplete later observations.
        collector.assert_local_totals(6, 339, 785);
    }
}

#[test]
fn v2_directory_is_optional_for_provenance_and_cycles_are_never_verified() {
    let temp = tempfile::tempdir().unwrap();
    let (path, db) = source_db(
        temp.path(),
        "opencode.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    db.execute_batch("ALTER TABLE session_v2 DROP COLUMN directory")
        .unwrap();
    let read = read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap();
    assert!(read.diagnostics.is_empty());
    assert_eq!(totals(&read.events), (339, 785));
    db.execute(
        "UPDATE session_v2 SET fork_session_id='ses_nested' WHERE id='ses_before'",
        [],
    )
    .unwrap();
    assert_eq!(
        read_opencode_database(ToolId::OpenCode, &path, &[])
            .unwrap()
            .diagnostics,
        ["fork_lineage_unavailable"]
    );
}

#[test]
fn restoration_in_another_store_retries_unchanged_provisional_checkpoints() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("authorized");
    fs::create_dir(&root).unwrap();
    let (_path, db) = source_db(
        &root,
        "a.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    db.execute_batch("DELETE FROM session_message WHERE session_id='ses_before'")
        .unwrap();
    let collector = Collector::open(&temp.path().join("usage.sqlite"));
    collector.configure(ToolId::OpenCode, &root, true);
    assert_eq!(
        collector.service.scan().unwrap().diagnostics,
        ["fork_lineage_unavailable"]
    );
    let (_restored, restored) = source_db(
        &root,
        "b.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    restored
        .execute("DELETE FROM session_message WHERE session_id!='ses_before'", [])
        .unwrap();
    collector.service.scan().unwrap();
    collector.scan();
    collector.store.lock().unwrap().ensure_publication_ready().unwrap();
    collector.assert_totals(6, 339, 785);
}

#[test]
fn conflicting_physical_stores_cannot_rewrite_an_observed_copy_parent() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("authorized");
    fs::create_dir(&root).unwrap();
    let (_path, _db) = source_db(
        &root,
        "a.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    let collector = Collector::open(&temp.path().join("usage.sqlite"));
    collector.configure(ToolId::OpenCode, &root, true);
    collector.scan();
    let (_path, conflicting) = source_db(
        &root,
        "b.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    conflicting
        .execute(
            "UPDATE session_v2 SET fork_session_id='ses_unrelated' WHERE id='ses_before'",
            [],
        )
        .unwrap();
    assert_eq!(
        collector.service.scan().unwrap().diagnostics,
        ["fork_lineage_unavailable"]
    );
    assert!(collector.store.lock().unwrap().ensure_publication_ready().is_err());
    collector.assert_local_totals(6, 339, 785);
    conflicting
        .execute(
            "UPDATE session_v2 SET fork_session_id='ses_root' WHERE id='ses_before'",
            [],
        )
        .unwrap();
    collector.scan();
    collector.store.lock().unwrap().ensure_publication_ready().unwrap();
}

#[test]
fn upgrade_holds_old_false_roots_and_repairs_them_from_restored_copy_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let (path, _db) = source_db(
        temp.path(),
        "opencode.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    let store_path = temp.path().join("usage.sqlite");
    let collector = Collector::open(&store_path);
    collector.configure(ToolId::OpenCode, &path, true);
    collector.scan();
    {
        let mut store = collector.store.lock().unwrap();
        let mut checkpoint = store
            .checkpoint(path.to_str().unwrap(), Some(ToolId::OpenCode))
            .unwrap()
            .unwrap();
        checkpoint.parser_version = 2;
        store.commit_file(&checkpoint, &[], false).unwrap();
    }
    // A v2 checkpoint could mark a copied ID as a root when its session metadata was unavailable.
    Connection::open(&store_path)
        .unwrap()
        .execute("UPDATE usage_origins SET parent=NULL", [])
        .unwrap();
    assert!(collector.store.lock().unwrap().ensure_publication_ready().is_err());
    assert_eq!(
        collector
            .store
            .lock()
            .unwrap()
            .source_statuses()
            .unwrap()
            .iter()
            .find(|s| s.id == ToolId::OpenCode)
            .unwrap()
            .state,
        tokentracky_core::SourceState::Stale
    );
    collector.scan();
    collector.store.lock().unwrap().ensure_publication_ready().unwrap();
    collector.assert_totals(6, 339, 785);
    // Read-only compatibility with the pre-migration schema also fails closed on the old checkpoint.
    {
        let mut store = collector.store.lock().unwrap();
        let mut checkpoint = store
            .checkpoint(path.to_str().unwrap(), Some(ToolId::OpenCode))
            .unwrap()
            .unwrap();
        checkpoint.parser_version = 1;
        store.commit_file(&checkpoint, &[], false).unwrap();
    }
    Connection::open(&store_path)
        .unwrap()
        .execute("DROP TABLE usage_origins", [])
        .unwrap();
    let reader = UsageStore::open_read_only(&store_path).unwrap();
    assert!(reader.ensure_publication_ready().is_err());
    assert!(reader.source_statuses().is_ok());
}

#[test]
fn competing_stores_reusing_a_session_sequence_for_distinct_ids_are_provisional() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("authorized");
    fs::create_dir(&root).unwrap();
    let (_path, _db) = source_db(
        &root,
        "a.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    let collector = Collector::open(&temp.path().join("usage.sqlite"));
    collector.configure(ToolId::OpenCode, &root, true);
    collector.scan();
    let (_path, competing) = source_db(
        &root,
        "b.db",
        "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
    );
    competing
        .execute("UPDATE session_message SET id='msg_distinct' WHERE id='msg_newb'", [])
        .unwrap();
    assert_eq!(
        collector.service.scan().unwrap().diagnostics,
        ["fork_lineage_unavailable"]
    );
    assert!(collector.store.lock().unwrap().ensure_publication_ready().is_err());
}

#[test]
fn ambiguous_kilo_databases_preserve_local_ledger_csv_and_verified_public_histories_across_lifecycle() {
    let temp = tempfile::tempdir().unwrap();
    let kilo = temp.path().join("kilo");
    fs::create_dir(&kilo).unwrap();
    roo_task(&kilo.join("tasks")); // Verified Kilo v5 task format: 1700 tokens.
    let roo = roo_task(&temp.path().join("roo"));
    let (ambiguous, db) = source_db(&kilo, "kilo.db", "kilo/v7-database/pinned-roo-import.sql");
    native_kilo(&db);
    // A fork copy and an independent equal-valued request remain in the local ledger. Neither is publishable.
    db.execute(
        "INSERT INTO message SELECT 'msg_fork','ses_fork',time_created,data FROM message WHERE id='msg_new'",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO message SELECT 'msg_independent','ses_independent',time_created,data FROM message WHERE id='msg_new'", []).unwrap();
    // The boundary covers *all* rows in a physical database containing v1, including its complete v2 table.
    let v2 = fixture_text("opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql");
    db.execute_batch(&v2).unwrap();
    let clean_path = kilo.join("verified.db");
    let clean = Connection::open(&clean_path).unwrap();
    clean.execute_batch(&v2.replace("ses_", "ses_clean_")).unwrap();
    let store_path = temp.path().join("usage.sqlite");
    let collector = Collector::open(&store_path);
    collector.configure(ToolId::Kilo, &kilo, true);
    collector.configure(ToolId::Roo, &roo, true);
    collector.scan();
    collector.assert_local_totals(17, 4303, 8433);
    collector.assert_public_tokens(3739); // Roo + Kilo v5 + separate complete v2, only.
    let options = PublicationOptions::default();
    let initial = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("new-link", &options)
        .unwrap();
    assert_eq!(initial.buckets.iter().map(|b| b.tokens).sum::<u64>(), 3739);
    collector
        .store
        .lock()
        .unwrap()
        .acknowledge_publication("new-link", &initial.receipt)
        .unwrap();
    db.execute("DELETE FROM message", []).unwrap();
    collector.scan();
    collector.assert_local_totals(17, 4303, 8433);
    collector.assert_public_tokens(3739);
    collector.configure(ToolId::Kilo, &kilo, false);
    drop(db);
    fs::remove_file(&ambiguous).unwrap();
    drop(collector);
    let collector = Collector::open(&store_path);
    collector.scan();
    collector.assert_local_totals(17, 4303, 8433);
    collector.assert_public_tokens(3739);
    let message = collector
        .store
        .lock()
        .unwrap()
        .source_statuses()
        .unwrap()
        .into_iter()
        .find(|s| s.id == ToolId::Kilo)
        .unwrap()
        .message;
    assert!(message.contains("local-only") && message.contains("Roo and Kilo v5"));
    collector.configure(ToolId::Kilo, &kilo, true);
    collector.scan();
    collector.assert_public_tokens(3739);
}

#[test]
fn legacy_frozen_receipt_migration_revalidates_absent_rows_and_requires_new_scope_without_mutating_receipt() {
    use tokentracky_collector::store::StoreError;
    for (acknowledged, source_change) in [(false, 0), (false, 1), (false, 2), (true, 0), (true, 1), (true, 2)] {
        let temp = tempfile::tempdir().unwrap();
        let (path, source) = source_db(temp.path(), "kilo.db", "kilo/v7-database/pinned-roo-import.sql");
        native_kilo(&source);
        let store_path = temp.path().join("usage.sqlite");
        let collector = Collector::open(&store_path);
        let events = read_opencode_database(ToolId::Kilo, &path, &[]).unwrap().events;
        // Seed the *old* collector's ledger and frozen content, without the new exclusion provenance.
        let mut checkpoint: tokentracky_collector::store::FileCheckpoint = serde_json::from_value(json!({
            "path":path.to_str().unwrap(), "tool":"kilo", "identity":"old", "offset":0,
            "prefixHash":"0".repeat(64), "parserVersion":4,
            "state":{"sessionId":null,"project":null,"model":"unknown","turnId":null,"previous":null,"baselines":[],"seenDeltaIds":[]}
        })).unwrap();
        let options = PublicationOptions::default();
        let frozen = {
            let mut store = collector.store.lock().unwrap();
            store.commit_file(&checkpoint, &events, false).unwrap();
            let batch = store.pending_publication("old-generation", &options).unwrap();
            assert_eq!(batch.buckets.iter().map(|b| b.tokens).sum::<u64>(), 75);
            if acknowledged {
                store.acknowledge_publication("old-generation", &batch.receipt).unwrap();
            }
            checkpoint.parser_version = 3;
            store.commit_file(&checkpoint, &[], false).unwrap();
            batch
        };
        drop(collector);
        let raw = Connection::open(&store_path).unwrap();
        raw.execute_batch(
            "DROP TABLE publication_exclusions; DROP TABLE local_only_files; DROP TABLE publication_scopes; DROP TABLE publication_generation_reviews",
        )
        .unwrap();
        let legacy: String = raw
            .query_row("SELECT value FROM metadata WHERE key='publication_sync'", [], |r| {
                r.get(0)
            })
            .unwrap();
        // Deleted source rows must still be excluded when the recognized (now empty) v1 table is revalidated.
        if source_change == 1 {
            source.execute("DELETE FROM message", []).unwrap();
        }
        if source_change == 2 {
            source.execute("DROP TABLE message", []).unwrap();
        }
        let collector = Collector::open(&store_path);
        assert!(matches!(
            collector
                .store
                .lock()
                .unwrap()
                .pending_publication("old-generation", &options),
            Err(StoreError::AccountingHistoryIncomplete)
        ));
        collector.configure(ToolId::Kilo, &path, true);
        collector.scan();
        collector.assert_local_totals(1, 75, 221);
        collector.assert_public_tokens(0);
        {
            let mut store = collector.store.lock().unwrap();
            assert!(matches!(
                store.pending_publication("old-generation", &options),
                Err(StoreError::PublicationReviewRequired)
            ));
            assert!(matches!(
                store.acknowledge_publication("old-generation", &frozen.receipt),
                Err(StoreError::PublicationReviewRequired)
            ));
        }
        assert_eq!(
            raw.query_row::<String, _, _>("SELECT value FROM metadata WHERE key='publication_sync'", [], |r| r
                .get(0))
                .unwrap(),
            legacy
        );
        // Replaying the same event from a different eligible physical source cannot erase its exclusion.
        checkpoint.path = "/synthetic/replayed-task.json".into();
        checkpoint.parser_version = 4;
        collector
            .store
            .lock()
            .unwrap()
            .commit_file(&checkpoint, &events, false)
            .unwrap();
        collector
            .store
            .lock()
            .unwrap()
            .forget_file(path.to_str().unwrap(), ToolId::Kilo)
            .unwrap();
        collector.assert_public_tokens(0);
        drop(collector);
        let collector = Collector::open(&store_path);
        let mut store = collector.store.lock().unwrap();
        assert!(matches!(
            store.pending_publication("old-generation", &options),
            Err(StoreError::PublicationReviewRequired)
        ));
        let fresh = store.pending_publication("new-hosted-generation", &options).unwrap();
        assert_eq!(fresh.base_receipt, None);
        assert_eq!(fresh.buckets.iter().map(|b| b.tokens).sum::<u64>(), 0);
        assert_ne!(fresh.receipt, frozen.receipt);
        // The original state remains archived even after publishing in another generation.
        assert_eq!(
            raw.query_row::<String, _, _>(
                "SELECT state FROM publication_scopes WHERE scope='old-generation'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            legacy
        );
    }
}

#[test]
fn unresolved_lineage_in_an_excluded_kilo_database_does_not_hold_verified_roo_publication() {
    let temp = tempfile::tempdir().unwrap();
    let (path, source) = source_db(temp.path(), "kilo.db", "kilo/v7-database/pinned-roo-import.sql");
    source
        .execute_batch(&fixture_text(
            "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
        ))
        .unwrap();
    source
        .execute_batch(
            "DELETE FROM session_v2 WHERE id='ses_before'; DELETE FROM session_message WHERE session_id='ses_before'",
        )
        .unwrap();
    let roo = roo_task(&temp.path().join("roo"));
    let collector = Collector::open(&temp.path().join("usage.sqlite"));
    collector.configure(ToolId::Kilo, &path, true);
    collector.configure(ToolId::Roo, &roo, true);
    let scan = collector.service.scan().unwrap();
    assert!(scan.diagnostics.contains(&"fork_lineage_unavailable".into()));
    collector.assert_local_totals(8, 2155, 4151);
    collector.assert_public_tokens(1700);
    collector
        .store
        .lock()
        .unwrap()
        .pending_publication("initial-link", &PublicationOptions::default())
        .unwrap();
    let clean_path = temp.path().join("verified.db");
    let clean = Connection::open(&clean_path).unwrap();
    clean
        .execute_batch(
            &fixture_text("opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql")
                .replace("ses_", "ses_verified_"),
        )
        .unwrap();
    collector
        .service
        .configure_source(
            ToolId::Kilo,
            &SourceConfiguration {
                enabled: true,
                paths: vec![path.to_str().unwrap().into(), clean_path.to_str().unwrap().into()],
            },
        )
        .unwrap();
    collector.service.scan().unwrap();
    collector.assert_local_totals(14, 2494, 4936);
    collector.assert_public_tokens(2039);
    // Unresolved *eligible* OpenCode ancestry still imposes the existing whole-device hold.
    let broken_path = temp.path().join("opencode.db");
    let broken = Connection::open(&broken_path).unwrap();
    broken
        .execute_batch(&fixture_text(
            "opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql",
        ))
        .unwrap();
    broken
        .execute_batch("DELETE FROM session_message WHERE session_id='ses_before'")
        .unwrap();
    collector.configure(ToolId::OpenCode, &broken_path, true);
    collector.service.scan().unwrap();
    assert!(
        collector
            .store
            .lock()
            .unwrap()
            .pending_publication("initial-link", &PublicationOptions::default())
            .is_err()
    );
}

#[test]
fn checkpoint_exclusions_and_receipt_hold_roll_back_together_on_failed_commit() {
    let temp = tempfile::tempdir().unwrap();
    let (path, source) = source_db(temp.path(), "kilo.db", "kilo/v7-database/pinned-roo-import.sql");
    native_kilo(&source);
    let store_path = temp.path().join("usage.sqlite");
    let collector = Collector::open(&store_path);
    collector.configure(ToolId::Kilo, &path, true);
    collector.scan();
    let raw = Connection::open(&store_path).unwrap();
    // Reconstruct the old app's stored checkpoint and receipt in this synthetic database.
    raw.execute_batch("DELETE FROM publication_exclusions; DELETE FROM local_only_files")
        .unwrap();
    let frozen = {
        let mut store = collector.store.lock().unwrap();
        let mut checkpoint = store
            .checkpoint(path.to_str().unwrap(), Some(ToolId::Kilo))
            .unwrap()
            .unwrap();
        checkpoint.diagnostics.clear();
        store.commit_file(&checkpoint, &[], false).unwrap();
        let frozen = store
            .pending_publication("old", &PublicationOptions::default())
            .unwrap();
        checkpoint.parser_version = 3;
        store.commit_file(&checkpoint, &[], false).unwrap();
        frozen
    };
    raw.execute_batch("CREATE TRIGGER fail_exclusion BEFORE INSERT ON publication_exclusions BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END").unwrap();
    assert!(
        collector
            .service
            .scan()
            .unwrap()
            .diagnostics
            .contains(&"file_read_failed".into())
    );
    let store = collector.store.lock().unwrap();
    assert_eq!(
        store
            .checkpoint(path.to_str().unwrap(), Some(ToolId::Kilo))
            .unwrap()
            .unwrap()
            .parser_version,
        3
    );
    assert!(store.ensure_publication_scope_ready("old").is_err());
    drop(store);
    assert_eq!(
        raw.query_row::<i64, _, _>("SELECT COUNT(*) FROM publication_exclusions", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        raw.query_row::<i64, _, _>("SELECT COUNT(*) FROM local_only_files", [], |r| r.get(0))
            .unwrap(),
        0
    );
    let saved: String = raw
        .query_row("SELECT state FROM publication_scopes WHERE scope='old'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap()["pending"],
        serde_json::to_value(&frozen).unwrap()
    );
    raw.execute_batch("DROP TRIGGER fail_exclusion").unwrap();
    collector.scan();
    assert_eq!(
        collector
            .store
            .lock()
            .unwrap()
            .pending_publication("old", &PublicationOptions::default())
            .unwrap_err()
            .to_string(),
        "publication_review_required"
    );
    assert_eq!(
        raw.query_row::<String, _, _>("SELECT state FROM publication_scopes WHERE scope='old'", [], |r| r
            .get(0))
            .unwrap(),
        saved
    );
}

#[test]
fn recognizing_an_empty_vone_database_also_holds_preexisting_receipts() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("kilo.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)")
        .unwrap();
    let collector = Collector::open(&temp.path().join("usage.sqlite"));
    let frozen = collector
        .store
        .lock()
        .unwrap()
        .pending_publication("old", &Default::default())
        .unwrap();
    collector.configure(ToolId::Kilo, &path, true);
    collector.scan();
    assert_eq!(
        collector
            .store
            .lock()
            .unwrap()
            .pending_publication("old", &Default::default())
            .unwrap_err()
            .to_string(),
        "publication_review_required"
    );
    assert_eq!(
        collector
            .store
            .lock()
            .unwrap()
            .acknowledge_publication("old", &frozen.receipt)
            .unwrap_err()
            .to_string(),
        "publication_review_required"
    );
    assert!(
        collector
            .store
            .lock()
            .unwrap()
            .pending_publication("new-generation", &Default::default())
            .unwrap()
            .buckets
            .is_empty()
    );
}

#[test]
fn exclusion_between_generation_check_and_scope_creation_cannot_escape_the_generation_hold() {
    for bind_original in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let (path, source) = source_db(temp.path(), "kilo.db", "kilo/v7-database/pinned-roo-import.sql");
        native_kilo(&source);
        let store_path = temp.path().join("usage.sqlite");
        let collector = Collector::open(&store_path);
        let options = PublicationOptions::default();
        let original = {
            let mut store = collector.store.lock().unwrap();
            let original = store.pending_publication("original-token", &options).unwrap();
            if bind_original {
                store
                    .bind_publication_generation("original-token", "old-generation")
                    .unwrap();
            }
            // The uploader has checked the generation, but has not registered the rotated token's scope.
            store.ensure_publication_generation_ready("old-generation").unwrap();
            original
        };
        collector.configure(ToolId::Kilo, &path, true);
        collector.scan();
        let mut store = collector.store.lock().unwrap();
        // Reproduce the former upload interleaving: a scan acquired the store lock between the generation
        // check and freezing/binding this new scope. Scope checks must include its generation before HTTP/ACK.
        let raced = store.pending_publication("rotated-token", &options).unwrap();
        store
            .bind_publication_generation("rotated-token", "old-generation")
            .unwrap();
        assert_eq!(
            store
                .ensure_publication_scope_ready("rotated-token")
                .unwrap_err()
                .to_string(),
            "publication_review_required"
        );
        assert_eq!(
            store
                .acknowledge_publication("rotated-token", &raced.receipt)
                .unwrap_err()
                .to_string(),
            "publication_review_required"
        );
        drop(store);
        drop(collector);
        let collector = Collector::open(&store_path);
        let mut store = collector.store.lock().unwrap();
        assert!(store.pending_publication("rotated-token", &options).is_err());
        // Both known and unbound legacy scopes recover through an observed hosted generation reset.
        store
            .observe_publication_generation_change("old-generation", "new-generation")
            .unwrap();
        store.ensure_publication_generation_ready("new-generation").unwrap();
        let fresh = store.pending_publication("reviewed-token", &options).unwrap();
        store
            .bind_publication_generation("reviewed-token", "new-generation")
            .unwrap();
        store.acknowledge_publication("reviewed-token", &fresh.receipt).unwrap();
        assert_eq!(fresh.base_receipt, None);
        assert!(fresh.buckets.iter().all(|b| b.tokens == 0));
        assert_ne!(fresh.receipt, original.receipt);
        assert!(store.pending_publication("original-token", &options).is_err());
        assert!(store.pending_publication("rotated-token", &options).is_err());
        let raw = Connection::open(&store_path).unwrap();
        for (scope, receipt) in [("original-token", original.receipt), ("rotated-token", raced.receipt)] {
            let state: String = raw
                .query_row("SELECT state FROM publication_scopes WHERE scope=?", [scope], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&state).unwrap()["pending"]["receipt"],
                receipt
            );
        }
        drop(store);
        collector.assert_local_totals(1, 75, 221);
    }
}
