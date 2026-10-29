//! How other commands reach a running `serve`, which may have no terminal (the background job of `login`): it listens
//! on a second loopback port for a fresh dashboard link and for a request to stop, and leaves that port's address and
//! a random token in `serve.json` in the data folder, readable only by the user. `open`, `login` and `uninstall` use it.
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::post;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokentracky_local_api::{HttpClient, HttpRequest, LocalSession, ReqwestClient};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

const FILE: &str = "serve.json";
/// A `serve` that does not answer in this time is not running.
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize, Deserialize)]
struct Address {
    url: String,
    token: String,
}

#[derive(Clone)]
struct Shared {
    token: String,
    session: LocalSession,
    stop: Arc<Notify>,
}

/// The listener and its file, until [`Control::close`].
pub struct Control {
    file: PathBuf,
    shutdown: Arc<Notify>,
    serving: JoinHandle<()>,
}

/// Starts answering for the dashboard of `session`; a request to stop wakes `stop`.
pub async fn listen(directory: &Path, session: LocalSession, stop: Arc<Notify>) -> std::io::Result<Control> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).map_err(std::io::Error::other)?;
    let token = hex::encode(random);
    let address = Address {
        url: format!("http://{}", listener.local_addr()?),
        token: token.clone(),
    };
    let file = directory.join(FILE);
    write_private(&file, &serde_json::to_vec(&address).map_err(std::io::Error::other)?)?;
    let router = Router::new()
        .route("/launch", post(launch))
        .route("/stop", post(stop_serving))
        .with_state(Shared { token, session, stop });
    let shutdown = Arc::new(Notify::new());
    let ended = shutdown.clone();
    let serving = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { ended.notified().await })
            .await;
    });
    Ok(Control {
        file,
        shutdown,
        serving,
    })
}

impl Control {
    /// Stops listening and removes the file.
    pub async fn close(self) {
        self.shutdown.notify_one();
        let _ = self.serving.await;
        let _ = std::fs::remove_file(&self.file);
    }
}

/// Created afresh, readable and writable by the owner only (the data folder is the owner's alone on Windows).
fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let _ = std::fs::remove_file(file);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(file)?.write_all(bytes)
}

fn authorized(shared: &Shared, headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| bool::from(token.as_bytes().ct_eq(shared.token.as_bytes())))
}

async fn launch(State(shared): State<Shared>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&shared, &headers) {
        return (StatusCode::UNAUTHORIZED, String::new());
    }
    (StatusCode::OK, shared.session.launch_url())
}

async fn stop_serving(State(shared): State<Shared>, headers: HeaderMap) -> StatusCode {
    if !authorized(&shared, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    shared.stop.notify_one();
    StatusCode::ACCEPTED
}

/// Sends `action` to the `serve` that wrote the data folder's file; its answer when it accepted.
async fn ask(directory: &Path, action: &str) -> Option<String> {
    let address: Address = serde_json::from_slice(&std::fs::read(directory.join(FILE)).ok()?).ok()?;
    let request = HttpRequest::new(Method::POST, format!("{}/{action}", address.url), TIMEOUT)
        .header(header::AUTHORIZATION, format!("Bearer {}", address.token));
    let response = ReqwestClient::new().ok()?.send(request).await.ok()?;
    response.ok().then(|| String::from_utf8(response.body).ok()).flatten()
}

/// A fresh one-use link to the running dashboard; `None` when no `serve` answers.
pub async fn launch_url(directory: &Path) -> Option<String> {
    ask(directory, "launch")
        .await
        .filter(|url| url.starts_with("http://127.0.0.1:"))
}

/// Asks the running `serve` to stop at once, without waiting for the refresh in flight: for `uninstall`, which deletes
/// the data next. False when none answers.
pub async fn stop(directory: &Path) -> bool {
    ask(directory, "stop").await.is_some()
}
