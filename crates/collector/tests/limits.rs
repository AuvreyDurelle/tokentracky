//! Usage limits through a scan (F6): each Codex rollout's latest rate-limit snapshot reaches the local limits table,
//! the latest of every rollout wins, and token totals do not move; Claude Code's own cached reading in a synthetic
//! `.claude.json` is kept only for the account signed in, and nothing else of that file is stored.
mod support;

use rusqlite::Connection;
use ruzstd::encoding::{CompressionLevel, compress_to_vec};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use support::fixture_text;
use tokentracky_collector::limits::{LimitReading, LimitWindow, claude_config_file};
use tokentracky_collector::store::{QueryOptions, SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService};
use tokentracky_core::{ToolId, total_tokens};

/// 2026-10-20T10:04:00Z, the time of the last snapshot in `fixtures/codex/rate-limits`.
const AT_10_04: i64 = 1_792_490_640_000;
/// Its windows reset at 14:00 that day and at midnight on the 26th.
const FIVE_HOURS: i64 = 1_792_504_800_000;
const WEEK: i64 = 1_792_972_800_000;

fn window(name: &str, used_percent: f64, window_minutes: u64, resets_at_ms: i64) -> LimitWindow {
    LimitWindow {
        name: name.to_owned(),
        used_percent,
        window_minutes: Some(window_minutes),
        resets_at_ms: Some(resets_at_ms),
    }
}
fn codex(as_of_ms: i64, primary: f64, secondary: f64) -> LimitReading {
    LimitReading {
        tool: ToolId::Codex,
        as_of_ms,
        windows: vec![
            window("primary", primary, 300, FIVE_HOURS),
            window("secondary", secondary, 10_080, WEEK),
        ],
    }
}
/// A rate-limit notification (null info) at `time`.
fn notification(time: &str, primary: f64, secondary: f64) -> String {
    format!(
        r#"{{"timestamp":"{time}","type":"event_msg","payload":{{"type":"token_count","info":null,"rate_limits":{{"limit_id":"codex","primary":{{"used_percent":{primary},"window_minutes":300,"resets_at":1792504800}},"secondary":{{"used_percent":{secondary},"window_minutes":10080,"resets_at":1792972800}}}}}}}}"#
    )
}

/// A synthetic home: a Codex home authorized as one folder (`codex/`), Claude Code's projects folder and its
/// `.claude.json`, which the scan reads while Claude Code is enabled, with the store beside them.
struct Home {
    _temporary: tempfile::TempDir,
    directory: PathBuf,
    root: PathBuf,
    store: Arc<Mutex<UsageStore>>,
    service: IngestionService,
}
impl Home {
    fn new() -> Self {
        let temporary = tempfile::Builder::new().prefix("synthetic-").tempdir().unwrap();
        let directory = fs::canonicalize(temporary.path()).unwrap();
        let root = directory.join("codex");
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::create_dir_all(directory.join(".claude").join("projects")).unwrap();
        let store = Arc::new(Mutex::new(UsageStore::open(directory.join("usage.sqlite")).unwrap()));
        let options = IngestionOptions {
            claude_config_file: Some(claude_config_file(|_| None, &directory)),
            ..IngestionOptions::default()
        };
        let service = IngestionService::new(store.clone(), options).unwrap();
        let home = Self {
            _temporary: temporary,
            directory,
            root,
            store,
            service,
        };
        home.enable(ToolId::Codex, true);
        home
    }
    fn enable(&self, tool: ToolId, enabled: bool) {
        let folder = match tool {
            ToolId::Claude => self.directory.join(".claude").join("projects"),
            _ => self.root.clone(),
        };
        let paths = vec![folder.to_string_lossy().into_owned()];
        self.service
            .configure_source(tool, &SourceConfiguration { enabled, paths })
            .unwrap();
    }
    fn write(&self, relative: &str, content: impl AsRef<[u8]>) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }
    fn write_claude_config(&self, config: &Value) {
        fs::write(self.directory.join(".claude.json"), config.to_string()).unwrap();
    }
    /// One scan's stored limit readings.
    fn limits(&self) -> Vec<LimitReading> {
        self.scan().1
    }
    /// Closes the store, which folds its write-ahead log back in: the database's bytes.
    fn close(self) -> Vec<u8> {
        let Self {
            store,
            service,
            directory,
            ..
        } = self;
        drop(service);
        let store = Arc::try_unwrap(store).unwrap_or_else(|_| panic!("one owner"));
        store.into_inner().unwrap().close().unwrap();
        assert!(!directory.join("usage.sqlite-wal").exists());
        fs::read(directory.join("usage.sqlite")).unwrap()
    }
    /// One scan: every event's tokens and the stored limit readings.
    fn scan(&self) -> (u64, Vec<LimitReading>) {
        let diagnostics = self.service.scan().unwrap().diagnostics;
        assert_eq!(diagnostics, Vec::<String>::new());
        let store = self.store.lock().unwrap();
        let events = store.events(&QueryOptions::default()).unwrap();
        (
            events.iter().map(|event| total_tokens(&event.tokens)).sum(),
            store.limits().unwrap(),
        )
    }
}
fn append(path: &Path, line: &str) {
    let mut content = fs::read_to_string(path).unwrap();
    content.push_str(line);
    content.push('\n');
    fs::write(path, content).unwrap();
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

#[test]
fn a_scan_keeps_the_plans_latest_codex_snapshot_and_no_other_part_of_it() {
    let home = Home::new();
    home.write(
        "sessions/rollout.jsonl",
        fixture_text("codex/rate-limits/root/rollout.jsonl"),
    );
    // The token total is the fixture's hand-written one; the snapshot is the last one of the plan's own limit.
    assert_eq!(home.scan(), (330, vec![codex(AT_10_04, 20.0, 3.5)]));
    let bytes = home.close();
    for private in ["PRIVATE_", "codex_other"] {
        assert!(!contains(&bytes, private), "{private}");
    }
}

#[test]
fn a_grown_rollout_updates_the_reading_and_an_older_snapshot_never_replaces_it() {
    let home = Home::new();
    let live = home.write(
        "sessions/rollout.jsonl",
        fixture_text("codex/rate-limits/root/rollout.jsonl"),
    );
    home.scan();
    // Read on from the checkpoint: the snapshot saved in the parser state is still the rollout's latest.
    append(&live, &notification("2026-10-20T10:06:00.000Z", 31.0, 4.0));
    assert_eq!(home.scan(), (330, vec![codex(AT_10_04 + 120_000, 31.0, 4.0)]));
    // An appended record with no snapshot leaves it.
    append(
        &live,
        r#"{"timestamp":"2026-10-20T10:07:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#,
    );
    assert_eq!(home.scan().1, [codex(AT_10_04 + 120_000, 31.0, 4.0)]);
    // Another rollout, or an archive, read later but written earlier, is not the latest.
    let older = format!(
        "{}\n{}\n",
        r#"{"timestamp":"2026-10-20T09:00:00.000Z","type":"session_meta","payload":{"id":"older"}}"#,
        notification("2026-10-20T09:01:00.000Z", 77.0, 7.0)
    );
    home.write("sessions/rollout-older.jsonl", &older);
    home.write(
        "archived_sessions/rollout-2026-10-19T09-00-00-old.jsonl.zst",
        compress_to_vec(older.replace("older", "archived").as_bytes(), CompressionLevel::Fastest),
    );
    assert_eq!(home.scan(), (330, vec![codex(AT_10_04 + 120_000, 31.0, 4.0)]));
    // A later archive is.
    let later = format!(
        "{}\n{}\n",
        r#"{"timestamp":"2026-10-20T11:00:00.000Z","type":"session_meta","payload":{"id":"later"}}"#,
        notification("2026-10-20T11:00:00.000Z", 50.0, 9.0)
    );
    home.write(
        "archived_sessions/rollout-2026-10-20T11-00-00-later.jsonl.zst",
        compress_to_vec(later.as_bytes(), CompressionLevel::Fastest),
    );
    assert_eq!(home.scan().1, [codex(1_792_494_000_000, 50.0, 9.0)]);
}

/// 2026-10-25T12:00:00Z, when Claude Code fetched the synthetic reading.
const FETCHED: i64 = 1_792_929_600_000;
const ACCOUNT: &str = "PRIVATE_ACCOUNT_UUID_0000-1111";

/// A synthetic `.claude.json`: the reading cached for `cached`, signed in to `current`, among settings, history and
/// sign-in details that are all marked `PRIVATE_` and must never be kept.
fn claude_config(cached: Option<&str>, current: Option<&str>) -> Value {
    json!({
        "numStartups": 42,
        "userID": "PRIVATE_USER_ID",
        "primaryApiKey": "PRIVATE_API_KEY",
        "oauthAccount": {"accountUuid": current, "emailAddress": "PRIVATE_EMAIL@example.com",
            "organizationUuid": "PRIVATE_ORGANIZATION", "organizationName": "PRIVATE_ORGANIZATION_NAME"},
        "projects": {"/Users/PRIVATE_USER/code": {"history": [{"display": "PRIVATE_PROMPT"}], "allowedTools": ["PRIVATE_TOOL"]}},
        "tipsHistory": {"PRIVATE_TIP": 3},
        "cachedUsageUtilization": {
            "fetchedAtMs": FETCHED,
            "accountUuid": cached,
            "utilization": {
                "five_hour": {"utilization": 42.5, "resets_at": "2026-10-25T15:00:00.123456+00:00", "label": "PRIVATE_LABEL"},
                "seven_day": {"utilization": 12, "resets_at": "2026-10-30T09:00:00Z"},
                "seven_day_opus": null,
                "seven_day_sonnet": {"utilization": 99, "resets_at": "2026-10-30T09:00:00Z"},
                "limits": [{"kind": "weekly_scoped", "percent": 7, "scope": {"model": {"display_name": "PRIVATE_MODEL"}}}],
                "extra_usage": {"is_enabled": true, "monthly_limit": "PRIVATE_SPEND"},
            },
        },
    })
}
fn claude(windows: Vec<LimitWindow>) -> LimitReading {
    LimitReading {
        tool: ToolId::Claude,
        as_of_ms: FETCHED,
        windows,
    }
}
fn shown() -> LimitReading {
    claude(vec![
        window("five_hour", 42.5, 300, 1_792_940_400_123),
        window("seven_day", 12.0, 10_080, 1_793_350_800_000),
    ])
}

#[test]
fn takes_claude_codes_reading_only_while_it_is_enabled_and_only_for_the_account_signed_in() {
    let home = Home::new();
    home.write_claude_config(&claude_config(Some(ACCOUNT), Some(ACCOUNT)));
    // Claude Code is off: its file is not read.
    assert_eq!(home.limits(), []);
    home.enable(ToolId::Claude, true);
    assert_eq!(home.limits(), [shown()]);
    // Signed in to another account, signed out, or a reading with no account: no reading.
    for (cached, current) in [
        (Some(ACCOUNT), Some("PRIVATE_OTHER_ACCOUNT")),
        (Some(ACCOUNT), None),
        (None, Some(ACCOUNT)),
        (Some(""), Some("")),
    ] {
        home.write_claude_config(&claude_config(Some(ACCOUNT), Some(ACCOUNT)));
        assert_eq!(home.limits(), [shown()]);
        home.write_claude_config(&claude_config(cached, current));
        assert_eq!(home.limits(), [], "{cached:?} {current:?}");
    }
    // No file, a file that does not parse, or one without a reading: none either.
    let file = home.directory.join(".claude.json");
    for content in [
        None,
        Some("{\"oauthAccount\": "),
        Some("{\"oauthAccount\": \"PRIVATE_\"}"),
        Some("{}"),
        Some("[]"),
    ] {
        home.write_claude_config(&claude_config(Some(ACCOUNT), Some(ACCOUNT)));
        assert_eq!(home.limits(), [shown()]);
        match content {
            None => fs::remove_file(&file).unwrap(),
            Some(content) => fs::write(&file, content).unwrap(),
        }
        assert_eq!(home.limits(), [], "{content:?}");
    }
    // Turned off, the last reading stays as it was, as its usage does.
    home.write_claude_config(&claude_config(Some(ACCOUNT), Some(ACCOUNT)));
    assert_eq!(home.limits(), [shown()]);
    home.enable(ToolId::Claude, false);
    home.write_claude_config(&claude_config(Some(ACCOUNT), Some("PRIVATE_OTHER_ACCOUNT")));
    assert_eq!(home.limits(), [shown()]);
}

#[test]
fn keeps_each_window_whatever_its_reset_and_bounds_its_figures() {
    let home = Home::new();
    home.enable(ToolId::Claude, true);
    let mut config = claude_config(Some(ACCOUNT), Some(ACCOUNT));
    let utilization = &mut config["cachedUsageUtilization"]["utilization"];
    // A reset long passed is still the reading; the Limits page reports it as reset.
    utilization["five_hour"] = json!({"utilization": 100.5, "resets_at": "2026-01-01T00:00:00.000Z"});
    // An unstarted window has no reset yet.
    utilization["seven_day"] = json!({"utilization": 0, "resets_at": null});
    utilization["seven_day_opus"] = json!({"utilization": 3.25, "resets_at": "next week"});
    home.write_claude_config(&config);
    assert_eq!(
        home.limits(),
        [claude(vec![
            window("five_hour", 100.0, 300, 1_767_225_600_000),
            LimitWindow {
                resets_at_ms: None,
                ..window("seven_day", 0.0, 10_080, 0)
            },
            LimitWindow {
                resets_at_ms: None,
                ..window("seven_day_opus", 3.25, 10_080, 0)
            },
        ])]
    );
    // A window with no usable figure is left out; with none left, there is no reading.
    let utilization = &mut config["cachedUsageUtilization"]["utilization"];
    utilization["five_hour"] = json!({"utilization": -1});
    utilization["seven_day"] = json!({"utilization": "12"});
    utilization["seven_day_opus"] = json!({"resets_at": "2026-10-30T09:00:00Z"});
    home.write_claude_config(&config);
    assert_eq!(home.limits(), []);
    for fetched in [json!(0), json!("1792929600000"), Value::Null, json!(8.7e15)] {
        let mut config = claude_config(Some(ACCOUNT), Some(ACCOUNT));
        config["cachedUsageUtilization"]["fetchedAtMs"] = fetched.clone();
        home.write_claude_config(&config);
        assert_eq!(home.limits(), [], "{fetched}");
    }
}

#[test]
fn stores_nothing_from_claude_json_but_the_window_figures() {
    let home = Home::new();
    home.enable(ToolId::Claude, true);
    home.write_claude_config(&claude_config(Some(ACCOUNT), Some(ACCOUNT)));
    assert_eq!(home.limits(), [shown()]);
    let database = home.directory.join("usage.sqlite");
    let rows: Vec<Vec<Value>> = {
        let db = Connection::open(&database).unwrap();
        let mut statement = db.prepare("SELECT * FROM usage_limits ORDER BY name").unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|at| match row.get_ref(at).unwrap() {
                        rusqlite::types::ValueRef::Integer(n) => json!(n),
                        rusqlite::types::ValueRef::Real(n) => json!(n),
                        rusqlite::types::ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
                        other => panic!("{other:?}"),
                    })
                    .collect())
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(
        rows,
        [
            vec![
                json!("claude"),
                json!("five_hour"),
                json!(42.5),
                json!(300),
                json!(1_792_940_400_123_i64),
                json!(FETCHED)
            ],
            vec![
                json!("claude"),
                json!("seven_day"),
                json!(12.0),
                json!(10_080),
                json!(1_793_350_800_000_i64),
                json!(FETCHED)
            ],
        ]
    );
    let bytes = home.close();
    for private in [
        "PRIVATE_",
        "example.com",
        "weekly_scoped",
        "seven_day_sonnet",
        "numStartups",
    ] {
        assert!(!contains(&bytes, private), "{private}");
    }
}

#[test]
fn finds_claude_json_where_claude_code_keeps_it() {
    let home = Path::new("/Users/ada");
    assert_eq!(claude_config_file(|_| None, home), Path::new("/Users/ada/.claude.json"));
    let env = |value: &'static str| move |key: &str| (key == "CLAUDE_CONFIG_DIR").then(|| value.to_owned());
    assert_eq!(
        claude_config_file(env("/cfg/claude/"), home),
        Path::new("/cfg/claude/.claude.json")
    );
    assert_eq!(claude_config_file(env(""), home), Path::new("/Users/ada/.claude.json"));
}
