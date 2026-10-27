//! The local app and its TCP transport: the collector, cloud sync and the refresh cycle behind one router, which the
//! Mac app calls in-process and the CLI serves on loopback behind the session.
use crate::app::{LocalState, base_router};
use crate::body::REQUEST_TIMEOUT;
use crate::error::LocalError;
use crate::http::{HttpClient, HttpError, ReqwestClient};
use crate::link::{SecretStore, cloud_origin};
use crate::local::{Collection, js_number, local_routes};
use crate::session::LocalSession;
use axum::extract::ConnectInfo;
use axum::http::header;
use axum::{Extension, Router};
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use serde::Serialize;
use std::error::Error;
use std::future::Future;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokentracky_collector::detect::{DetectedTool, detect_tools};
use tokentracky_collector::limits::claude_config_file;
use tokentracky_collector::scheduler::{IntervalError, refresh_interval};
use tokentracky_collector::store::{PeriodTotals, StoreError};
use tokentracky_collector::{LocalCollector, LocalCollectorOptions, RefreshStatus, ServiceError};
use tokentracky_core::LocalSettings;
use tokentracky_pricing::{MAX_DOWNLOAD_BYTES, Transport, TransportError, pricing_refresh_enabled};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower::Layer;

/// What [`LocalApp::open`] is given. The port is not among them: it belongs to [`serve_tcp`].
pub struct LocalOptions {
    pub database_path: PathBuf,
    /// The web build: `index.html` and `assets/`.
    pub web_root: PathBuf,
    /// The hosted service from configuration (`TOKENTRACKY_CLOUD_URL`), an origin; a saved link's wins.
    pub cloud_url: Option<String>,
    /// Where the link and its device credential are kept.
    pub secrets: Arc<dyn SecretStore>,
    /// Every request to the hosted service goes through it.
    pub client: Arc<dyn HttpClient>,
    /// Allows the daily LiteLLM download.
    pub pricing_refresh: bool,
    pub initially_paused: bool,
    /// Defaults to an hour.
    pub refresh_interval_ms: Option<u64>,
    /// Given the new overview after every cycle, successful or not (the menu bar's title).
    pub on_refresh: Option<Arc<dyn Fn(LocalOverview) + Send + Sync>>,
    /// The supported tools found at their usual folders (`detect_tools`). While no source has ever been configured,
    /// opening turns on each one with a reader, at those folders, for the first cycle to read (the first run).
    /// Empty for the CLI's one-off commands, which turn nothing on.
    pub detected: Vec<DetectedTool>,
    /// Claude Code's own settings file (`claude_config_file`), whose cached usage-limit reading each scan takes while
    /// Claude Code is enabled, for `GET /api/local/limits`; `None` reads none.
    pub claude_config_file: Option<PathBuf>,
}

/// What the menu bar shows (`LocalOverview`): leaderboard-aligned totals, the public rank when published, the alias,
/// whether collection is paused, and the refresh times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOverview {
    #[serde(flatten)]
    pub totals: PeriodTotals,
    pub rank: Option<i64>,
    pub alias: Option<String>,
    pub paused: bool,
    #[serde(flatten)]
    pub refresh: RefreshStatus,
    /// What the menu bar item shows; read by the app, not served (`GET /api/local/settings` serves it).
    #[serde(skip)]
    pub settings: LocalSettings,
}

/// Why the local app could not open.
#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    /// The store or the ingestion service; `collector_database_locked` while another process owns the database.
    #[error(transparent)]
    Collector(#[from] ServiceError),
    /// `INVALID_CLOUD_URL`.
    #[error(transparent)]
    CloudUrl(#[from] LocalError),
    #[error(transparent)]
    Interval(#[from] IntervalError),
    /// The client of the pricing download could not be built.
    #[error(transparent)]
    Http(HttpError),
}

/// The daily LiteLLM download as `Transport` asks for it: one GET for JSON, no redirects or proxy, 20 seconds, and
/// at most `MAX_DOWNLOAD_BYTES`, checked against `Content-Length` first.
pub struct PricingDownload(reqwest::Client);

impl PricingDownload {
    pub fn new() -> Result<Self, HttpError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(20))
            .build()?;
        Ok(Self(client))
    }
}

impl Transport for PricingDownload {
    async fn fetch(&self, url: &str) -> Result<String, TransportError> {
        let mut response = self
            .0
            .get(url)
            .header(header::ACCEPT, "application/json")
            .send()
            .await?;
        let large = |length: u64| length > MAX_DOWNLOAD_BYTES as u64;
        if !response.status().is_success() || response.content_length().is_some_and(large) {
            return Err("pricing_download_failed".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if large((body.len() + chunk.len()) as u64) {
                return Err("pricing_download_failed".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(String::from_utf8_lossy(&body).into_owned())
    }
}

/// The local API with its collector, cloud sync and refresh cycle, without the listener.
/// [`Self::router`] is the in-process transport as it is; [`serve_tcp`] puts it on loopback behind a session.
pub struct LocalApp {
    state: LocalState,
    router: Router,
}

impl LocalApp {
    /// Opens the collector (taking the database's single-writer lock) and builds the router: the routes of
    /// [`base_router`] and the collector-backed `/api/local/*` routes. The refresh cycle waits for [`Self::start`].
    pub fn open(options: LocalOptions) -> Result<Self, OpenError> {
        // The hosted origin is checked before the database is opened, as in TypeScript.
        options.cloud_url.as_deref().map(cloud_origin).transpose()?;
        let collector = LocalCollector::open(LocalCollectorOptions {
            database_path: options.database_path.clone(),
            pricing_refresh: options.pricing_refresh,
            transport: PricingDownload::new().map_err(OpenError::Http)?,
            claude_config_file: options.claude_config_file.clone(),
        })?;
        let web_root = options.web_root.clone();
        let state = LocalState::with_collector(collector, options)?;
        let router = base_router(web_root, None, local_routes(), state.clone());
        Ok(Self { state, router })
    }

    pub fn state(&self) -> &LocalState {
        &self.state
    }
    fn collection(&self) -> &Arc<Collection> {
        self.state.collection()
    }

    /// The whole local API, without the session: pass requests to it directly (`router.oneshot(request)`).
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    /// Starts the refresh cycle: a cycle now when a source is enabled and collection runs, then every interval.
    pub fn start(&self) {
        self.collection().scheduler.start();
    }

    /// Runs one full cycle, or joins the one in flight, and answers the overview after it. While collection is
    /// paused, 409 `COLLECTION_PAUSED`; a failed scan or store is 500 `INTERNAL_ERROR`, as the API answers them.
    pub async fn refresh(&self) -> Result<LocalOverview, LocalError> {
        self.collection().cycle().await?;
        self.overview().await
    }

    pub async fn overview(&self) -> Result<LocalOverview, LocalError> {
        self.collection().overview(&self.state.sync).await
    }

    /// After sleep: a cycle when the last one is older than 15 minutes.
    pub fn wake(&self) {
        self.collection().scheduler.wake();
    }

    /// Pauses or resumes collection, as `PUT /api/local/collection` does: changes apply one at a time in call order,
    /// pausing waits for a scan in flight, and resuming starts a cycle.
    pub fn set_paused(&self, paused: bool) -> impl Future<Output = ()> + Send + 'static {
        self.collection().set_paused(paused)
    }

    /// `onClose`: stops the refresh cycle (letting a cycle in flight finish), then cloud sync, waits for a scan in
    /// flight, and closes the store, releasing the database's lock. Every router clone must be dropped first.
    pub async fn close(self) -> Result<(), StoreError> {
        let local = self.collection().clone();
        local.scheduler.stop().await;
        self.state.sync.stop().await;
        let collector = local.collector.clone();
        drop((self, local));
        // Tasks that have just finished may still be dropping their handles (the collector holds one on the store,
        // its ingestion service another): wait for them, so the lock is free once this returns.
        for _ in 0..200 {
            let store = Arc::strong_count(collector.store());
            if Arc::strong_count(&collector) == 1 && Arc::strong_count(collector.service()) == 1 && store == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let close = tokio::task::spawn_blocking(move || match Arc::try_unwrap(collector) {
            Ok(collector) => collector.close(),
            // Still held after a second: the store closes when that lets go.
            Err(collector) => {
                collector.service().stop();
                Ok(())
            }
        });
        close
            .await
            .unwrap_or_else(|error| std::panic::resume_unwind(error.into_panic()))
    }
}

/// The local app on loopback TCP behind its session.
pub struct LocalServer {
    app: LocalApp,
    session: LocalSession,
    url: String,
    shutdown: CancellationToken,
    serving: JoinHandle<()>,
}

impl LocalServer {
    /// `http://127.0.0.1:PORT`.
    pub fn url(&self) -> &str {
        &self.url
    }
    /// A fresh one-use launch link.
    pub fn launch_url(&self) -> String {
        self.session.launch_url()
    }
    pub fn session(&self) -> &LocalSession {
        &self.session
    }
    pub fn app(&self) -> &LocalApp {
        &self.app
    }
    /// Stops listening, closes idle connections, lets the requests in flight finish, then closes the app.
    pub async fn close(self) -> Result<(), StoreError> {
        self.shutdown.cancel();
        let _ = self.serving.await;
        self.app.close().await
    }
}

/// Serves `app` on `127.0.0.1:port` (0 for any free port) behind a [`LocalSession`] for that origin, with the peer
/// address for the rate limit and Node's 30-second limit on receiving the headers, then starts the refresh cycle.
/// HTTP/1.1 only, as Node serves. If the port cannot be bound, the app is closed and the error returned.
pub async fn serve_tcp(app: LocalApp, port: u16) -> std::io::Result<LocalServer> {
    let bound = match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
        Ok(listener) => listener.local_addr().map(|address| (listener, address)),
        Err(error) => Err(error),
    };
    let (listener, address) = match bound {
        Ok(bound) => bound,
        Err(error) => {
            let _ = app.close().await;
            return Err(error);
        }
    };
    let url = format!("http://{address}");
    let session = LocalSession::new(&url);
    let shutdown = CancellationToken::new();
    let serving = tokio::spawn(accept(listener, session.protect(app.router()), shutdown.clone()));
    app.start();
    Ok(LocalServer {
        app,
        session,
        url,
        shutdown,
        serving,
    })
}

async fn accept(listener: TcpListener, router: Router, shutdown: CancellationToken) {
    let graceful = GracefulShutdown::new();
    let mut http = http1::Builder::new();
    // `JsonBody` bounds the body by the same limit.
    http.timer(TokioTimer::new()).header_read_timeout(REQUEST_TIMEOUT);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = shutdown.cancelled() => break,
        };
        let Ok((stream, peer)) = accepted else {
            // Out of descriptors and the like: give connections time to close, as `axum::serve` does.
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let service = TowerToHyperService::new(Extension(ConnectInfo(peer)).layer(router.clone()));
        let connection = graceful.watch(http.serve_connection(TokioIo::new(stream), service));
        tokio::spawn(async move {
            let _ = connection.await;
        });
    }
    drop(listener);
    graceful.shutdown().await;
}

/// The local server up to the launch link, from the environment: the app from `TOKENTRACKY_DATABASE_PATH` (default
/// `.runtime/usage.sqlite`), `TOKENTRACKY_WEB_ROOT` (default `apps/web/dist`), `TOKENTRACKY_CLOUD_URL`,
/// `TOKENTRACKY_REFRESH_INTERVAL_MS` and `TOKENTRACKY_PRICING_REFRESH`, with the link kept in `secrets`, served on
/// `PORT` (default 0) and started. `TOKENTRACKY_MODE` may only be `local`. Detection reads `HOME` and the tools' own
/// variables at launch, for the first run, and on each request; Claude Code's `.claude.json` is found at launch.
pub async fn serve_from_env(secrets: Arc<dyn SecretStore>) -> Result<LocalServer, Box<dyn Error + Send + Sync>> {
    let var = |key: &str| std::env::var(key).ok();
    let web_root = std::path::absolute(var("TOKENTRACKY_WEB_ROOT").unwrap_or_else(|| "apps/web/dist".into()))?;
    if var("TOKENTRACKY_MODE").is_some_and(|mode| mode != "local") {
        return Err("TOKENTRACKY_MODE must be local".into());
    }
    let port = js_number(&var("PORT").unwrap_or_else(|| "0".into()));
    if port.fract() != 0.0 || !(0.0..=65535.0).contains(&port) {
        return Err("PORT must be an integer between 0 and 65535".into());
    }
    let database = var("TOKENTRACKY_DATABASE_PATH").unwrap_or_else(|| ".runtime/usage.sqlite".into());
    let home = std::env::home_dir().unwrap_or_default();
    let options = LocalOptions {
        database_path: std::path::absolute(database)?,
        web_root,
        cloud_url: var("TOKENTRACKY_CLOUD_URL").filter(|url| !url.is_empty()),
        secrets,
        client: Arc::new(ReqwestClient::new()?),
        pricing_refresh: pricing_refresh_enabled(var("TOKENTRACKY_PRICING_REFRESH").as_deref()),
        initially_paused: false,
        refresh_interval_ms: Some(refresh_interval(var("TOKENTRACKY_REFRESH_INTERVAL_MS").as_deref())?),
        on_refresh: None,
        detected: detect_tools(var, &home),
        claude_config_file: Some(claude_config_file(var, &home)),
    };
    Ok(serve_tcp(LocalApp::open(options)?, port as u16).await?)
}
