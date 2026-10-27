//! Shared test doubles: a scripted [`HttpClient`], a recording stand-in for the hosted API, a client for the
//! assembled router that sends what `tests/contract/runner.ts` sends, and the `contract-server` binary on loopback TCP.
#![allow(dead_code)]
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::connect_info::MockConnectInfo;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tokentracky_collector::store::{FileCheckpoint, UsageStore};
use tokentracky_core::{TokenCounts, ToolId, UsageEvent};
use tokentracky_local_api::{
    BoxFuture, HttpClient, HttpError, HttpRequest, HttpResponse, LocalApp, LocalError, LocalOptions, LocalSession,
    LocalState, MemorySecretStore, ReqwestClient, base_router,
};
use tower::ServiceExt;

// ---------------------------------------------------------------------------------------------------------------
// The scripted client.

pub type Fetch = BoxFuture<'static, Result<HttpResponse, HttpError>>;
type Script = Box<dyn FnMut(&HttpRequest) -> Fetch + Send>;

/// Records every request when it is sent and answers it from a script, like `vi.fn<typeof fetch>`.
pub struct ScriptedClient {
    calls: Mutex<Vec<HttpRequest>>,
    script: Mutex<Script>,
    once: Mutex<VecDeque<Script>>,
}

impl ScriptedClient {
    pub fn new(script: impl FnMut(&HttpRequest) -> Fetch + Send + 'static) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::default(),
            script: Mutex::new(Box::new(script)),
            once: Mutex::default(),
        })
    }
    /// `mockImplementation`.
    pub fn script(&self, script: impl FnMut(&HttpRequest) -> Fetch + Send + 'static) {
        *self.script.lock().unwrap() = Box::new(script);
    }
    /// `mockImplementationOnce`: answers the next request only.
    pub fn once(&self, script: impl FnMut(&HttpRequest) -> Fetch + Send + 'static) {
        self.once.lock().unwrap().push_back(Box::new(script));
    }
    pub fn calls(&self) -> Vec<HttpRequest> {
        self.calls.lock().unwrap().clone()
    }
    /// `mockClear`.
    pub fn clear(&self) {
        self.calls.lock().unwrap().clear();
    }
    pub fn urls(&self) -> Vec<String> {
        self.calls().into_iter().map(|call| call.url).collect()
    }
}

impl HttpClient for ScriptedClient {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, HttpError>> {
        self.calls.lock().unwrap().push(request.clone());
        let once = self.once.lock().unwrap().pop_front();
        match once {
            Some(mut script) => script(&request),
            None => (self.script.lock().unwrap())(&request),
        }
    }
}

/// An answer with this status and body text.
pub fn respond(status: u16, body: impl Into<String>) -> Fetch {
    let body = body.into().into_bytes();
    Box::pin(async move {
        Ok(HttpResponse {
            status: StatusCode::from_u16(status).unwrap(),
            headers: HeaderMap::new(),
            body,
        })
    })
}

pub fn respond_json(status: u16, value: Value) -> Fetch {
    respond(status, value.to_string())
}

/// A network failure, as `fetch` rejects.
pub fn offline() -> Fetch {
    Box::pin(async { Err("offline".into()) })
}

/// Waits for `ready`, then answers.
pub fn after(ready: impl Future<Output = ()> + Send + 'static, reply: Fetch) -> Fetch {
    Box::pin(async move {
        ready.await;
        reply.await
    })
}

/// The JSON body of a recorded request.
pub fn body(request: &HttpRequest) -> Value {
    serde_json::from_str(request.body.as_deref().expect("a request body")).unwrap()
}

/// A recorded request header.
pub fn header(request: &HttpRequest, name: &str) -> Option<String> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.as_str().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

pub fn path(request: &HttpRequest) -> String {
    url::Url::parse(&request.url).unwrap().path().to_owned()
}

/// The error code of a refusal.
pub fn code<T: std::fmt::Debug>(result: Result<T, LocalError>) -> &'static str {
    result.expect_err("expected a refusal").code
}

// ---------------------------------------------------------------------------------------------------------------
// The store.

pub fn memory_store() -> Arc<Mutex<UsageStore>> {
    Arc::new(Mutex::new(UsageStore::open(":memory:").unwrap()))
}

fn checkpoint(path: &str) -> FileCheckpoint {
    FileCheckpoint {
        path: path.to_owned(),
        tool: ToolId::Claude,
        identity: "1:2".to_owned(),
        offset: 0,
        // `digest('')`, the prefix hash of an empty file.
        prefix_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
        parser_version: 1,
        state: json!({"sessionId": null, "project": null, "model": "unknown", "turnId": null, "previous": null, "baselines": [], "seenDeltaIds": []}),
        diagnostics: Vec::new(),
        file_size: None,
        mtime_ms: None,
        ctime_ms: None,
    }
}

/// Replaces what one log file contributed, as a scan of the rewritten file would.
pub fn commit(store: &Mutex<UsageStore>, path: &str, events: &[UsageEvent]) {
    store
        .lock()
        .unwrap()
        .commit_file(&checkpoint(path), events, true)
        .unwrap();
}

/// One Claude Code record of `claude(id, input, output)` in `tests/contract/fixtures.ts`: 100 cache reads and
/// 30 cache writes on top, so `claude('msg-1', 11, 20)` is 161 tokens on 2026-10-20.
pub fn claude(session: &str, project: &str, input: u64, output: u64) -> UsageEvent {
    UsageEvent {
        event_id: "claude:msg-1:req-msg-1".to_owned(),
        tool: ToolId::Claude,
        model: "claude-sonnet-4-6".to_owned(),
        occurred_at: Some("2026-10-20T12:00:00.000Z".to_owned()),
        project: Some(project.to_owned()),
        session_id: session.to_owned(),
        tokens: TokenCounts {
            input,
            output,
            cache_read: 100,
            cache_write: 30,
            reasoning: Some(output.min(7)),
            cache_write_1h: None,
        },
        service_tier: None,
        claude_mirror_id: None,
        cost_microusd: None,
        pricing_version: None,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The stand-in for the hosted API.

#[derive(Debug, Clone)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: HeaderMap,
    pub body: Option<Value>,
}

impl Call {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|value| value.to_str().unwrap())
    }
}

#[derive(Debug, Clone, Default)]
pub struct Answer {
    pub status: Option<u16>,
    pub json: Option<Value>,
    pub text: Option<String>,
    pub headers: Vec<(String, String)>,
}

impl Answer {
    pub fn json(value: Value) -> Self {
        Self {
            json: Some(value),
            ..Self::default()
        }
    }
    pub fn text(text: &str) -> Self {
        Self {
            text: Some(text.to_owned()),
            ..Self::default()
        }
    }
    pub fn status(status: u16) -> Self {
        Self {
            status: Some(status),
            ..Self::default()
        }
    }
    pub fn with_status(self, status: u16) -> Self {
        Self {
            status: Some(status),
            ..self
        }
    }
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

type Route = Arc<dyn Fn(&Call) -> Answer + Send + Sync>;

#[derive(Clone, Default)]
struct StubState {
    calls: Arc<Mutex<Vec<Call>>>,
    routes: Arc<Mutex<HashMap<String, Route>>>,
}

/// A stand-in for the hosted API on loopback: it records what the local server sends and answers as told; routes
/// without an answer get a 404 with the hosted error shape.
pub struct Stub {
    pub url: String,
    state: StubState,
    server: tokio::task::JoinHandle<()>,
}

async fn answer(State(stub): State<StubState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let text = String::from_utf8(to_bytes(body, usize::MAX).await.unwrap().to_vec()).unwrap();
    let query = url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .collect();
    let call = Call {
        method: parts.method.to_string(),
        path: parts.uri.path().to_owned(),
        query,
        headers: parts.headers,
        body: (!text.is_empty()).then(|| serde_json::from_str(&text).unwrap()),
    };
    stub.calls.lock().unwrap().push(call.clone());
    let route = stub
        .routes
        .lock()
        .unwrap()
        .get(&format!("{} {}", call.method, call.path))
        .cloned();
    let answer = match route {
        Some(route) => route(&call),
        None => Answer::json(json!({"error": {"code": "NOT_FOUND", "message": "Not found."}})).with_status(404),
    };
    let mut response = Response::builder()
        .status(answer.status.unwrap_or(200))
        .header("content-type", "application/json");
    for (name, value) in &answer.headers {
        response = response.header(name, value);
    }
    let text = answer
        .text
        .or(answer.json.map(|json| json.to_string()))
        .unwrap_or_default();
    response.body(Body::from(text)).unwrap()
}

impl Stub {
    pub async fn start() -> Self {
        let state = StubState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(answer).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, state, server }
    }
    /// Answers `METHOD /path` with `answer(call)`.
    pub fn on(&self, route: &str, answer: impl Fn(&Call) -> Answer + Send + Sync + 'static) {
        self.state
            .routes
            .lock()
            .unwrap()
            .insert(route.to_owned(), Arc::new(answer));
    }
    /// Answers `METHOD /path` with a fixed answer.
    pub fn answer(&self, route: &str, answer: Answer) {
        self.on(route, move |_| answer.clone());
    }
    pub fn calls(&self) -> Vec<Call> {
        self.state.calls.lock().unwrap().clone()
    }
    /// The calls to one route, oldest first.
    pub fn to(&self, route: &str) -> Vec<Call> {
        self.calls()
            .into_iter()
            .filter(|call| format!("{} {}", call.method, call.path) == route)
            .collect()
    }
    /// Stops listening, so the port refuses connections.
    pub async fn close(self) {
        self.server.abort();
        let _ = self.server.await;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The assembled router, driven as `tests/contract/runner.ts` drives a server.

pub const ORIGIN: &str = "http://127.0.0.1:4771";

pub struct Server {
    pub app: Router,
    pub state: LocalState,
    pub session: LocalSession,
    pub launch_url: String,
    pub cookie: Option<String>,
    pub web_root: tempfile::TempDir,
}

pub struct Reply {
    pub status: u16,
    pub headers: HeaderMap,
    pub text: String,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or_else(|_| panic!("not JSON: {}", self.text))
    }
    /// A header, repeated values joined as Node joins them.
    pub fn header(&self, name: &str) -> Option<String> {
        let values: Vec<_> = self
            .headers
            .get_all(name)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect();
        (!values.is_empty()).then(|| values.join(", "))
    }
    pub fn cookies(&self) -> Vec<String> {
        self.headers
            .get_all("set-cookie")
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect()
    }
}

/// A request as the runner sends it: `host`, `origin` and the session cookie by default, overridden or removed (`None`)
/// per header, and `content-type: application/json` with a JSON body.
#[derive(Default)]
pub struct Init {
    pub method: Option<&'static str>,
    pub headers: Vec<(&'static str, Option<String>)>,
    pub json: Option<Value>,
    pub body: Option<String>,
}

impl Init {
    pub fn method(method: &'static str) -> Self {
        Self {
            method: Some(method),
            ..Self::default()
        }
    }
    pub fn header(mut self, name: &'static str, value: Option<&str>) -> Self {
        self.headers.push((name, value.map(str::to_owned)));
        self
    }
    pub fn json(mut self, value: Value) -> Self {
        self.json = Some(value);
        self
    }
    pub fn body(mut self, body: &str) -> Self {
        self.body = Some(body.to_owned());
        self
    }
    /// No cookie and no origin, as before a session exists.
    pub fn no_session(self) -> Self {
        self.header("cookie", None).header("origin", None)
    }
    /// The method, headers and body sent to a server at `origin` holding `cookie`.
    fn outgoing(self, origin: &str, cookie: Option<&String>) -> (&'static str, Vec<(String, String)>, Option<String>) {
        let host = origin.strip_prefix("http://").unwrap();
        let mut headers: Vec<(String, String)> = vec![("host".into(), host.into()), ("origin".into(), origin.into())];
        if let Some(cookie) = cookie {
            headers.push(("cookie".into(), cookie.clone()));
        }
        if self.json.is_some() {
            headers.push(("content-type".into(), "application/json".into()));
        }
        for (name, value) in self.headers {
            headers.retain(|(other, _)| other != name);
            if let Some(value) = value {
                headers.push((name.to_owned(), value));
            }
        }
        let body = self.json.map(|json| json.to_string()).or(self.body);
        (self.method.unwrap_or("GET"), headers, body)
    }
}

/// A web root holding `index.html` and `assets/contract.js`.
fn web_root() -> tempfile::TempDir {
    let web_root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(web_root.path().join("assets")).unwrap();
    std::fs::write(
        web_root.path().join("index.html"),
        "<!doctype html><html><body>contract workspace</body></html>",
    )
    .unwrap();
    std::fs::write(web_root.path().join("assets/contract.js"), "/* contract asset */").unwrap();
    web_root
}

/// What `LocalApp::open` is given by [`Server::local`]: a database in `directory`'s `data/` folder, credentials in
/// memory, the production client, no pricing download, the hourly cycle and no tools found for the first run.
pub fn local_options(directory: &std::path::Path) -> LocalOptions {
    LocalOptions {
        database_path: directory.join("data").join("usage.sqlite"),
        web_root: directory.to_owned(),
        cloud_url: None,
        secrets: Arc::new(MemorySecretStore::default()),
        client: Arc::new(ReqwestClient::new().unwrap()),
        pricing_refresh: false,
        initially_paused: false,
        refresh_interval_ms: None,
        on_refresh: None,
        detected: Vec::new(),
        claude_config_file: None,
    }
}

impl Server {
    /// The whole local app (`LocalApp::open`, then `start`) behind the session and the rate limit, logged in, with
    /// [`local_options`] over the web root as `change` leaves them. Drop the server before closing the app.
    pub async fn local(change: impl FnOnce(&mut LocalOptions)) -> (Self, LocalApp) {
        let web_root = web_root();
        let mut options = local_options(web_root.path());
        change(&mut options);
        let local = LocalApp::open(options).unwrap();
        local.start();
        let session = LocalSession::new(ORIGIN);
        let app = session
            .protect(local.router())
            .layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50_000))));
        let launch_url = session.launch_url();
        let mut server = Self {
            app,
            state: local.state().clone(),
            session,
            launch_url,
            cookie: None,
            web_root,
        };
        server.login().await;
        (server, local)
    }

    /// Redeems the launch link for the session cookie.
    async fn login(&mut self) {
        let launch = self.launch_path();
        let reply = self.request(&launch, Init::default().header("origin", None)).await;
        assert_eq!(reply.status, 200, "the launch link was refused");
        self.cookie = Some(reply.cookies()[0].split(';').next().unwrap().to_owned());
    }

    /// The routes of [`base_router`], without the collector's, behind the session and the rate limit, with no hosted
    /// service unless `cloud_url` is given, serving a web root holding `index.html` and `assets/contract.js`. `login`
    /// redeems the launch link first.
    pub async fn start(cloud_url: Option<&str>, login: bool) -> Self {
        let web_root = web_root();
        let client: Arc<dyn HttpClient> = Arc::new(ReqwestClient::new().unwrap());
        let state = LocalState::new(
            memory_store(),
            Arc::new(MemorySecretStore::default()),
            client,
            cloud_url,
        )
        .unwrap();
        let session = LocalSession::new(ORIGIN);
        let app = base_router(web_root.path(), None, Router::new(), state.clone());
        let app = session
            .protect(app)
            .layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50_000))));
        let launch_url = session.launch_url();
        let mut server = Self {
            app,
            state,
            session,
            launch_url,
            cookie: None,
            web_root,
        };
        if login {
            server.login().await;
        }
        server
    }

    /// The launch link's path and query.
    pub fn launch_path(&self) -> String {
        self.launch_url.strip_prefix(ORIGIN).unwrap().to_owned()
    }

    pub async fn get(&self, path: &str) -> Reply {
        self.request(path, Init::default()).await
    }

    pub async fn request(&self, path: &str, init: Init) -> Reply {
        let (method, headers, body) = init.outgoing(ORIGIN, self.cookie.as_ref());
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(
                HeaderName::try_from(name).unwrap(),
                HeaderValue::try_from(value).unwrap(),
            );
        }
        if let Some(body) = &body {
            request = request.header("content-length", body.len());
        }
        let request = request.body(Body::from(body.unwrap_or_default())).unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let text = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            headers,
            text: String::from_utf8(text.to_vec()).unwrap(),
        }
    }

    /// The status fields this crate owns, shaped as `GET /api/local/status` reports them.
    pub async fn status(&self) -> Value {
        let mut status = serde_json::to_value(self.state.sync.status()).unwrap();
        let linked = self.state.sync.secrets().get().await.unwrap().is_some();
        status["cloudLinked"] = linked.into();
        status
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The `contract-server` binary on loopback TCP, started as `tests/contract/runner.ts` starts it.

/// The `contract-server` process: local mode on a free loopback port, with a fresh database, a `HOME` and a web root
/// holding `index.html` and `assets/contract.js` of its own, no pricing download, the hourly cycle, no hosted service
/// and nothing else of this environment. Requests go over TCP as the runner sends them. Killed when dropped.
pub struct Process {
    child: Child,
    /// `http://127.0.0.1:PORT`.
    pub origin: String,
    pub launch_url: String,
    pub cookie: Option<String>,
    /// The server's `HOME`, as its real path; the tools' usual folders are below it.
    pub home: PathBuf,
    client: reqwest::Client,
    directory: tempfile::TempDir,
}

impl Process {
    /// Starts the binary and reads its launch link; `login` redeems it for the session cookie.
    pub async fn start(login: bool) -> Self {
        let directory = web_root();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let home = root.join("home");
        std::fs::create_dir(&home).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_contract-server"))
            .env_clear()
            .env("HOME", &home)
            .env("TOKENTRACKY_MODE", "local")
            .env("PORT", "0")
            .env("TOKENTRACKY_DATABASE_PATH", root.join("data").join("usage.sqlite"))
            .env("TOKENTRACKY_PRICING_REFRESH", "off")
            .env("TOKENTRACKY_WEB_ROOT", &root)
            .env("TOKENTRACKY_REFRESH_INTERVAL_MS", "3600000")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let first = lines
            .next()
            .expect("the server exited before printing a launch link")
            .unwrap();
        // Keep reading what it prints, so that no later line meets a closed pipe.
        std::thread::spawn(move || lines.for_each(drop));
        let launch_url = first.rsplit(' ').next().unwrap().to_owned();
        let origin = launch_url.split("/?launch=").next().unwrap().to_owned();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        let mut process = Self {
            child,
            origin,
            launch_url,
            cookie: None,
            home,
            client,
            directory,
        };
        if login {
            let launch = process.launch_path();
            let reply = process.request(&launch, Init::default().header("origin", None)).await;
            assert_eq!(reply.status, 200, "the launch link was refused");
            process.cookie = Some(reply.cookies()[0].split(';').next().unwrap().to_owned());
        }
        process
    }

    /// The launch link's path and query.
    pub fn launch_path(&self) -> String {
        self.launch_url.strip_prefix(&self.origin).unwrap().to_owned()
    }

    pub async fn get(&self, path: &str) -> Reply {
        self.request(path, Init::default()).await
    }

    pub async fn request(&self, path: &str, init: Init) -> Reply {
        let (method, headers, body) = init.outgoing(&self.origin, self.cookie.as_ref());
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut request = self.client.request(method, format!("{}{path}", self.origin));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request.send().await.unwrap();
        let (status, headers) = (response.status().as_u16(), response.headers().clone());
        Reply {
            status,
            headers,
            text: response.text().await.unwrap(),
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `expectError`: the JSON content type and exactly `{error:{code,message}}` with a non-empty message.
#[track_caller]
pub fn expect_error(reply: &Reply, status: u16, code: &str) {
    assert!(
        reply
            .header("content-type")
            .is_some_and(|value| value.starts_with("application/json")),
        "content type of {} {}",
        reply.status,
        reply.text
    );
    let body = reply.json();
    let message = body["error"]["message"].as_str().unwrap_or("").to_owned();
    assert!(message.chars().any(|c| !c.is_whitespace()), "empty message: {body}");
    assert_eq!(
        (reply.status, body),
        (status, json!({"error": {"code": code, "message": message}})),
        "expected {status} {code}"
    );
}

/// The security headers of every answer, JSON errors included (HTML pages and the launch page differ only in CSP).
pub const SECURITY_HEADERS: [(&str, &str); 5] = [
    (
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ),
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("cache-control", "no-store"),
    ("permissions-policy", "camera=(), microphone=(), geolocation=()"),
];

/// An ISO timestamp as `Date.prototype.toISOString` writes it.
pub fn is_iso(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        let bytes = text.as_bytes();
        bytes.len() == 24
            && text.ends_with('Z')
            && bytes.iter().enumerate().all(|(index, &c)| match index {
                4 | 7 => c == b'-',
                10 => c == b'T',
                13 | 16 => c == b':',
                19 => c == b'.',
                23 => c == b'Z',
                _ => c.is_ascii_digit(),
            })
    })
}

/// A lowercase UUID.
pub fn is_uuid(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 36
            && text.char_indices().all(|(index, c)| match index {
                8 | 13 | 18 | 23 => c == '-',
                _ => c.is_ascii_digit() || ('a'..='f').contains(&c),
            })
    })
}
