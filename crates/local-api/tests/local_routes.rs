//! The collector-backed routes, after `tests/contract/{health,sources,refresh,collection,queries,export}.test.ts`:
//! the status composition, detection, the first run, source authorisation, refresh, the pause and refresh
//! interaction, the usage queries and their filters, and the CSV export; then the Rust-only local days (`tz` and
//! `GET /api/local/day`), the weekly rank of the cycle, the cached overview (Rust only) and the TCP transport.
mod support;

use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::*;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokentracky_collector::detect::{default_source_paths, detect_tools};
use tokentracky_collector::readers::is_supported;
use tokentracky_core::{TOOL_IDS, ToolId, UsageEvent};
use tokentracky_local_api::{
    BoxFuture, CloudLink, LocalApp, LocalOverview, SecretError, SecretStore, UsageStore, serve_tcp,
};

const STATUS_KEYS: [&str; 11] = [
    "alias",
    "cloudLinked",
    "collecting",
    "lastRefreshAt",
    "lastScanAt",
    "lastSyncAt",
    "nextRefreshAt",
    "pricingVersion",
    "refreshing",
    "sources",
    "syncError",
];
/// Every tool id, in the store's order (by id).
fn tools() -> Vec<String> {
    let mut ids: Vec<String> = TOOL_IDS
        .iter()
        .map(|tool| json!(tool).as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}
fn tool_of(id: &str) -> ToolId {
    serde_json::from_value(json!(id)).unwrap()
}
/// The default refresh cycle.
const INTERVAL: i128 = 300_000;
/// The UTC day of every fixture record.
const DAY: &str = "from=2026-10-20&to=2026-10-20";
const ROUTES: [&str; 5] = ["summary", "sessions", "breakdown", "projects", "export"];

/// `claude(id, input, output)` of `packages/collector/test/fixtures.ts`: 100 cache reads and 30 cache writes on top.
fn claude(id: &str, input: u64, output: u64) -> Value {
    json!({"type": "assistant", "sessionId": "claude-session", "cwd": "/synthetic/private-project", "timestamp": "2026-10-20T12:00:00.000Z",
    "requestId": format!("req-{id}"), "message": {"id": id, "model": "claude-sonnet-4-6", "content": [{"type": "text", "text": "PRIVATE_PROMPT_MARKER"}], "usage": {
        "input_tokens": input, "output_tokens": output, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 30,
        "cache_creation": {"ephemeral_5m_input_tokens": 10, "ephemeral_1h_input_tokens": 20}, "output_tokens_details": {"reasoning_tokens": output.min(7)},
    }}})
}

fn write_log(path: &Path, records: &[Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let lines: String = records.iter().map(|record| format!("{record}\n")).collect();
    fs::write(path, lines).unwrap();
}

/// The server's scratch folder, as its real path.
fn scratch(server: &Server) -> PathBuf {
    fs::canonicalize(server.web_root.path()).unwrap()
}

fn text(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

async fn status(server: &Server) -> Value {
    let reply = server.get("/api/local/status").await;
    assert_eq!(reply.status, 200, "{}", reply.text);
    reply.json()
}

fn source<'a>(status: &'a Value, id: &str) -> &'a Value {
    status["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["id"] == id)
        .unwrap()
}

fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys
}

fn millis(value: &Value) -> i128 {
    assert!(is_iso(value), "not an ISO timestamp: {value}");
    OffsetDateTime::parse(value.as_str().unwrap(), &Rfc3339)
        .unwrap()
        .unix_timestamp_nanos()
        / 1_000_000
}

fn now() -> i128 {
    OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
}

async fn tokens(server: &Server, query: &str) -> u64 {
    let reply = server.get(&format!("/api/local/summary?{query}")).await;
    assert_eq!(reply.status, 200, "{query}: {}", reply.text);
    reply.json()["tokens"].as_u64().unwrap()
}

async fn configure(server: &Server, tool: &str, enabled: bool, paths: &[String]) -> Reply {
    let body = json!({"enabled": enabled, "paths": paths});
    server
        .request(&format!("/api/local/sources/{tool}"), Init::method("PUT").json(body))
        .await
}

async fn post(server: &Server, path: &str) -> Reply {
    server.request(path, Init::method("POST")).await
}

async fn set_paused(server: &Server, paused: Value) -> Reply {
    let body = json!({ "paused": paused });
    server
        .request("/api/local/collection", Init::method("PUT").json(body))
        .await
}

/// Polls `check` for up to ten seconds (`vi.waitFor`).
async fn eventually(what: &str, mut check: impl AsyncFnMut() -> bool) {
    for _ in 0..200 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} did not happen within ten seconds");
}

/// The suggestion for a source with no folder: the default folders detected here, else the usual first one.
fn suggested(id: &str) -> Value {
    let env = |key: &str| std::env::var(key).ok();
    let home = std::env::home_dir().unwrap_or_default();
    let detected = detect_tools(env, &home);
    let defaults = default_source_paths(env, &home);
    let paths = match detected.iter().find(|tool| json!(tool.id) == id) {
        Some(tool) => tool.paths.clone(),
        None if !is_supported(tool_of(id)) => Vec::new(),
        None => defaults
            .into_iter()
            .find(|(tool, _)| json!(tool) == id)
            .map(|(_, paths)| paths.into_iter().take(1).collect())
            .unwrap_or_default(),
    };
    json!(paths)
}

fn source_name(id: &str) -> &'static str {
    tool_of(id).name()
}

#[tokio::test]
async fn status_reports_every_tool_with_its_suggested_folder_and_the_cycle_times() {
    let (server, _app) = Server::local(|_| {}).await;
    let reply = server.get("/api/local/status").await;
    assert_eq!(reply.status, 200);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    let body = reply.json();
    assert_eq!(keys(&body), STATUS_KEYS);
    let ids: Vec<&str> = body["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|source| source["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, tools());
    for id in tools() {
        let id = id.as_str();
        let source = source(&body, id);
        let state = if is_supported(tool_of(id)) {
            "permission_required"
        } else {
            "unsupported"
        };
        assert_eq!(
            (&source["name"], &source["enabled"], &source["state"]),
            (&json!(source_name(id)), &json!(false), &json!(state))
        );
        assert_eq!(
            (&source["eventCount"], &source["lastImportedAt"]),
            (&json!(0), &Value::Null)
        );
        assert_eq!(source["paths"], suggested(id), "{id}");
    }
    assert_eq!(source(&body, "cursor")["paths"], json!([]));
    for (key, value) in [
        ("collecting", json!(false)),
        ("lastScanAt", Value::Null),
        ("cloudLinked", json!(false)),
        ("lastSyncAt", Value::Null),
        ("syncError", Value::Null),
        ("alias", Value::Null),
        ("lastRefreshAt", Value::Null),
        ("refreshing", json!(false)),
    ] {
        assert_eq!(body[key], value, "{key}");
    }
    let version = body["pricingVersion"].as_str().unwrap();
    let hash = version.strip_prefix("litellm:").unwrap();
    assert!(hash.len() == 12 && hash.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    // The scheduler started with nothing enabled: the first cycle is five minutes away.
    let next = millis(&body["nextRefreshAt"]) - now();
    assert!(next > INTERVAL - 120_000 && next <= INTERVAL + 60_000, "{next}");

    // A source's own folders replace the suggestion, even while it is disabled.
    configure(&server, "gemini", false, &["/synthetic/gemini".into()]).await;
    assert_eq!(
        source(&status(&server).await, "gemini")["paths"],
        json!(["/synthetic/gemini"])
    );
}

/// A credential store that always fails, as a locked Keychain does.
struct Unavailable;

impl SecretStore for Unavailable {
    fn get(&self) -> BoxFuture<'_, Result<Option<CloudLink>, SecretError>> {
        Box::pin(async { Err("locked".into()) })
    }
    fn set(&self, _: CloudLink) -> BoxFuture<'_, Result<(), SecretError>> {
        Box::pin(async { Err("locked".into()) })
    }
    fn clear(&self) -> BoxFuture<'_, Result<(), SecretError>> {
        Box::pin(async { Err("locked".into()) })
    }
}

#[tokio::test]
async fn status_reads_a_failing_credential_store_as_unlinked() {
    let (server, _app) = Server::local(|options| options.secrets = Arc::new(Unavailable)).await;
    let body = status(&server).await;
    assert_eq!(
        (&body["cloudLinked"], &body["syncError"]),
        (&json!(false), &json!("CREDENTIAL_STORE_UNAVAILABLE"))
    );
}

#[tokio::test]
async fn detect_lists_the_tools_whose_default_folders_exist() {
    let (server, _app) = Server::local(|_| {}).await;
    let reply = server.get("/api/local/detect").await;
    assert_eq!(reply.status, 200);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    let home = std::env::home_dir().unwrap_or_default();
    let detected = detect_tools(|key: &str| std::env::var(key).ok(), &home);
    assert_eq!(reply.json(), json!({ "tools": detected }));
}

/// A home where Claude Code's usual folder holds one 161-token session and Codex's is empty.
fn tools_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    write_log(
        &home.path().join(".claude/projects/p/session.jsonl"),
        &[claude("msg-1", 11, 20)],
    );
    fs::create_dir_all(home.path().join(".codex/sessions")).unwrap();
    home
}

/// The app over the database in `data`, launched with the tools found in `home` and none of their variables set.
async fn launch(data: &Path, home: &Path) -> (Server, LocalApp) {
    let (database, detected) = (data.join("usage.sqlite"), detect_tools(|_| None, home));
    Server::local(move |options| {
        options.database_path = database;
        options.detected = detected;
    })
    .await
}

async fn quit(server: Server, app: LocalApp) {
    drop(server);
    app.close().await.unwrap();
}

/// Whether the database in `data` records that setup is done.
fn setup_completed(data: &Path) -> bool {
    let store = UsageStore::open(data.join("usage.sqlite")).unwrap();
    let completed = store.setup_completed().unwrap();
    store.close().unwrap();
    completed
}

#[tokio::test]
async fn the_first_run_turns_on_the_tools_found_and_reads_them_with_the_first_cycle() {
    let (home, data) = (tools_home(), tempfile::tempdir().unwrap());
    let (server, app) = launch(data.path(), home.path()).await;
    // Nothing is refreshed by hand: the cycle the app starts with reads the folders found.
    eventually("the first cycle", async || {
        status(&server).await["lastRefreshAt"].is_string()
    })
    .await;
    let body = status(&server).await;
    let enabled: Vec<String> = tools()
        .into_iter()
        .filter(|id| source(&body, id)["enabled"] == true)
        .collect();
    assert_eq!(enabled, ["claude", "codex"]);
    let real = |path: &str| json!([text(&fs::canonicalize(home.path().join(path)).unwrap())]);
    for (id, paths, events) in [
        ("claude", real(".claude/projects"), 1),
        ("codex", real(".codex/sessions"), 0),
    ] {
        let source = source(&body, id);
        assert_eq!(
            (&source["paths"], &source["eventCount"]),
            (&paths, &json!(events)),
            "{id}"
        );
    }
    // The setup panel's total: every token found.
    assert_eq!(body["firstRun"], json!({ "tokens": 161 }));
    quit(server, app).await;
    assert!(setup_completed(data.path()));
}

#[tokio::test]
async fn a_tool_turned_off_after_the_first_run_stays_off_at_the_next_launch() {
    let (home, data) = (tools_home(), tempfile::tempdir().unwrap());
    let (server, app) = launch(data.path(), home.path()).await;
    // As the Tracking switch does: the folders stay, the tool stops.
    let paths: Vec<String> = serde_json::from_value(source(&status(&server).await, "codex")["paths"].clone()).unwrap();
    assert_eq!(configure(&server, "codex", false, &paths).await.status, 200);
    quit(server, app).await;

    let (server, app) = launch(data.path(), home.path()).await;
    let body = status(&server).await;
    assert_eq!(
        (&source(&body, "claude")["enabled"], &source(&body, "codex")["enabled"]),
        (&json!(true), &json!(false))
    );
    // Not a first run, so no total for the setup panel.
    assert_eq!(keys(&body), STATUS_KEYS);
    quit(server, app).await;
}

#[tokio::test]
async fn a_first_launch_that_finds_no_tools_turns_nothing_on_and_the_next_one_looks_again() {
    let (home, data) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (server, app) = launch(data.path(), home.path()).await;
    let body = status(&server).await;
    assert_eq!(keys(&body), STATUS_KEYS);
    assert!(
        body["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|source| source["enabled"] == false)
    );
    quit(server, app).await;
    assert!(!setup_completed(data.path()));

    // Nothing was set up, so the first launch that finds a tool turns it on.
    fs::create_dir_all(home.path().join(".codex/sessions")).unwrap();
    let (server, app) = launch(data.path(), home.path()).await;
    let body = status(&server).await;
    assert_eq!(source(&body, "codex")["enabled"], true);
    assert_eq!(body["firstRun"], json!({ "tokens": 0 }));
    quit(server, app).await;
}

#[tokio::test]
async fn a_folder_found_after_setup_joins_its_enabled_tool_once() {
    let (home, data) = (tools_home(), tempfile::tempdir().unwrap());
    let (server, app) = launch(data.path(), home.path()).await;
    quit(server, app).await;

    // T3 Code's Codex profile appears after setup.
    fs::create_dir_all(home.path().join("t3-routing/.runtime/profiles/codex/sessions")).unwrap();
    let real = |path: &str| text(&fs::canonicalize(home.path().join(path)).unwrap());
    let (usual, t3) = (
        real(".codex/sessions"),
        real("t3-routing/.runtime/profiles/codex/sessions"),
    );
    let (server, app) = launch(data.path(), home.path()).await;
    assert_eq!(source(&status(&server).await, "codex")["paths"], json!([usual, t3]));
    // Removed by hand, it stays removed.
    assert_eq!(
        configure(&server, "codex", true, std::slice::from_ref(&usual))
            .await
            .status,
        200
    );
    quit(server, app).await;

    let (server, app) = launch(data.path(), home.path()).await;
    assert_eq!(source(&status(&server).await, "codex")["paths"], json!([usual]));
    quit(server, app).await;
}

#[tokio::test]
async fn an_install_with_a_configured_source_is_marked_set_up_and_nothing_else_is_turned_on() {
    let (home, data) = (tools_home(), tempfile::tempdir().unwrap());
    // An install from before the first run: Codex chosen by hand, no setup recorded.
    let (server, app) = launch(data.path(), &data.path().join("no-home")).await;
    let codex = text(&fs::canonicalize(home.path().join(".codex/sessions")).unwrap());
    assert_eq!(configure(&server, "codex", true, &[codex]).await.status, 200);
    quit(server, app).await;
    assert!(!setup_completed(data.path()));

    let (server, app) = launch(data.path(), home.path()).await;
    let body = status(&server).await;
    assert_eq!(
        (&source(&body, "claude")["enabled"], &source(&body, "codex")["enabled"]),
        (&json!(false), &json!(true))
    );
    assert_eq!(keys(&body), STATUS_KEYS);
    quit(server, app).await;
    assert!(setup_completed(data.path()));
}

#[tokio::test]
async fn sources_authorise_each_folder_once_as_its_real_path_and_start_a_cycle() {
    let (server, _app) = Server::local(|_| {}).await;
    let real = scratch(&server).join("folders").join("real");
    fs::create_dir_all(&real).unwrap();
    std::os::unix::fs::symlink(&real, scratch(&server).join("folders").join("link")).unwrap();
    let paths = [
        text(&real),
        text(&scratch(&server).join("folders").join("link")),
        format!("{}/", text(&real)),
        text(&real.join("..").join("real")),
    ];
    let reply = configure(&server, "claude", true, &paths).await;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    let body = reply.json();
    assert_eq!(keys(&body), STATUS_KEYS);
    assert_eq!(
        (&source(&body, "claude")["enabled"], &source(&body, "claude")["paths"]),
        (&json!(true), &json!([text(&real)]))
    );
    // Authorising a source starts a cycle by itself, and the status waits for a short one to finish.
    assert!(body["lastRefreshAt"].is_string());
    assert_eq!(
        (&source(&body, "claude")["state"], &body["refreshing"]),
        (&json!("detected"), &json!(false))
    );

    let body = configure(&server, "claude", false, &[]).await.json();
    assert_eq!(
        (&source(&body, "claude")["enabled"], &source(&body, "claude")["state"]),
        (&json!(false), &json!("paused"))
    );
    // A disabled source may name a folder that does not exist yet.
    let missing = text(&scratch(&server).join("not-yet-created"));
    let body = configure(&server, "claude", false, std::slice::from_ref(&missing))
        .await
        .json();
    assert_eq!(source(&body, "claude")["paths"], json!([missing]));
    // Every tool is accepted; one without a verified log format stays unsupported.
    let body = configure(&server, "cursor", true, &[text(&real)]).await.json();
    assert_eq!(source(&body, "cursor")["state"], "unsupported");
}

#[tokio::test]
async fn sources_refuse_unknown_tools_bad_bodies_and_unusable_paths() {
    let (server, _app) = Server::local(|_| {}).await;
    let put = async |id: &str, body: Value| {
        let path = format!("/api/local/sources/{id}");
        server.request(&path, Init::method("PUT").json(body)).await
    };
    // The tool is checked before the body.
    for id in ["nope", "Claude", "claude%20", "all"] {
        expect_error(
            &put(id, json!({"enabled": false, "paths": []})).await,
            404,
            "SOURCE_NOT_FOUND",
        );
        expect_error(&put(id, json!({"nonsense": true})).await, 404, "SOURCE_NOT_FOUND");
    }
    expect_error(&put(&"a".repeat(101), json!({})).await, 404, "NOT_FOUND");
    for body in [
        json!([]),
        json!("enabled"),
        json!(7),
        Value::Null,
        json!({"enabled": true, "paths": [], "extra": 1}),
    ] {
        expect_error(&put("claude", body).await, 400, "INVALID_REQUEST");
    }
    expect_error(
        &server.request("/api/local/sources/claude", Init::method("PUT")).await,
        400,
        "INVALID_REQUEST",
    );
    let many: Vec<String> = (0..21).map(|index| format!("/p{index}")).collect();
    for body in [
        json!({}),
        json!({"enabled": true}),
        json!({"paths": []}),
        json!({"enabled": "true", "paths": []}),
        json!({"enabled": null, "paths": []}),
        json!({"enabled": true, "paths": "/x"}),
        json!({"enabled": false, "paths": [1]}),
        json!({"enabled": false, "paths": [["/x"]]}),
        json!({"enabled": false, "paths": many}),
        json!({"enabled": false, "paths": [format!("/{}", "a".repeat(4096))]}),
    ] {
        expect_error(&put("claude", body).await, 400, "INVALID_PATHS");
    }
    // The limits are inclusive, and count UTF-16 units.
    assert_eq!(
        put("claude", json!({"enabled": false, "paths": &many[..20]}))
            .await
            .status,
        200
    );
    let long = format!("/{}", "é".repeat(4095));
    assert_eq!(
        put("claude", json!({"enabled": false, "paths": [long]})).await.status,
        200
    );

    let file = scratch(&server).join("single").join("session.txt");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, "").unwrap();
    for (enabled, paths) in [
        (true, vec![]),
        (true, vec!["relative/logs".to_owned()]),
        (false, vec!["relative/logs".to_owned()]),
        (true, vec![text(&scratch(&server).join("does-not-exist"))]),
        (true, vec![text(&file)]),
    ] {
        expect_error(
            &configure(&server, "claude", enabled, &paths).await,
            400,
            "SOURCE_UNAVAILABLE",
        );
    }
    let large = json!({"enabled": false, "paths": [format!("/{}", "a".repeat(17_000))]});
    expect_error(&put("claude", large).await, 413, "INVALID_REQUEST");
}

#[tokio::test]
async fn refresh_and_scan_run_one_cycle_and_answer_the_status() {
    let (server, _app) = Server::local(|_| {}).await;
    for route in ["/api/local/refresh", "/api/local/scan"] {
        let started = now();
        let reply = post(&server, route).await;
        assert_eq!(reply.status, 200, "{route}: {}", reply.text);
        let body = reply.json();
        assert_eq!(keys(&body), STATUS_KEYS);
        assert_eq!(body["refreshing"], false);
        // Even with nothing to read the cycle counts.
        let last = millis(&body["lastRefreshAt"]);
        assert!(last >= started - 1000 && last <= now() + 1000);
        assert!(millis(&body["lastScanAt"]) >= started - 1000);
        let next = millis(&body["nextRefreshAt"]) - last;
        assert!((INTERVAL - 1000..=INTERVAL + 60_000).contains(&next), "{next}");
        assert_eq!(status(&server).await["lastRefreshAt"], body["lastRefreshAt"]);
    }
    let replies = concurrent_refreshes(&server).await;
    assert!(replies.iter().all(|reply| reply.status == 200));
    for route in ["/api/local/refresh", "/api/local/scan"] {
        expect_error(&server.get(route).await, 404, "NOT_FOUND");
    }
}

/// Four concurrent refreshes, which share a cycle.
async fn concurrent_refreshes(server: &Server) -> Vec<Reply> {
    let refresh = || post(server, "/api/local/refresh");
    let (a, b, c, d) = tokio::join!(refresh(), refresh(), refresh(), refresh());
    vec![a, b, c, d]
}

#[tokio::test]
async fn pausing_refuses_refreshes_reports_enabled_sources_paused_and_resuming_reads_what_appeared() {
    let (server, app) = Server::local(|_| {}).await;
    let claude_root = scratch(&server).join(".claude").join("projects");
    let file = claude_root.join("p").join("session.jsonl");
    write_log(&file, &[claude("msg-1", 11, 20)]);
    for paused in [true, true, false, false] {
        let reply = set_paused(&server, json!(paused)).await;
        assert_eq!((reply.status, reply.json()), (200, json!({ "paused": paused })));
    }
    // Resuming started a cycle. Enabling a source while one runs joins it, as in TypeScript, so let it settle.
    app.refresh().await.unwrap();
    assert_eq!(
        configure(&server, "claude", true, &[text(&claude_root)]).await.status,
        200
    );
    eventually("the first import", async || tokens(&server, DAY).await == 161).await;
    assert_eq!(status(&server).await["collecting"], true);

    assert_eq!(set_paused(&server, json!(true)).await.status, 200);
    let body = status(&server).await;
    assert_eq!(
        (&body["collecting"], &body["refreshing"]),
        (&json!(false), &json!(false))
    );
    let claude_source = source(&body, "claude");
    assert_eq!(
        (
            &claude_source["enabled"],
            &claude_source["state"],
            &claude_source["eventCount"]
        ),
        (&json!(true), &json!("paused"), &json!(1))
    );
    // A source that is not enabled is not reported as paused.
    assert_eq!(source(&body, "codex")["state"], "permission_required");
    for route in ["/api/local/refresh", "/api/local/scan"] {
        expect_error(&post(&server, route).await, 409, "COLLECTION_PAUSED");
    }
    assert!(app.overview().await.unwrap().paused);

    // Nothing is read while paused, even a source authorised meanwhile.
    write_log(&file, &[claude("msg-1", 11, 20), claude("msg-2", 5, 6)]);
    let codex_root = scratch(&server).join(".codex").join("sessions");
    fs::create_dir_all(&codex_root).unwrap();
    assert_eq!(
        configure(&server, "codex", true, &[text(&codex_root)]).await.status,
        200
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(tokens(&server, DAY).await, 161);
    assert_eq!(source(&status(&server).await, "codex")["state"], "paused");

    let before = millis(&status(&server).await["lastRefreshAt"]);
    assert_eq!(set_paused(&server, json!(false)).await.json(), json!({"paused": false}));
    // The scan commits before its cycle records the time.
    eventually("the cycle after resuming", async || {
        tokens(&server, DAY).await == 302 && millis(&status(&server).await["lastRefreshAt"]) > before
    })
    .await;
    assert_eq!(status(&server).await["collecting"], true);
    assert_eq!(post(&server, "/api/local/refresh").await.status, 200);

    for body in [
        json!({}),
        json!({"paused": "true"}),
        json!({"paused": 1}),
        json!({"paused": null}),
        json!({"paused": [true]}),
        json!({"paused": true, "extra": 1}),
        json!({"Paused": true}),
        json!([]),
        json!("paused"),
        Value::Null,
    ] {
        let reply = server
            .request("/api/local/collection", Init::method("PUT").json(body))
            .await;
        expect_error(&reply, 400, "INVALID_REQUEST");
        assert_eq!(reply.json()["error"]["message"], "Choose whether collection is paused.");
    }
    expect_error(
        &server.request("/api/local/collection", Init::method("PUT")).await,
        400,
        "INVALID_REQUEST",
    );
    for method in ["GET", "POST", "DELETE"] {
        expect_error(
            &server.request("/api/local/collection", Init::method(method)).await,
            404,
            "NOT_FOUND",
        );
    }
    assert!(!app.overview().await.unwrap().paused);
}

#[tokio::test]
async fn pause_changes_apply_in_call_order_and_the_app_refuses_to_refresh_while_paused() {
    let (server, app) = Server::local(|_| {}).await;
    let (first, second, third) = (app.set_paused(true), app.set_paused(false), app.set_paused(true));
    third.await;
    second.await;
    first.await;
    assert!(app.overview().await.unwrap().paused);
    assert_eq!(code(app.refresh().await), "COLLECTION_PAUSED");
    app.set_paused(false).await;
    let overview = app.refresh().await.unwrap();
    assert!(!overview.paused && overview.refresh.last_refresh_at.is_some());
    drop(server);
    app.close().await.unwrap();
}

/// A Claude Code record dated `days` ago, worth 140 tokens plus `extra` input.
fn claude_ago(id: &str, days: i64, extra: u64, cwd: &str, session: &str) -> Value {
    let mut record = claude(id, 10 + extra, 0);
    record["timestamp"] = json!(ago(days));
    record["cwd"] = json!(cwd);
    record["sessionId"] = json!(session);
    record
}

/// `Date.prototype.toISOString` of `days` and five seconds ago.
fn ago(days: i64) -> String {
    let t = OffsetDateTime::now_utc() - time::Duration::days(days) - time::Duration::seconds(5);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

fn day_of(days: i64) -> String {
    ago(days)[..10].to_owned()
}

#[tokio::test]
async fn usage_queries_filter_by_range_tool_and_text_and_name_git_repositories() {
    let (server, _app) = Server::local(|_| {}).await;
    let checkout = scratch(&server).join("checkout");
    fs::create_dir_all(checkout.join(".git")).unwrap();
    fs::write(
        checkout.join(".git").join("config"),
        "[remote \"origin\"]\n\turl = git@github.com:synthetic-owner/synthetic-repo.git\n",
    )
    .unwrap();
    let roots = (
        scratch(&server).join(".claude").join("projects"),
        scratch(&server).join(".codex").join("sessions"),
    );
    // 140 tokens today (in the checkout), 150 ten days ago and 160 a hundred days ago; Codex 200 forty days ago.
    write_log(
        &roots.0.join("p").join("session.jsonl"),
        &[
            claude_ago("a", 0, 0, &text(&checkout), "checkout-session"),
            claude_ago("b", 10, 10, "/synthetic/private-project", "claude-session"),
            claude_ago("c", 100, 20, "/synthetic/private-project", "claude-session"),
        ],
    );
    let usage = json!({"input_tokens": 200, "cached_input_tokens": 0, "output_tokens": 0, "reasoning_output_tokens": 0, "total_tokens": 200});
    write_log(
        &roots.1.join("rollout.jsonl"),
        &[
            json!({"type": "session_meta", "payload": {"id": "codex-session", "cwd": "/synthetic/codex-project", "instructions": "PRIVATE_PROMPT_MARKER"}}),
            json!({"type": "turn_context", "payload": {"turn_id": "turn-1", "cwd": "/synthetic/codex-project", "model": "gpt-5-codex"}}),
            json!({"timestamp": ago(40), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": usage, "last_token_usage": null}}}),
        ],
    );
    for (tool, root) in [("claude", &roots.0), ("codex", &roots.1)] {
        assert_eq!(configure(&server, tool, true, &[text(root)]).await.status, 200);
    }
    for _ in 0..2 {
        assert_eq!(post(&server, "/api/local/refresh").await.status, 200);
    }

    for (query, expected) in [
        ("", 140),
        ("days=7", 140),
        ("days=30", 290),
        ("days=90", 490),
        ("days=365", 650),
        // `Number(days)`: leading zeros, a plus sign (`%2B`), spaces and hexadecimal all read as numbers.
        ("days=07", 140),
        ("days=%2B7", 140),
        ("days=+30+", 290),
        ("days=0x1e", 290),
        ("days=90&tool=codex", 200),
        ("days=90&tool=claude", 290),
        ("days=90&tool=all", 490),
        ("days=90&tool=gemini", 0),
        ("days=90&q=GPT-5", 200),
        ("days=90&q=checkout-session", 140),
        ("days=90&q=no-such-text", 0),
        ("from=2000-01-01&to=2099-12-31", 650),
    ] {
        assert_eq!(tokens(&server, query).await, expected, "{query}");
    }
    let (today, ten) = (day_of(0), day_of(10));
    assert_eq!(tokens(&server, &format!("from={today}&to={today}")).await, 140);
    assert_eq!(tokens(&server, &format!("from={ten}&to={today}")).await, 290);

    let summary = server.get("/api/local/summary?days=90&q=no-such-text").await.json();
    // `cacheRate` is an `f64` in `tokentracky-core`, written `0.0` where JavaScript writes `0`: the same number.
    assert_eq!(
        summary,
        json!({"tokens": 0, "breakdown": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0},
            "costMicrousd": null, "costParts": null, "sessions": 0, "cacheRate": 0.0, "byTool": [], "byModel": [], "daily": [],
            "activity": {"activeDays": 0, "currentStreak": 0, "longestStreak": 0, "bestDay": null, "averagePerActiveDay": 0}})
    );
    let sessions = server.get("/api/local/sessions?days=30").await.json();
    let ids: Vec<&Value> = sessions["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| &item["id"])
        .collect();
    assert_eq!(ids, [&json!("checkout-session"), &json!("claude-session")]);
    let breakdown = server
        .get("/api/local/breakdown?from=2000-01-01&to=2099-12-31")
        .await
        .json();
    let days: Vec<&Value> = breakdown["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| &row["day"])
        .collect();
    assert_eq!(
        days,
        [day_of(100), day_of(40), day_of(10), day_of(0)]
            .map(Value::from)
            .iter()
            .collect::<Vec<_>>()
    );
    let projects = server.get("/api/local/projects?days=30").await.json();
    let projects: Vec<Value> = projects["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| json!([item["name"], item["tokens"], item["sessions"], item["repository"]]))
        .collect();
    assert_eq!(
        projects,
        [
            json!(["/synthetic/private-project", 150, 1, null]),
            json!([text(&checkout), 140, 1, "synthetic-owner/synthetic-repo"]),
        ]
    );

    let reply = server.get(&format!("/api/local/export?from={today}&to={today}")).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type").unwrap(), "text/csv; charset=utf-8");
    assert_eq!(
        reply.header("content-disposition").unwrap(),
        "attachment; filename=\"tokentracky-usage.csv\""
    );
    assert_eq!(reply.header("cache-control").unwrap(), "no-store");
    let rows: Vec<&str> = reply.text.strip_suffix("\r\n").unwrap().split("\r\n").collect();
    assert_eq!(
        rows[0],
        "\"tool\",\"model\",\"timestamp\",\"project\",\"session\",\"input\",\"output\",\"cache_read\",\"cache_write\",\"reasoning\",\"total\",\"cost_microusd\""
    );
    assert_eq!(rows.len(), 2);
    assert!(rows[1].starts_with("\"claude\",\"claude-sonnet-4-6\","), "{}", rows[1]);
    assert!(!reply.text.contains("PRIVATE_PROMPT_MARKER"));
}

#[tokio::test]
async fn usage_queries_refuse_invalid_filters_on_every_route() {
    let (server, _app) = Server::local(|_| {}).await;
    let refused = async |query: &str, code: &str| {
        for route in ROUTES {
            let reply = server.get(&format!("/api/local/{route}?{query}")).await;
            assert_eq!(reply.status, 400, "{route}?{query}: {}", reply.text);
            expect_error(&reply, 400, code);
        }
    };
    for days in ["0", "1", "14", "366", "-7", "7.5", "abc", "", "Infinity", "inf", "0x"] {
        refused(&format!("days={days}"), "INVALID_FILTER").await;
    }
    for query in [
        "from=2026-10-20",
        "to=2026-10-20",
        "from=2026-10-21&to=2026-10-20",
        "from=2026-02-30&to=2026-03-01",
        "from=2026-1-1&to=2026-1-2",
        "from=&to=",
        "days=7&from=2026-10-20&to=2026-10-20",
        "days=30&to=2026-10-20",
        // A repeated parameter is a list.
        "days=7&days=7",
        "from=2026-10-20&from=2026-10-20&to=2026-10-20",
        "tool=nope",
        "tool=Claude",
        "tool=claude&tool=claude",
        // `tz` is an IANA zone the system knows (Rust only: TypeScript refuses it as an unknown parameter).
        "tz=Not/A_Zone",
        "tz=",
        "tz=%2B05%3A45",
        "tz=..%2F..%2Fetc%2Fpasswd",
        "tz=Asia/Tokyo&tz=Asia/Tokyo",
        // `since`/`until` are whole quarter hours in milliseconds, both given, `since` first, and on their own.
        "since=1792537200000",
        "until=1792540800000",
        "since=1792540800000&until=1792537200000",
        "since=1792537200000&until=1792537200000",
        "since=1792537200001&until=1792540800000",
        "since=1792537200000&until=1792540860000",
        "since=abc&until=1792540800000",
        "since=&until=1792540800000",
        "since=-900000&until=1792540800000",
        "since=1792537200000&until=1792540800000&days=7",
        "since=1792537200000&until=1792540800000&offset=1",
        "since=1792537200000&until=1792540800000&from=2026-10-20&to=2026-10-20",
        "since=1792537200000&since=1792537200000&until=1792540800000",
    ] {
        refused(query, "INVALID_FILTER").await;
    }
    refused(&format!("q={}", "a".repeat(201)), "INVALID_FILTER").await;
    // 201 UTF-16 units of `é`.
    refused(&format!("q={}", "%C3%A9".repeat(201)), "INVALID_FILTER").await;
    assert_eq!(
        server
            .get(&format!("/api/local/summary?q={}", "a".repeat(200)))
            .await
            .status,
        200
    );
    refused("days=7&extra=1", "INVALID_REQUEST").await;
    refused("page=2", "INVALID_REQUEST").await;
    // The CSV headers come with a download only.
    let reply = server.get("/api/local/export?days=3").await;
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    assert_eq!(reply.header("content-disposition"), None);
}

#[tokio::test]
async fn usage_queries_count_local_days_in_a_time_zone_and_the_day_route_gives_its_half_hours() {
    let (server, _app) = Server::local(|_| {}).await;
    let root = scratch(&server).join(".claude").join("projects");
    let mut late = claude("late", 10, 0);
    late["timestamp"] = json!("2026-10-20T23:30:00.000Z");
    write_log(&root.join("p").join("session.jsonl"), &[late]);
    assert_eq!(configure(&server, "claude", true, &[text(&root)]).await.status, 200);
    assert_eq!(post(&server, "/api/local/refresh").await.status, 200);

    // 23:30 UTC on the 20th is the 21st in Tokyo and still the 20th in New York; without a zone, days are UTC.
    for (query, expected) in [
        ("from=2026-10-21&to=2026-10-21&tz=Asia/Tokyo", 140),
        ("from=2026-10-20&to=2026-10-20&tz=Asia/Tokyo", 0),
        ("from=2026-10-20&to=2026-10-20&tz=America/New_York", 140),
        ("from=2026-10-21&to=2026-10-21&tz=America/New_York", 0),
        ("from=2026-10-20&to=2026-10-20", 140),
    ] {
        assert_eq!(tokens(&server, query).await, expected, "{query}");
    }
    let range = "from=2026-10-19&to=2026-10-22&tz=Asia/Tokyo";
    let summary = server.get(&format!("/api/local/summary?{range}")).await.json();
    assert_eq!(summary["daily"][0]["day"], "2026-10-21");
    let breakdown = server.get(&format!("/api/local/breakdown?{range}")).await.json();
    assert_eq!(breakdown["items"][0]["day"], "2026-10-21");
    // The CSV keeps its UTC timestamps.
    let csv = server.get(&format!("/api/local/export?{range}")).await.text;
    assert!(csv.contains("\"2026-10-20T23:30:00.000Z\""), "{csv}");

    // 08:30 in Tokyo is the eighteenth half hour of the 21st, which starts at 15:00 UTC on the 20th.
    let reply = server.get("/api/local/day?date=2026-10-21&tz=Asia/Tokyo").await;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let mut half_hours = vec![0; 48];
    half_hours[17] = 140;
    assert_eq!(
        reply.json(),
        json!({"start": "2026-10-20T15:00:00.000Z", "halfHours": half_hours})
    );
    let reply = server.get("/api/local/day?date=2026-10-20&tz=Asia/Tokyo").await;
    assert_eq!(reply.json()["halfHours"], json!(vec![0; 48]));
    for query in [
        "",
        "date=2026-10-21",
        "tz=Asia/Tokyo",
        "date=2026-02-30&tz=Asia/Tokyo",
        "date=today&tz=Asia/Tokyo",
        "date=2026-10-21&tz=Not/A_Zone",
        "date=2026-10-21&date=2026-10-21&tz=Asia/Tokyo",
    ] {
        let reply = server.get(&format!("/api/local/day?{query}")).await;
        expect_error(&reply, 400, "INVALID_FILTER");
    }
    expect_error(
        &server
            .get("/api/local/day?date=2026-10-21&tz=Asia/Tokyo&tool=claude")
            .await,
        400,
        "INVALID_REQUEST",
    );
}

#[tokio::test]
async fn usage_queries_take_an_exact_window_and_the_hours_route_gives_its_hours() {
    let (server, _app) = Server::local(|_| {}).await;
    let root = scratch(&server).join(".claude").join("projects");
    let mut late = claude("late", 10, 0);
    late["timestamp"] = json!("2026-10-20T23:30:00.000Z");
    write_log(&root.join("p").join("session.jsonl"), &[late]);
    assert_eq!(configure(&server, "claude", true, &[text(&root)]).await.status, 200);
    assert_eq!(post(&server, "/api/local/refresh").await.status, 200);

    // 23:00, 23:30, 23:45 and midnight UTC on the 20th; the event is at 23:30.
    for (query, expected) in [
        ("since=1792537200000&until=1792540800000", 140),
        ("since=1792539000000&until=1792539900000", 140),
        ("since=1792537200000&until=1792539000000", 0),
        ("since=1792539900000&until=1792540800000", 0),
        ("since=1792537200000&until=1792540800000&tz=Asia/Tokyo&tool=claude", 140),
    ] {
        assert_eq!(tokens(&server, query).await, expected, "{query}");
    }
    let window = "since=1792537200000&until=1792540800000";
    for route in ["sessions", "breakdown", "projects"] {
        let reply = server.get(&format!("/api/local/{route}?{window}")).await;
        assert_eq!(reply.status, 200, "{route}: {}", reply.text);
        assert_eq!(reply.json()["items"].as_array().unwrap().len(), 1, "{route}");
    }
    let csv = server.get(&format!("/api/local/export?{window}")).await.text;
    assert!(csv.contains("\"2026-10-20T23:30:00.000Z\""), "{csv}");

    // Hours count from `since`: from 22:30, the event is in the hour starting at 23:30; from 23:00, in the one at 23:00.
    let hours = async |query: &str| {
        let reply = server.get(&format!("/api/local/hours?{query}")).await;
        assert_eq!(reply.status, 200, "{query}: {}", reply.text);
        let items = reply.json()["items"].clone();
        let items = items.as_array().unwrap();
        items
            .iter()
            .map(|item| json!([item["hour"], item["tool"], item["model"], item["tokens"]]))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        hours(window).await,
        [json!(["2026-10-20T23:00:00.000Z", "claude", "claude-sonnet-4-6", 140])]
    );
    // 22:30 on the 20th to 22:30 on the 21st: a whole day, the longest it takes.
    assert_eq!(
        hours("since=1792535400000&until=1792621800000&tool=claude").await,
        [json!(["2026-10-20T23:30:00.000Z", "claude", "claude-sonnet-4-6", 140])]
    );
    assert_eq!(
        hours("since=1792537200000&until=1792540800000&tool=codex").await,
        Vec::<Value>::new()
    );
    for query in [
        "",
        "days=7",
        "from=2026-10-20&to=2026-10-20",
        "since=1792537200000",
        // Not whole hours, and more than a day.
        "since=1792537200000&until=1792539900000",
        "since=1792535400000&until=1792625400000",
        "since=1792537200000&until=1792540800000&days=7",
    ] {
        expect_error(
            &server.get(&format!("/api/local/hours?{query}")).await,
            400,
            "INVALID_FILTER",
        );
    }
    expect_error(
        &server.get(&format!("/api/local/hours?{window}&date=2026-10-20")).await,
        400,
        "INVALID_REQUEST",
    );
}

#[tokio::test]
async fn the_cycle_looks_up_the_weekly_rank_and_publishes_the_overview() {
    let stub = Stub::start().await;
    let publication = json!({"alias": "stub-builder", "historyStart": null, "shareTools": false, "shareCost": false,
        "shareModels": false, "generation": uuid::Uuid::new_v4().to_string()});
    stub.answer(
        "GET /api/device-policy",
        Answer::json(json!({ "publication": publication })),
    );
    stub.on("POST /api/ingest", |call| {
        Answer::json(json!({"accepted": call.body.as_ref().unwrap()["buckets"].as_array().unwrap().len()}))
    });
    let profile = "GET /api/profiles/stub-builder";
    stub.answer(profile, Answer::json(json!({"alias": "stub-builder", "rank": 3})));
    let published: Arc<Mutex<Vec<LocalOverview>>> = Arc::default();
    let sink = published.clone();
    let (server, app) = Server::local(|options| {
        options.cloud_url = Some(stub.url.clone());
        options.on_refresh = Some(Arc::new(move |overview| sink.lock().unwrap().push(overview)));
    })
    .await;

    // Not linked: no lookup.
    assert_eq!(app.refresh().await.unwrap().rank, None);
    assert!(stub.to(profile).is_empty());
    let link = json!({"url": stub.url, "deviceToken": format!("device-token-{}", "x".repeat(30)), "historyStart": null, "shareTools": false, "shareCost": false});
    let reply = server.request("/api/local/cloud", Init::method("PUT").json(link)).await;
    assert_eq!(reply.status, 200, "{}", reply.text);

    let overview = app.refresh().await.unwrap();
    assert_eq!(
        (overview.rank, overview.alias.as_deref()),
        (Some(3), Some("stub-builder"))
    );
    assert!(overview.refresh.last_refresh_at.is_some() && !overview.paused);
    assert_eq!(published.lock().unwrap().last(), Some(&overview));
    let calls = stub.to(profile);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].query, [("period".to_owned(), "week".to_owned())].into());
    // The cycle synced before it looked up the rank.
    assert_eq!(stub.to("POST /api/ingest").len(), 1);

    // A failure keeps the last rank; a missing profile clears it; only a safe integer is a rank.
    for (answer, rank) in [
        (Answer::status(500), Some(3)),
        (Answer::json(Value::Null), Some(3)),
        (Answer::json(json!({"rank": 7})), Some(7)),
        (Answer::json(json!({"rank": 2.5})), None),
        (Answer::json(json!({"rank": 4})), Some(4)),
        (Answer::status(404), None),
        (Answer::json(json!([1])), None),
    ] {
        stub.answer(profile, answer.clone());
        assert_eq!(app.refresh().await.unwrap().rank, rank, "{answer:?}");
    }

    stub.answer(profile, Answer::json(json!({"rank": 1})));
    assert_eq!(app.refresh().await.unwrap().rank, Some(1));
    let menu = server.get("/api/local/overview").await.json();
    assert_eq!((&menu["rank"], &menu["alias"]), (&json!(1), &json!("stub-builder")));
    let reply = server.request("/api/local/cloud", Init::method("DELETE")).await;
    assert_eq!(reply.status, 204);
    // The overview drops the rank with the link at once, before any cycle.
    let menu = server.get("/api/local/overview").await.json();
    assert_eq!((&menu["rank"], &menu["alias"]), (&Value::Null, &Value::Null));
    let calls = stub.to(profile).len();
    assert_eq!(app.refresh().await.unwrap().rank, None);
    assert_eq!(stub.to(profile).len(), calls);
    drop(server);
    app.close().await.unwrap();
}

const OVERVIEW_KEYS: [&str; 11] = [
    "alias",
    "allTime",
    "month",
    "nextRefreshAt",
    "paused",
    "rank",
    "refreshedAt",
    "refreshing",
    "today",
    "topTool",
    "week",
];

/// `GET /api/local/overview` for an overview: its fields, with `lastRefreshAt` as `refreshedAt`.
fn menu(overview: &LocalOverview) -> Value {
    let mut value = serde_json::to_value(overview).unwrap();
    let refreshed = value.as_object_mut().unwrap().remove("lastRefreshAt").unwrap();
    value["refreshedAt"] = refreshed;
    value
}

/// Usage committed straight to the store, as a scan would, but with no cycle: 133 tokens, under its own event id.
fn unread(server: &Server, id: &str) {
    let event = UsageEvent {
        event_id: format!("claude:{id}"),
        ..support::claude(id, "/synthetic/other", 1, 2)
    };
    commit(&server.state.store, &format!("/synthetic/{id}.jsonl"), &[event]);
}

/// Logs the 161-token fixture and runs a cycle over it.
async fn cycle_over_the_fixture(server: &Server, app: &LocalApp) {
    let logs = scratch(server).join("claude");
    write_log(&logs.join("session.jsonl"), &[claude("msg-1", 11, 20)]);
    assert_eq!(configure(server, "claude", true, &[text(&logs)]).await.status, 200);
    app.refresh().await.unwrap();
}

/// Rust only, for the Mac app's pages.
#[tokio::test]
async fn the_overview_is_the_last_cycles_without_another_pass_over_the_usage() {
    let published: Arc<Mutex<Vec<LocalOverview>>> = Arc::default();
    let sink = published.clone();
    let (server, app) = Server::local(|options| {
        options.on_refresh = Some(Arc::new(move |overview| sink.lock().unwrap().push(overview)));
    })
    .await;

    // Before the first cycle it is computed once, as `LocalApp::overview` computes it.
    let reply = server.get("/api/local/overview").await;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    let body = reply.json();
    assert_eq!(keys(&body), OVERVIEW_KEYS);
    assert_eq!(body, menu(&app.overview().await.unwrap()));
    assert_eq!((&body["allTime"], &body["refreshedAt"]), (&json!(0), &Value::Null));
    assert!(published.lock().unwrap().is_empty());

    // After a cycle, it is what the cycle published.
    cycle_over_the_fixture(&server, &app).await;
    let last = published.lock().unwrap().last().cloned().unwrap();
    let body = server.get("/api/local/overview").await.json();
    assert_eq!(keys(&body), OVERVIEW_KEYS);
    assert_eq!(body, menu(&last));
    assert_eq!(body["allTime"], 161);
    assert!(is_iso(&body["refreshedAt"]));

    // Usage that no cycle has read yet does not show; pausing does, at once.
    unread(&server, "other");
    assert_eq!(app.overview().await.unwrap().totals.all_time, 161 + 133);
    assert_eq!(server.get("/api/local/overview").await.json(), body);
    assert_eq!(set_paused(&server, json!(true)).await.status, 200);
    let paused = server.get("/api/local/overview").await.json();
    assert_eq!((&paused["paused"], &paused["allTime"]), (&json!(true), &json!(161)));
    drop(server);
    app.close().await.unwrap();
}

/// Rust only. With nothing listening to the cycle (the CLI), the cycle makes no pass over the usage for the overview;
/// the first request after it makes exactly one.
#[tokio::test]
async fn without_a_listener_the_overview_waits_for_a_request() {
    let (server, app) = Server::local(|_| {}).await;
    cycle_over_the_fixture(&server, &app).await;
    // Usage that arrives after the cycle shows, so the pass is the request's.
    unread(&server, "after-the-cycle");
    assert_eq!(server.get("/api/local/overview").await.json()["allTime"], 161 + 133);
    // Later requests reuse it until the next cycle.
    unread(&server, "after-the-request");
    assert_eq!(server.get("/api/local/overview").await.json()["allTime"], 161 + 133);
    app.refresh().await.unwrap();
    assert_eq!(server.get("/api/local/overview").await.json()["allTime"], 161 + 2 * 133);
    drop(server);
    app.close().await.unwrap();
}

#[tokio::test]
async fn serve_tcp_serves_loopback_behind_the_session_and_closes_gracefully() {
    let directory = tempfile::tempdir().unwrap();
    let server = serve_tcp(LocalApp::open(local_options(directory.path())).unwrap(), 0)
        .await
        .unwrap();
    let url = server.url().to_owned();
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .unwrap();
    let launch = client.get(server.launch_url()).send().await.unwrap();
    assert_eq!(launch.status(), 200);
    let cookie = launch.headers()["set-cookie"].to_str().unwrap();
    let cookie = cookie.split(';').next().unwrap().to_owned();
    assert!(cookie.starts_with("tk_local="));

    let reply = client
        .get(format!("{url}/api/local/status"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    // The peer address reaches the rate limit.
    assert_eq!(reply.headers()["x-ratelimit-limit"], "240");
    let body: Value = reply.json().await.unwrap();
    assert_eq!(keys(&body), STATUS_KEYS);
    // The cycle was started with the server.
    assert!(body["nextRefreshAt"].is_string());
    let refreshed = client
        .post(format!("{url}/api/local/refresh"))
        .header("cookie", &cookie)
        .header("origin", &url)
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), 200);
    let refused = client.get(format!("{url}/api/local/status")).send().await.unwrap();
    assert_eq!(refused.status(), 401);

    server.close().await.unwrap();
    assert!(client.get(format!("{url}/api/health")).send().await.is_err());
    // The database's lock is free again.
    LocalApp::open(local_options(directory.path()))
        .unwrap()
        .close()
        .await
        .unwrap();
}
