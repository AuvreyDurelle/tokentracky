//! The local HTTP API. One axum router serves both transports: the Mac app calls it in-process;
//! the CLI binds it to loopback TCP behind [`LocalSession`].
//!
//! # The app and its two transports
//!
//! ```ignore
//! let app = LocalApp::open(LocalOptions {
//!     database_path, web_root, cloud_url, secrets, client: Arc::new(ReqwestClient::new()?),
//!     pricing_refresh: true, initially_paused: false, refresh_interval_ms: None, on_refresh: Some(menu_bar),
//!     detected: detect_tools(env, &home), claude_config_file: Some(claude_config_file(env, &home)),
//! })?;
//!
//! // In-process (Mac app): no session; pass requests to the router directly, and start the refresh cycle.
//! app.router().oneshot(request).await;
//! app.start();
//! // ... app.refresh(), app.overview(), app.set_paused(true), app.wake(); finally app.close().await?.
//!
//! // TCP (CLI `serve`): binds loopback, puts the router behind a `LocalSession` and starts the cycle.
//! let server = serve_tcp(app, port).await?;
//! println!("Open your private workspace: {}", server.launch_url());
//! // ... on SIGINT or SIGTERM:
//! server.close().await?;
//! ```
//!
//! [`serve_from_env`] does the same up to that `println!`, from environment variables; the `contract-server` binary
//! prints the launch link and closes on a signal, for `CONTRACT_SERVER_CMD`.
//!
//! # Shared state
//!
//! [`LocalState`] holds the store, [`CloudSync`], [`DeviceConnect`], the configured hosted origin, the one
//! [`HttpClient`] all network I/O goes through ([`ReqwestClient`] in production) and, from [`LocalApp::open`], the
//! collector's handles: the ingestion service, the refresh scheduler, the price table, the pause flag, the cached
//! weekly rank and the last cycle's overview. The [`UsageStore`] and the ingestion service are synchronous, so handlers
//! run them on the blocking pool; the store is shared as `Arc<Mutex<UsageStore>>` and locked for one store call at a
//! time.
//!
//! The router is [`base_router`] with the collector-backed `/api/local/*` routes as its `local`. `base_router` merges
//! `local` before it applies its layers, so those routes get the security headers, the error shapes, the body limits
//! and the rate limit; a route of `local` that clashes with one of the base routes panics at startup, as does a
//! fallback on `local`. In handlers: read bodies with [`JsonBody`] (a route with a smaller limit adds
//! `DefaultBodyLimit::max(..)`, as `PUT /api/local/cloud` and `/sources/{id}` do), check fields with [`object`],
//! refuse with [`LocalError`].
//!
//! The rate limit counts only requests carrying `ConnectInfo<SocketAddr>`, which [`serve_tcp`] adds. The 30-second
//! request timeout is Node's `requestTimeout`, a limit on receiving the request, not on handling it: [`JsonBody`]
//! enforces it for bodies and [`serve_tcp`] for headers, with hyper's `header_read_timeout`.
//!
//! # Deliberate differences from the earlier TypeScript implementation (`tests/contract/README.md`)
//!
//! 1. `PUT /api/local/cloud` when the linked service cannot be reached or answers unreadably: 502 `SYNC_FAILED`
//!    ("Hosted publication settings are unavailable."), not the earlier 500 `INTERNAL_ERROR`.
//! 2. `GET /api/local/export` with an invalid query (collector routes): answer the JSON error only; set the CSV
//!    `Content-Type` and `Content-Disposition` on success only.
//! 3. `POST /api/local/sync` with nothing linked: still 409 `CLOUD_NOT_LINKED`, but it records no `syncError`.
mod app;
mod body;
mod connect;
mod error;
mod http;
mod limits;
mod link;
mod local;
mod server;
mod session;
mod sync;

pub use app::{
    BODY_LIMIT, LocalState, PROXY_TIMEOUT, RATE_LIMIT, RATE_WINDOW, base_router, content_security_policy, secure,
};
pub use body::{JsonBody, REQUEST_TIMEOUT};
pub use connect::{
    ConnectStart, ConnectStatus, DeviceConnect, default_device_name, hashed_machine_id, machine_id, platform_uuid,
};
pub use error::{JSON, LocalError, json, object};
pub use http::{BoxFuture, HttpClient, HttpError, HttpRequest, HttpResponse, ReqwestClient};
pub use link::{
    CloudLink, DEFAULT_CLOUD_ORIGIN, LinkInput, MemorySecretStore, Scope, SecretError, SecretStore, broader,
    cloud_origin, cutoff, upload_buckets, validate_cloud_link,
};
pub use server::{
    LocalApp, LocalOptions, LocalOverview, LocalServer, OpenError, PricingDownload, serve_from_env, serve_tcp,
};
pub use session::{COOKIE, LAUNCH_TTL, LocalSession, MAX_LAUNCH_TOKENS};
pub use sync::{CHUNK, CloudSync, HOSTED_TIMEOUT, SyncStatus, Synced};

#[doc(no_inline)]
pub use tokentracky_collector::detect::{DetectedTool, detect_tools};
#[doc(no_inline)]
pub use tokentracky_collector::limits::claude_config_file;
#[doc(no_inline)]
pub use tokentracky_collector::store::UsageStore;
