//! The CLI's commands, against the library's `run` and a data folder under a temporary directory. The credential file
//! store has its own test in `crates/secrets`.
use axum::extract::State;
use axum::http::Method;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokentracky_cli::{Context, ServeHandle, USAGE, run};
use tokentracky_collector::store::{SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService};
use tokentracky_core::ToolId;
use tokentracky_local_api::{CloudLink, HttpClient, HttpRequest, MemorySecretStore, ReqwestClient, SecretStore};

/// A writer the test can read back while the context owns another handle on it.
#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);

impl Output {
    fn take(&self) -> String {
        String::from_utf8(std::mem::take(&mut *self.0.lock().unwrap())).unwrap()
    }
}
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

struct Fixture {
    root: TempDir,
    home: PathBuf,
    data_dir: PathBuf,
    context: Context,
    stdout: Output,
    stderr: Output,
    secrets: Arc<MemorySecretStore>,
    opened: Arc<Mutex<Vec<String>>>,
    confirmed: Arc<AtomicUsize>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new().prefix("tokentracky-cli-").tempdir().unwrap();
        let (home, data_dir, web_root) = (
            root.path().join("home"),
            root.path().join("data"),
            root.path().join("web"),
        );
        fs::create_dir_all(&web_root).unwrap();
        fs::write(web_root.join("index.html"), "<html><body>dashboard</body></html>").unwrap();
        let (stdout, stderr) = (Output::default(), Output::default());
        let secrets = Arc::new(MemorySecretStore::default());
        let opened = Arc::new(Mutex::new(Vec::new()));
        let confirmed = Arc::new(AtomicUsize::new(0));
        let context = Context {
            version: "9.9.9".to_owned(),
            env: Box::new(|name| (name == "TOKENTRACKY_PRICING_REFRESH").then(|| "off".to_owned())),
            home: Some(home.clone()),
            stdout: Box::new(stdout.clone()),
            stderr: Box::new(stderr.clone()),
            secret_store: Some(secrets.clone()),
            open_url: {
                let opened = opened.clone();
                Arc::new(move |url| opened.lock().unwrap().push(url.to_owned()))
            },
            open_app: Arc::new(|| false),
            web_root,
            interactive: false,
            confirm: {
                let confirmed = confirmed.clone();
                Box::new(move |_| {
                    confirmed.fetch_add(1, Ordering::SeqCst);
                    false
                })
            },
            poll_interval: Duration::from_millis(5),
            utc_offset: time::UtcOffset::UTC,
            on_serve: None,
        };
        Self {
            root,
            home,
            data_dir,
            context,
            stdout,
            stderr,
            secrets,
            opened,
            confirmed,
        }
    }

    /// `run(...argv)` with this fixture's data folder.
    async fn run(&mut self, argv: &[&str]) -> Ran {
        let data_dir = self.data_dir.to_str().unwrap().to_owned();
        let argv: Vec<&str> = argv.iter().copied().chain(["--data-dir", &data_dir]).collect();
        self.run_bare(&argv).await
    }

    /// `run(...argv)` exactly as given.
    async fn run_bare(&mut self, argv: &[&str]) -> Ran {
        self.stdout.take();
        self.stderr.take();
        let code = run(argv.iter().copied(), &mut self.context).await;
        Ran {
            code,
            stdout: self.stdout.take(),
            stderr: self.stderr.take(),
        }
    }

    /// An installed Mac app: each opening records whether the data folder's lock was free for the app to take.
    fn install_mac_app(&mut self) -> Arc<Mutex<Vec<bool>>> {
        let (openings, database) = (Arc::new(Mutex::new(Vec::new())), self.data_dir.join("usage.sqlite"));
        let seen = openings.clone();
        self.context.open_app = Arc::new(move || {
            let store = UsageStore::open(database.clone());
            seen.lock().unwrap().push(store.is_ok());
            if let Ok(store) = store {
                store.close().unwrap();
            }
            true
        });
        openings
    }

    /// What "Start tracking" does in the dashboard: approve one synthetic Claude Code folder.
    fn track(&self) {
        let logs = self.root.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("session.jsonl"), format!("{}\n", claude())).unwrap();
        fs::create_dir_all(&self.data_dir).unwrap();
        let store = Arc::new(Mutex::new(
            UsageStore::open(self.data_dir.join("usage.sqlite")).unwrap(),
        ));
        let service = IngestionService::new(store.clone(), IngestionOptions::default()).unwrap();
        let configuration = SourceConfiguration {
            enabled: true,
            paths: vec![logs.to_str().unwrap().to_owned()],
        };
        service.configure_source(ToolId::Claude, &configuration).unwrap();
        drop(service);
        Arc::into_inner(store).unwrap().into_inner().unwrap().close().unwrap();
    }
}

/// One assistant turn of 161 tokens (11 in, 20 out, 100 cache read, 30 cache write) carrying a private prompt, project
/// and session.
fn claude() -> Value {
    json!({"type": "assistant", "sessionId": "claude-session", "cwd": "/synthetic/private-project",
        "timestamp": "2026-10-20T12:00:00.000Z", "requestId": "req-msg-1",
        "message": {"id": "msg-1", "model": "claude-sonnet-4-6",
            "content": [{"type": "text", "text": "PRIVATE_PROMPT_MARKER"}],
            "usage": {"input_tokens": 11, "output_tokens": 20, "cache_read_input_tokens": 100,
                "cache_creation_input_tokens": 30,
                "cache_creation": {"ephemeral_5m_input_tokens": 10, "ephemeral_1h_input_tokens": 20},
                "output_tokens_details": {"reasoning_tokens": 7}}}})
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn prints_help_the_version_and_usage_errors() {
    let mut f = Fixture::new();
    assert!(f.run(&["--help"]).await.stdout.contains("tokentracky <command>"));
    assert_eq!(f.run(&["--help"]).await.stdout, USAGE);
    assert_eq!(f.run(&["--version"]).await.stdout, "9.9.9\n");
    assert_eq!(f.run(&["-v"]).await.stdout, "9.9.9\n");
    let bad = f.run(&["launch"]).await;
    assert_eq!(bad.code, 2);
    assert!(bad.stderr.contains("Unknown command launch"));
    assert_eq!(bad.stderr, format!("Unknown command launch\n\n{USAGE}"));
    assert_eq!(f.run(&["status", "--port", "x"]).await.code, 2);
    // No command prints the usage to stdout and fails.
    let none = f.run(&[]).await;
    assert_eq!((none.code, none.stdout), (1, USAGE.to_owned()));
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_an_empty_data_folder_without_creating_it() {
    let mut f = Fixture::new();
    let result = f.run(&["status", "--json"]).await;
    assert_eq!(result.code, 0);
    let report = parse(&result.stdout);
    let version = report["pricingVersion"].as_str().unwrap();
    assert!(version.starts_with("litellm:"));
    assert_eq!(
        report,
        json!({"version": "9.9.9", "dataDir": f.data_dir, "running": false, "lastRefreshAt": null,
            "totals": {"today": 0, "week": 0, "month": 0, "allTime": 0, "topTool": null, "costs": {"today": 0, "week": 0, "month": 0, "allTime": 0}}, "sources": [],
            "leaderboard": {"linked": false, "url": null}, "pricingVersion": version})
    );
    // The keys keep the order of the TypeScript report.
    let keys: Vec<&str> = result.stdout.lines().filter(|line| line.starts_with("  \"")).collect();
    let keys: Vec<&str> = keys.iter().map(|line| line.split('"').nth(1).unwrap()).collect();
    assert_eq!(
        keys,
        [
            "version",
            "dataDir",
            "running",
            "lastRefreshAt",
            "totals",
            "sources",
            "leaderboard",
            "pricingVersion"
        ]
    );
    assert!(!f.data_dir.exists());
    let text = f.run(&["status"]).await.stdout;
    assert_eq!(
        text,
        format!(
            "Tokentracky 9.9.9 · {}\nToday 0 · This week 0 · This month 0 · All time 0 tokens\nTracking: nothing yet. Run `tokentracky serve` and choose Start tracking.\nLeaderboard: not linked. Run `tokentracky login` to join.\nLast refresh: never\n",
            f.data_dir.display()
        )
    );
    assert!(!f.data_dir.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn refreshes_tracked_sources_then_reports_totals_in_text_and_json() {
    let mut f = Fixture::new();
    assert!(f.run(&["refresh"]).await.stderr.contains("Nothing is tracked yet"));
    f.track();
    let refreshed = f.run(&["refresh", "--json"]).await;
    assert_eq!(refreshed.stderr, "");
    assert_eq!(refreshed.code, 0);
    let report = parse(&refreshed.stdout);
    assert_eq!(report["totals"]["allTime"], 161);
    assert!(report["lastRefreshAt"].is_string());
    let claude = report["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["id"] == "claude")
        .unwrap();
    assert_eq!(claude["enabled"], true);
    assert_eq!(claude["state"], "current");
    assert_eq!(claude["eventCount"], 1);
    // A source lists exactly these keys, in this order.
    let order = refreshed.stdout.split("\"sources\": [").nth(1).unwrap();
    let order: Vec<&str> = order
        .lines()
        .skip(2)
        .take(6)
        .map(|line| line.split('"').nth(1).unwrap())
        .collect();
    assert_eq!(
        order,
        ["id", "name", "enabled", "state", "eventCount", "lastImportedAt"]
    );
    let status = f.run(&["status"]).await.stdout;
    assert!(status.contains("All time 161 tokens"), "{status}");
    assert!(status.contains("Tracking: Claude Code (current, 1 events)"), "{status}");
    assert!(status.find("All time 161 tokens") < status.find("Claude Code (current, 1 events)"));
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_status_beside_a_running_collector_but_will_not_refresh_or_uninstall_under_it() {
    let mut f = Fixture::new();
    f.track();
    f.run(&["refresh"]).await;
    let owner = UsageStore::open(f.data_dir.join("usage.sqlite")).unwrap();
    let status = parse(&f.run(&["status", "--json"]).await.stdout);
    assert_eq!(status["running"], true);
    assert_eq!(status["totals"]["allTime"], 161);
    let text = f.run(&["status"]).await.stdout;
    assert!(
        text.starts_with(&format!("Tokentracky 9.9.9 · {} · running\n", f.data_dir.display())),
        "{text}"
    );
    let refresh = f.run(&["refresh"]).await;
    assert_eq!(refresh.code, 1);
    assert!(refresh.stderr.contains("already running"));
    assert_eq!(f.run(&["uninstall", "--yes"]).await.code, 1);
    assert!(f.data_dir.exists());
    owner.close().unwrap();
    // The lock is released with the store.
    assert_eq!(parse(&f.run(&["status", "--json"]).await.stdout)["running"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn checks_the_runtime_data_folder_detected_tools_link_and_last_refresh() {
    let mut f = Fixture::new();
    fs::create_dir_all(f.home.join(".codex").join("sessions")).unwrap();
    let result = f.run(&["doctor", "--json"]).await;
    assert_eq!(result.code, 0);
    let doctor = parse(&result.stdout);
    assert_eq!(doctor["ok"], true);
    let names: Vec<&str> = doctor["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "runtime",
            "sqlite",
            "data",
            "database",
            "tools",
            "leaderboard",
            "refresh",
            "pricing"
        ]
    );
    assert_eq!(
        doctor["checks"][0]["detail"],
        "Tokentracky 9.9.9 (native build, no Node.js needed)"
    );
    assert_eq!(doctor["checks"][3]["detail"], "Database: not created yet");
    assert_eq!(
        doctor["detected"],
        json!([{"id": "codex", "name": "Codex", "paths": [f.home.join(".codex").join("sessions")]}])
    );
    let keys: Vec<&str> = result.stdout.lines().filter(|line| line.starts_with("  \"")).collect();
    let keys: Vec<&str> = keys.iter().map(|line| line.split('"').nth(1).unwrap()).collect();
    assert_eq!(keys, ["ok", "checks", "detected"]);
    let text = f.run(&["doctor"]).await;
    assert!(text.stdout.contains("✓ Tools: found Codex"));
    assert!(text.stdout.contains("✓ Prices litellm:"));
    assert!(text.stdout.ends_with("daily refresh off\n"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn doctor_fails_when_the_data_folder_cannot_be_written() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    let locked = f.root.path().join("locked");
    fs::create_dir(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
    f.data_dir = locked.join("data");
    let result = f.run(&["doctor", "--json"]).await;
    let text = f.run(&["doctor"]).await;
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(result.code, 1);
    let doctor = parse(&result.stdout);
    assert_eq!(doctor["ok"], false);
    assert_eq!(doctor["checks"][2]["name"], "data");
    assert_eq!(doctor["checks"][2]["ok"], false);
    assert_eq!(
        doctor["checks"][2]["detail"],
        format!("{} is not writable", f.data_dir.display())
    );
    assert!(
        text.stdout
            .contains(&format!("✗ {} is not writable\n", f.data_dir.display()))
    );
}

/// The hosted service of the login test: device authorisation that is pending once and then approved, the publication
/// policy, and an ingest that records every body.
#[derive(Clone)]
struct Hosted {
    polls: Arc<AtomicUsize>,
    ingested: Arc<Mutex<Vec<Value>>>,
    ingest_status: u16,
    /// The code has expired by the first poll.
    expired: bool,
}

fn publication() -> Value {
    json!({"alias": "cli-builder", "historyStart": null, "shareTools": false, "shareCost": false,
        "generation": "00000000-0000-4000-8000-000000000001"})
}

async fn hosted(ingest_status: u16) -> (String, Hosted) {
    start_hosted(ingest_status, false).await
}

async fn start_hosted(ingest_status: u16, expired: bool) -> (String, Hosted) {
    let state = Hosted {
        polls: Arc::default(),
        ingested: Arc::default(),
        ingest_status,
        expired,
    };
    let router = Router::new()
        .route(
            "/api/device-auth",
            post(|| async {
                let expires = OffsetDateTime::now_utc() + Duration::from_secs(600);
                Json(json!({"pollToken": "ttp_poll", "userCode": "BCDF-GHJK",
                    "expiresAt": expires.format(&Rfc3339).unwrap(), "interval": 3}))
            }),
        )
        .route(
            "/api/device-auth/poll",
            post(|State(hosted): State<Hosted>| async move {
                if hosted.expired {
                    return (
                        axum::http::StatusCode::GONE,
                        Json(json!({"error": {"code": "EXPIRED"}})),
                    );
                }
                if hosted.polls.fetch_add(1, Ordering::SeqCst) + 1 < 2 {
                    return (axum::http::StatusCode::OK, Json(json!({"status": "pending"})));
                }
                let approved = json!({"status": "approved", "deviceToken": format!("ttd_{}", "x".repeat(40)),
                    "publication": publication()});
                (axum::http::StatusCode::OK, Json(approved))
            }),
        )
        .route(
            "/api/device-policy",
            get(|| async { Json(json!({"publication": publication()})) }),
        )
        .route(
            "/api/ingest",
            post(|State(hosted): State<Hosted>, Json(body): Json<Value>| async move {
                let accepted = body["buckets"].as_array().map_or(0, Vec::len);
                hosted.ingested.lock().unwrap().push(body);
                let status = axum::http::StatusCode::from_u16(hosted.ingest_status).unwrap();
                (status, Json(json!({"accepted": accepted})))
            }),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await });
    (origin, state)
}

#[tokio::test(flavor = "multi_thread")]
async fn logs_in_through_browser_approval_stores_the_credential_syncs_and_unlinks() {
    let (origin, hosted) = hosted(200).await;
    let mut f = Fixture::new();
    f.track();
    f.run(&["refresh"]).await;
    let result = f.run(&["login", "--cloud-url", &origin]).await;
    assert_eq!(result.code, 0, "{}", result.stderr);
    assert!(result.stdout.contains("Your code: BCDF-GHJK"));
    assert!(
        result
            .stdout
            .contains(&format!("Approve this computer at {origin}/?connect=BCDF-GHJK"))
    );
    assert!(result.stdout.contains("Waiting for approval (the code expires at "));
    assert!(result.stdout.contains("Connected as cli-builder"));
    assert_eq!(*f.opened.lock().unwrap(), [format!("{origin}/?connect=BCDF-GHJK")]);
    let link = f.secrets.get().await.unwrap().unwrap();
    assert_eq!(link.url, origin);
    assert_eq!(link.device_token, format!("ttd_{}", "x".repeat(40)));
    let sent = Value::Array(hosted.ingested.lock().unwrap().clone()).to_string();
    assert!(sent.contains("\"tokens\":161"), "{sent}");
    assert!(
        !["private-project", "claude-session", "PRIVATE_PROMPT_MARKER"]
            .iter()
            .any(|marker| sent.contains(marker))
    );
    assert_eq!(
        parse(&f.run(&["status", "--json"]).await.stdout)["leaderboard"],
        json!({"linked": true, "url": origin})
    );
    assert!(
        f.run(&["status"])
            .await
            .stdout
            .contains(&format!("Leaderboard: linked to {origin}\n"))
    );
    assert_eq!(f.run(&["unlink"]).await.code, 0);
    assert_eq!(f.secrets.get().await.unwrap(), None);
}

/// On a computer that never ran Tokentracky, `login` turns on the tools in their usual folders and reads them while the
/// code waits for approval, so the first upload already holds the history.
#[tokio::test(flavor = "multi_thread")]
async fn login_tracks_the_tools_it_finds_and_uploads_their_history() {
    let (origin, hosted) = hosted(200).await;
    let mut f = Fixture::new();
    let project = f.home.join(".claude").join("projects").join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("session.jsonl"), format!("{}\n", claude())).unwrap();
    let result = f.run(&["login", "--cloud-url", &origin]).await;
    assert_eq!(result.code, 0, "{}", result.stderr);
    let sent = Value::Array(hosted.ingested.lock().unwrap().clone()).to_string();
    assert!(sent.contains("\"tokens\":161"), "{sent}");
}

/// With the Mac app installed, `login` leaves the uploading to it: it lets go of the data folder, then opens the app.
#[tokio::test(flavor = "multi_thread")]
async fn login_hands_the_computer_to_the_mac_app_once_approved() {
    let (origin, _) = hosted(200).await;
    let mut f = Fixture::new();
    let openings = f.install_mac_app();
    let result = f.run(&["login", "--cloud-url", &origin]).await;
    assert_eq!(result.code, 0, "{}", result.stderr);
    assert!(
        result.stdout.ends_with(
            "Connected as cli-builder.\nTokentracky is open in your menu bar and uploads this computer's daily totals every 5 minutes.\n"
        ),
        "{}",
        result.stdout
    );
    assert_eq!(*openings.lock().unwrap(), [true]);
}

/// Without the app, `login` keeps the dashboard and the five-minute cycle running in the terminal, as `serve` does.
#[tokio::test(flavor = "multi_thread")]
async fn login_keeps_uploading_from_the_terminal_without_the_mac_app() {
    let (origin, _) = hosted(200).await;
    let mut f = Fixture::new();
    let result = f.run(&["login", "--cloud-url", &origin]).await;
    assert_eq!(result.code, 0, "{}", result.stderr);
    let (_, after) = result.stdout.split_once("Connected as cli-builder.\n").unwrap();
    assert!(
        after.starts_with(
            "Keep this running to upload this computer's daily totals every 5 minutes.\nOpen your private dashboard: http://127.0.0.1:"
        ),
        "{after}"
    );
    // Off a terminal only the approval page opens.
    assert_eq!(f.opened.lock().unwrap().len(), 1);
}

/// While the Mac app holds the data folder, `login` opens its window instead of refusing.
#[tokio::test(flavor = "multi_thread")]
async fn login_opens_the_running_mac_app_instead_of_refusing() {
    let mut f = Fixture::new();
    f.track();
    let owner = UsageStore::open(f.data_dir.join("usage.sqlite")).unwrap();
    let openings = f.install_mac_app();
    let result = f.run(&["login", "--cloud-url", "https://cloud.example"]).await;
    assert_eq!(result.code, 0, "{}", result.stderr);
    assert_eq!(
        result.stdout,
        "Tokentracky is already running in your menu bar; its window is open now.\n"
    );
    assert_eq!(openings.lock().unwrap().len(), 1);
    assert!(f.opened.lock().unwrap().is_empty());
    owner.close().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn refresh_syncs_a_linked_computer_and_reports_a_failed_sync() {
    let (origin, hosted) = hosted(500).await;
    let mut f = Fixture::new();
    f.track();
    let link = CloudLink {
        url: origin.clone(),
        device_token: format!("ttd_{}", "x".repeat(40)),
        history_start: None,
        share_tools: false,
        share_cost: false,
        share_models: false,
        generation: "00000000-0000-4000-8000-000000000001".to_owned(),
    };
    f.secrets.set(link).await.unwrap();
    let result = f.run(&["refresh"]).await;
    assert_eq!(result.code, 0);
    assert!(
        result
            .stderr
            .contains("Leaderboard sync failed (SYNC_FAILED); local totals are current and the next refresh retries."),
        "{}",
        result.stderr
    );
    assert_eq!(hosted.ingested.lock().unwrap().len(), 1);
    assert!(result.stdout.contains("All time 161 tokens"));
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_log_in_without_a_persistent_credential_store() {
    let mut f = Fixture::new();
    f.context.secret_store = None;
    let result = f.run(&["login", "--cloud-url", "https://cloud.example"]).await;
    assert_eq!(result.code, 1);
    assert!(result.stderr.contains("needs a credential store"), "{}", result.stderr);
}

#[tokio::test(flavor = "multi_thread")]
async fn uninstalls_only_after_confirmation_removing_data_and_the_credential() {
    let mut f = Fixture::new();
    f.track();
    let link = CloudLink {
        url: "https://cloud.example".to_owned(),
        device_token: format!("ttd_{}", "y".repeat(40)),
        history_start: None,
        share_tools: false,
        share_cost: false,
        share_models: false,
        generation: "00000000-0000-4000-8000-000000000002".to_owned(),
    };
    f.secrets.set(link).await.unwrap();
    let refused = f.run(&["uninstall"]).await;
    assert_eq!(refused.code, 1);
    assert_eq!(
        refused.stderr,
        "Nothing was deleted. Run `tokentracky uninstall --yes` to confirm.\n"
    );
    f.context.interactive = true;
    assert_eq!(f.run(&["uninstall"]).await.code, 1);
    assert_eq!(f.confirmed.load(Ordering::SeqCst), 1);
    assert!(f.data_dir.exists());
    let removed = f.run(&["uninstall", "--yes"]).await;
    assert_eq!(removed.code, 0);
    assert_eq!(
        removed.stdout,
        format!(
            "Removed {}. Tokentracky never changed your tools' settings, so there is nothing else to undo.\n",
            f.data_dir.display()
        )
    );
    assert!(!f.data_dir.exists());
    assert_eq!(f.secrets.get().await.unwrap(), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_authenticated_dashboard_from_the_data_folder() {
    let mut f = Fixture::new();
    let launched: Arc<Mutex<Option<(String, u16)>>> = Arc::default();
    f.context.on_serve = Some(Box::new({
        let launched = launched.clone();
        move |server: ServeHandle| {
            let launched = launched.clone();
            Box::pin(async move {
                let launch = server.launch_url();
                let request = HttpRequest::new(Method::GET, launch.clone(), Duration::from_secs(10));
                let response = ReqwestClient::new().unwrap().send(request).await.unwrap();
                *launched.lock().unwrap() = Some((launch, response.status.as_u16()));
            })
        }
    }));
    let result = f.run(&["serve"]).await;
    assert_eq!(result.code, 0, "{}", result.stderr);
    assert!(
        result
            .stdout
            .starts_with("Open your private dashboard: http://127.0.0.1:")
    );
    assert!(
        result
            .stdout
            .contains("\nThis link works once and expires in five minutes.\n")
    );
    assert!(!result.stdout.contains("Press Enter"));
    assert!(!result.stdout.contains("kept only while this process runs"));
    let (launch, status) = launched.lock().unwrap().clone().unwrap();
    assert_eq!(status, 200);
    let rest = launch.strip_prefix("http://127.0.0.1:").unwrap();
    assert!(
        rest.split_once('/')
            .is_some_and(|(port, _)| port.parse::<u16>().is_ok()),
        "{launch}"
    );
    assert!(f.data_dir.join("usage.sqlite").exists());
    // `serve` released the data folder when it closed.
    assert_eq!(parse(&f.run(&["status", "--json"]).await.stdout)["running"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_collector_backed_routes_only_to_the_redeemed_launch_link() {
    let mut f = Fixture::new();
    f.track();
    let answers: Arc<Mutex<Vec<(u16, String)>>> = Arc::default();
    f.context.on_serve = Some(Box::new({
        let answers = answers.clone();
        move |server: ServeHandle| {
            let answers = answers.clone();
            Box::pin(async move {
                let client = ReqwestClient::new().unwrap();
                let get = |url: String, cookie: Option<String>| {
                    let mut request = HttpRequest::new(Method::GET, url, Duration::from_secs(10));
                    if let Some(cookie) = cookie {
                        request = request.header(axum::http::header::COOKIE, cookie);
                    }
                    client.send(request)
                };
                // Without the session cookie the API is closed.
                let closed = get(format!("{}/api/local/status", server.url), None).await.unwrap();
                let launch = get(server.launch_url(), None).await.unwrap();
                let cookie = launch.headers["set-cookie"]
                    .to_str()
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap()
                    .to_owned();
                let mut seen = vec![(closed.status.as_u16(), String::new())];
                for path in ["/api/local/status", "/api/local/summary?days=7", "/api/local/detect"] {
                    let answer = get(format!("{}{path}", server.url), Some(cookie.clone()))
                        .await
                        .unwrap();
                    seen.push((answer.status.as_u16(), String::from_utf8(answer.body).unwrap()));
                }
                *answers.lock().unwrap() = seen;
            })
        }
    }));
    let result = f.run(&["serve"]).await;
    assert_eq!(result.code, 0, "{}", result.stderr);
    let answers = answers.lock().unwrap().clone();
    assert_eq!(answers[0].0, 401);
    let statuses: Vec<u16> = answers.iter().map(|(status, _)| *status).collect();
    assert_eq!(statuses, [401, 200, 200, 200], "{answers:?}");
    let status = parse(&answers[1].1);
    let claude = status["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["id"] == "claude")
        .unwrap();
    assert_eq!(claude["enabled"], true);
    assert!(
        status.get("collecting").is_some() && status.get("lastScanAt").is_some(),
        "{status}"
    );
    assert!(parse(&answers[2].1)["tokens"].is_u64(), "{}", answers[2].1);
    assert!(parse(&answers[3].1)["tools"].is_array(), "{}", answers[3].1);
}

#[tokio::test(flavor = "multi_thread")]
async fn serve_says_when_enter_gives_a_new_link_and_when_credentials_are_kept_in_memory() {
    let mut f = Fixture::new();
    f.context.interactive = true;
    f.context.secret_store = None;
    f.context.on_serve = Some(Box::new(|_| Box::pin(async {})));
    let result = f.run(&["serve", "--port", "0"]).await;
    assert_eq!(result.code, 0);
    assert!(
        result
            .stdout
            .contains("expires in five minutes. Press Enter for a fresh link.\n")
    );
    assert!(
        result
            .stdout
            .ends_with("Leaderboard credentials are kept only while this process runs.\n")
    );
}

/// On a terminal `serve` opens the dashboard itself, with a link of its own: the printed one stays unused.
#[tokio::test(flavor = "multi_thread")]
async fn serve_opens_the_dashboard_in_the_browser_on_a_terminal() {
    let mut f = Fixture::new();
    f.context.interactive = true;
    f.context.on_serve = Some(Box::new(|_| Box::pin(async {})));
    let result = f.run(&["serve"]).await;
    assert_eq!(result.code, 0, "{}", result.stderr);
    let opened = f.opened.lock().unwrap().clone();
    assert_eq!(opened.len(), 1);
    assert!(
        opened[0].starts_with("http://127.0.0.1:") && opened[0].contains("/?launch="),
        "{opened:?}"
    );
    assert!(result.stdout.contains("Open your private dashboard: http://127.0.0.1:"));
    assert!(!result.stdout.contains(&opened[0]));
}

#[tokio::test(flavor = "multi_thread")]
async fn serve_will_not_start_beside_another_collector() {
    let mut f = Fixture::new();
    f.track();
    let owner = UsageStore::open(f.data_dir.join("usage.sqlite")).unwrap();
    let result = f.run(&["serve"]).await;
    assert_eq!(result.code, 1);
    assert!(result.stderr.contains("already running"));
    assert!(result.stdout.is_empty());
    owner.close().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn finds_the_data_folder_from_the_flag_the_environment_or_the_home_folder() {
    let mut f = Fixture::new();
    let (from_env, from_flag) = (f.root.path().join("from-env"), f.root.path().join("from-flag"));
    let home_dir = from_env.to_str().unwrap().to_owned();
    f.context.env = Box::new(move |name| match name {
        "TOKENTRACKY_HOME" => Some(home_dir.clone()),
        "TOKENTRACKY_PRICING_REFRESH" => Some("off".to_owned()),
        _ => None,
    });
    let data_dir = |ran: &Ran| PathBuf::from(parse(&ran.stdout)["dataDir"].as_str().unwrap());
    assert_eq!(data_dir(&f.run_bare(&["status", "--json"]).await), from_env);
    let flag = from_flag.to_str().unwrap();
    assert_eq!(
        data_dir(&f.run_bare(&["status", "--json", "--data-dir", flag]).await),
        from_flag
    );
    // Normalised as `path.resolve` does: no `..`, no trailing separator.
    let messy = format!("{}/elsewhere/../from-flag/", f.root.path().display());
    assert_eq!(
        data_dir(&f.run_bare(&["--data-dir", &messy, "status", "--json"]).await),
        from_flag
    );
    let relative = f.run_bare(&["status", "--json", "--data-dir=some/./dir"]).await;
    assert_eq!(data_dir(&relative), std::env::current_dir().unwrap().join("some/dir"));
    f.context.env = Box::new(|name| (name == "TOKENTRACKY_PRICING_REFRESH").then(|| "off".to_owned()));
    assert_eq!(
        data_dir(&f.run_bare(&["status", "--json"]).await),
        f.home.join(".tokentracky")
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn creates_the_data_folder_for_the_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    assert_eq!(f.run(&["refresh"]).await.code, 0);
    let mode = fs::metadata(&f.data_dir).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
    assert!(f.data_dir.join("usage.sqlite").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn doctor_reads_the_database_beside_a_running_collector() {
    let mut f = Fixture::new();
    f.track();
    let owner = UsageStore::open(f.data_dir.join("usage.sqlite")).unwrap();
    let result = f.run(&["doctor", "--json"]).await;
    owner.close().unwrap();
    assert_eq!(result.code, 0);
    let doctor = parse(&result.stdout);
    assert_eq!(doctor["checks"][3]["name"], "database");
    assert_eq!(
        doctor["checks"][3]["detail"],
        "Database: in use by a running Tokentracky (checked read-only)"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn uninstalls_when_the_terminal_answer_is_yes() {
    let mut f = Fixture::new();
    f.track();
    f.context.interactive = true;
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    f.context.confirm = Box::new({
        let asked = asked.clone();
        move |question| {
            asked.lock().unwrap().push(question.to_owned());
            true
        }
    });
    assert_eq!(f.run(&["uninstall"]).await.code, 0);
    assert!(!f.data_dir.exists());
    assert_eq!(
        *asked.lock().unwrap(),
        [format!(
            "Delete {} and this computer's leaderboard credential? [y/N] ",
            f.data_dir.display()
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn login_reports_an_expired_code_and_an_unreachable_service() {
    let (origin, _) = start_hosted(200, true).await;
    let mut f = Fixture::new();
    let expired = f.run(&["login", "--cloud-url", &origin]).await;
    assert_eq!(expired.code, 1);
    assert!(expired.stdout.contains("Your code: BCDF-GHJK"));
    assert_eq!(
        expired.stderr,
        "The code expired before it was approved. Run `tokentracky login` again.\n"
    );
    assert_eq!(f.secrets.get().await.unwrap(), None);
    // Nothing listens on port 1.
    let down = f.run(&["login", "--cloud-url", "http://127.0.0.1:1"]).await;
    assert_eq!(down.code, 1);
    assert_eq!(
        down.stderr,
        "The leaderboard could not be reached. Check your connection and try again.\n"
    );
    assert_eq!(f.opened.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn login_uses_the_saved_link_before_overrides_and_flags_before_environment_when_unlinked() {
    let (origin, _) = hosted(200).await;
    let mut f = Fixture::new();
    let from_env = origin.clone();
    f.context.env = Box::new(move |name| match name {
        "TOKENTRACKY_CLOUD_URL" => Some(from_env.clone()),
        "TOKENTRACKY_PRICING_REFRESH" => Some("off".to_owned()),
        _ => None,
    });
    assert_eq!(f.run(&["login"]).await.code, 0);
    // The saved link keeps its server even when an invalid explicit override is present.
    f.context.env = Box::new(|name| (name == "TOKENTRACKY_PRICING_REFRESH").then(|| "off".to_owned()));
    let relogin = f.run(&["login", "--cloud-url", "ftp://invalid.example"]).await;
    assert_eq!(relogin.code, 0, "{}", relogin.stderr);
    assert_eq!(f.opened.lock().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_cloud_url_that_is_not_an_https_origin() {
    let mut f = Fixture::new();
    for command in ["login", "serve"] {
        let result = f.run(&[command, "--cloud-url", "ftp://cloud.example"]).await;
        assert_eq!(result.code, 1, "{command}");
        assert_eq!(
            result.stderr,
            "Use the HTTPS origin of your hosted service (loopback HTTP is allowed for development).\n"
        );
    }
}
