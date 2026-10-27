//! The router shared by both transports (`baseApp` and the collector-independent routes of `startLocalServer` in
//! `apps/server/src/app.ts`): security headers, the uniform errors, body limits, the per-client rate limit, the web
//! build, health, the leaderboard and profile proxies (and, for the Mac app, the community, neighbour and rarity
//! proxies and likes), device connect, and the cloud link and sync routes.
use crate::body::JsonBody;
use crate::connect::{DeviceConnect, default_device_name, machine_id};
use crate::error::{JSON, LocalError, Relayed, json, shape_errors};
use crate::http::{HttpClient, HttpRequest};
use crate::link::{SecretStore, cloud_origin, validate_cloud_link};
use crate::local::Collection;
use crate::sync::{CloudSync, bearer};
use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokentracky_collector::store::UsageStore;
use tokio::time::Instant;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// The largest request body any route accepts (`PUT /api/local/cloud` allows 4 KiB).
pub const BODY_LIMIT: usize = 256_000;
/// Requests each client may make per window on the TCP transport.
pub const RATE_LIMIT: u64 = 240;
pub const RATE_WINDOW: Duration = Duration::from_secs(60);
/// The leaderboard and profile proxies give up after this long.
pub const PROXY_TIMEOUT: Duration = Duration::from_secs(10);

const NOT_CONFIGURED: LocalError = LocalError::new(
    503,
    "CLOUD_UNAVAILABLE",
    "The hosted leaderboard has not been configured. Private tracking is available.",
);
const LEADERBOARD_UNAVAILABLE: LocalError =
    LocalError::new(502, "CLOUD_UNAVAILABLE", "The hosted leaderboard could not be loaded.");
const LIKES_NOT_LINKED: LocalError = LocalError::new(
    409,
    "CLOUD_NOT_LINKED",
    "Link a publishing device before liking profiles.",
);
const LIKES_UNAVAILABLE: LocalError = LocalError::new(502, "CLOUD_UNAVAILABLE", "Hosted likes are unavailable.");
/// Pages the web app renders at their own addresses (`SPA_PAGES`; static hosting, `vercel.json`, rewrites the first six).
/// The last four are the Mac app's local-only pages and are not in `vercel.json`.
const SPA_PAGES: [&str; 10] = [
    "/privacy",
    "/terms",
    "/support",
    "/leaderboard",
    "/you",
    "/join",
    "/tokens",
    "/achievements",
    "/settings",
    "/popover",
];

/// Everything the routes share. Cheap to clone.
#[derive(Clone)]
pub struct LocalState {
    /// The hosted service from configuration (`TOKENTRACKY_CLOUD_URL`), as an origin. A saved link's wins.
    pub configured_remote: Option<String>,
    pub store: Arc<Mutex<UsageStore>>,
    pub sync: Arc<CloudSync>,
    pub connect: Arc<DeviceConnect>,
    /// The client of the proxies, also used by sync and connect.
    pub client: Arc<dyn HttpClient>,
    /// The collector's handles, which the collector-backed routes need (`LocalApp::open`); `None` from [`Self::new`].
    pub(crate) collection: Option<Arc<Collection>>,
}

impl LocalState {
    /// Wires sync and device connect (named after this machine) to one store, credential store and client.
    /// `cloud_url` must be a hosted origin, as `cloud_origin` accepts.
    pub fn new(
        store: Arc<Mutex<UsageStore>>,
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn HttpClient>,
        cloud_url: Option<&str>,
    ) -> Result<Self, LocalError> {
        let configured_remote = cloud_url.map(cloud_origin).transpose()?;
        let sync = CloudSync::new(store.clone(), secrets, client.clone());
        let connect = DeviceConnect::new(sync.clone(), client.clone(), default_device_name(None), machine_id());
        Ok(Self {
            configured_remote,
            store,
            sync,
            connect,
            client,
            collection: None,
        })
    }

    /// `remoteOrigin`: the linked service, else the configured one (also when the credential store fails).
    pub async fn remote_origin(&self) -> Option<String> {
        match self.sync.secrets().get().await {
            Ok(Some(link)) => cloud_origin(&link.url).ok().or_else(|| self.configured_remote.clone()),
            _ => self.configured_remote.clone(),
        }
    }
}

/// The Content-Security-Policy of every page and API answer; `auth_origin` (the hosted site's sign-in service, never
/// set for the local API) may also be connected to.
pub fn content_security_policy(auth_origin: Option<&str>) -> String {
    let auth = auth_origin.map(|origin| format!(" {origin}")).unwrap_or_default();
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'{auth}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
}

/// The security headers of every answer, where the answer has not set its own.
pub fn secure(headers: &mut HeaderMap, csp: &HeaderValue) {
    let values = [
        (header::CONTENT_SECURITY_POLICY, csp.clone()),
        (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        (header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
        (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        (
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
        ),
    ];
    for (name, value) in values {
        headers.entry(name).or_insert(value);
    }
}

/// The local API: the routes of this crate and `local` (the collector-backed `/api/local/*` routes, which must not
/// set a fallback), the web build from `web_root`, and the JSON 404 for everything else, all behind the security
/// headers, the uniform errors, the 256,000-byte body limit, a 30-second limit on receiving a body, and the rate
/// limit, which applies only to requests that carry `ConnectInfo<SocketAddr>` (the TCP transport).
///
/// The routes are the fallback service of an outer router that carries the shared layers, so those layers see the
/// final answer: `Router::layer` wraps each method handler, and axum adds `Allow` to a wrong-method answer after them.
pub fn base_router(
    web_root: impl Into<PathBuf>,
    auth_origin: Option<&str>,
    local: Router<LocalState>,
    state: LocalState,
) -> Router {
    let root = Arc::new(web_root.into());
    let csp = HeaderValue::try_from(content_security_policy(auth_origin)).expect("an origin is a header value");
    let page = |root: Arc<PathBuf>| move |request: Request| serve(root.join("index.html"), request);
    let limiter = Arc::new(RateLimiter::default());
    // Legal and support pages are rendered by the web app at their own addresses.
    let pages: Router<LocalState> = SPA_PAGES
        .into_iter()
        .fold(Router::new(), |pages, path| pages.route(path, get(page(root.clone()))));
    let routes = Router::new()
        .route("/api/health", get(health))
        .route("/api/local/connect", post(connect))
        .route("/api/local/connect/poll", post(poll))
        .route("/api/leaderboard", get(leaderboard))
        .route("/api/profiles/{alias}", get(profile))
        .route("/api/profiles/{alias}/stats", get(profile_stats))
        // For the Mac app's pages; the TypeScript server has none of these.
        .route("/api/community", get(community))
        .route("/api/leaderboard/around/{alias}", get(neighbours))
        .route("/api/achievements/rarity", get(rarity))
        .route("/api/local/likes/{alias}", get(like).put(like).delete(like))
        .route(
            "/api/local/cloud",
            put(link).layer(DefaultBodyLimit::max(4096)).delete(unlink),
        )
        .route("/api/local/sync", post(sync))
        .route("/", get(page(root.clone())))
        .merge(pages)
        // Public profiles have shareable addresses; the web app shows its own not-found state for unknown names.
        .route("/u/{alias}", {
            let root = root.clone();
            get(move |Path(alias): Path<String>, request: Request| public_profile(root.clone(), alias, request))
        })
        .route(
            "/assets/{*path}",
            get(move |Path(path): Path<String>, request: Request| asset(root.clone(), path, request)),
        )
        .merge(local)
        .fallback(|| async { LocalError::not_found() })
        .route_layer(middleware::from_fn_with_state(limiter, rate_limit))
        .with_state(state);
    Router::new()
        .fallback_service(routes)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn(shape_errors))
        .layer(middleware::map_response(move |mut response: Response| {
            let csp = csp.clone();
            async move {
                secure(response.headers_mut(), &csp);
                response
            }
        }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    mode: &'static str,
    auth_configured: bool,
    version: &'static str,
    cloud_url: Option<String>,
    supabase_url: Option<String>,
    supabase_anon_key: Option<String>,
    auth_providers: Vec<String>,
}

async fn health(State(state): State<LocalState>) -> Response {
    let health = Health {
        mode: "local",
        auth_configured: false,
        version: env!("CARGO_PKG_VERSION"),
        cloud_url: state.remote_origin().await,
        supabase_url: None,
        supabase_anon_key: None,
        auth_providers: Vec::new(),
    };
    json(StatusCode::OK, &health)
}

async fn connect(State(state): State<LocalState>, _: JsonBody) -> Result<Response, LocalError> {
    let remote = state.remote_origin().await.ok_or(NOT_CONFIGURED)?;
    Ok(json(StatusCode::OK, &state.connect.start(&remote).await?))
}

async fn poll(State(state): State<LocalState>, _: JsonBody) -> Result<Response, LocalError> {
    Ok(json(StatusCode::OK, &state.connect.poll().await?))
}

async fn link(State(state): State<LocalState>, JsonBody(body): JsonBody) -> Result<Response, LocalError> {
    state.sync.set_link(validate_cloud_link(body.as_ref())?).await?;
    Ok(json(StatusCode::OK, &json!({"linked": true})))
}

async fn unlink(State(state): State<LocalState>, _: JsonBody) -> Result<StatusCode, LocalError> {
    state.sync.unlink().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn sync(State(state): State<LocalState>, _: JsonBody) -> Result<Response, LocalError> {
    Ok(json(StatusCode::OK, &state.sync.sync().await?))
}

async fn leaderboard(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    proxy(&state, "/api/leaderboard", uri.query()).await
}

async fn profile(State(state): State<LocalState>, Path(alias): Path<String>, uri: Uri) -> Result<Response, LocalError> {
    profile_page(&state, &alias, "", uri.query()).await
}

async fn profile_stats(
    State(state): State<LocalState>,
    Path(alias): Path<String>,
    uri: Uri,
) -> Result<Response, LocalError> {
    profile_page(&state, &alias, "/stats", uri.query()).await
}

/// Relays `/api/profiles/:alias` followed by `page`.
async fn profile_page(
    state: &LocalState,
    alias: &str,
    page: &str,
    query: Option<&str>,
) -> Result<Response, LocalError> {
    proxy(state, &format!("/api/profiles/{}{page}", alias_segment(alias)?), query).await
}

/// The builders ranked either side of `alias`.
async fn neighbours(
    State(state): State<LocalState>,
    Path(alias): Path<String>,
    uri: Uri,
) -> Result<Response, LocalError> {
    let path = format!("/api/leaderboard/around/{}", alias_segment(&alias)?);
    proxy(&state, &path, uri.query()).await
}

async fn community(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    proxy(&state, "/api/community", uri.query()).await
}

async fn rarity(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    proxy(&state, "/api/achievements/rarity", uri.query()).await
}

/// Asks, gives or withdraws a like on the linked service as this device, relaying the answer as it is. The device
/// token goes only to the service that issued it, and never into an answer; HEAD is refused, not sent on.
async fn like(
    State(state): State<LocalState>,
    method: Method,
    Path(alias): Path<String>,
    _: JsonBody,
) -> Result<Response, LocalError> {
    if method == Method::HEAD {
        return Err(LocalError::not_found());
    }
    let path = format!("/api/profiles/{}/like", alias_segment(&alias)?);
    // A failing credential store has no link, as `linked()` reads it.
    let link = state
        .sync
        .secrets()
        .get()
        .await
        .ok()
        .flatten()
        .ok_or(LIKES_NOT_LINKED)?;
    let request = HttpRequest::new(method, format!("{}{path}", link.url), PROXY_TIMEOUT)
        .header(header::ACCEPT, "application/json")
        .header(header::AUTHORIZATION, bearer(&link.device_token));
    let response = state.client.send(request).await.map_err(|_| LIKES_UNAVAILABLE)?;
    if response.status == StatusCode::NO_CONTENT {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    if response.status.is_redirection() || serde_json::from_slice::<serde::de::IgnoredAny>(&response.body).is_err() {
        return Err(LIKES_UNAVAILABLE);
    }
    let mut reply = (response.status, [(header::CONTENT_TYPE, JSON)], response.body).into_response();
    reply.extensions_mut().insert(Relayed);
    Ok(reply)
}

/// An alias as a path segment of a hosted page.
fn alias_segment(alias: &str) -> Result<String, LocalError> {
    // Fastify's router matches decoded parameters of at most 100 UTF-16 units.
    if alias.encode_utf16().count() > 100 {
        return Err(LocalError::not_found());
    }
    Ok(encode_uri_component(alias))
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                char::from(byte).to_string()
            }
            byte => format!("%{byte:02X}"),
        })
        .collect()
}

/// Relays a hosted page as it is.
async fn proxy(state: &LocalState, path: &str, query: Option<&str>) -> Result<Response, LocalError> {
    let body = hosted(state, path, query).await?;
    Ok((StatusCode::OK, [(header::CONTENT_TYPE, JSON)], body).into_response())
}

/// The JSON of a hosted page, as the proxies fetch it: only single-valued query parameters, no credentials, no
/// redirects. A missing page is 404, any other failure 502, both `CLOUD_UNAVAILABLE`; with no hosted service, 503
/// before the query is read.
pub(crate) async fn hosted(state: &LocalState, path: &str, query: Option<&str>) -> Result<Vec<u8>, LocalError> {
    let remote = state.remote_origin().await.ok_or(NOT_CONFIGURED)?;
    let request = HttpRequest::new(
        Method::GET,
        format!("{remote}{path}?{}", forwarded(query)),
        PROXY_TIMEOUT,
    )
    .header(header::ACCEPT, "application/json");
    let response = state.client.send(request).await.map_err(|_| LEADERBOARD_UNAVAILABLE)?;
    if !response.ok() {
        let status = if response.status == StatusCode::NOT_FOUND {
            404
        } else {
            502
        };
        return Err(LocalError {
            status,
            ..LEADERBOARD_UNAVAILABLE
        });
    }
    serde_json::from_slice::<serde::de::IgnoredAny>(&response.body).map_err(|_| LEADERBOARD_UNAVAILABLE)?;
    Ok(response.body)
}

/// The query parameters the proxies forward, encoded as `URLSearchParams` encodes them.
fn forwarded(query: Option<&str>) -> String {
    let pairs: Vec<_> = url::form_urlencoded::parse(query.unwrap_or("").as_bytes()).collect();
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in &pairs {
        // A repeated key is an array to Fastify's query parser, and only strings are forwarded.
        if pairs.iter().filter(|(other, _)| other == key).count() == 1 {
            params.append_pair(key, value);
        }
    }
    params.finish()
}

/// The web app for `/u/:alias` when the alias matches `PROFILE_ALIAS`, `^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$`; else the JSON
/// 404.
async fn public_profile(root: Arc<PathBuf>, alias: String, request: Request) -> Response {
    let mut chars = alias.chars();
    let alias_pattern = (3..=30).contains(&alias.len())
        && chars.next().is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|rest| rest.is_ascii_alphanumeric() || rest == '_' || rest == '-');
    if !alias_pattern {
        return LocalError::not_found().into_response();
    }
    serve(root.join("index.html"), request).await
}

/// A file of the web build: `assets/` below the root, without dotfiles; `..` is refused as `send` refuses it.
async fn asset(root: Arc<PathBuf>, path: String, request: Request) -> Response {
    let mut file = root.join("assets");
    for segment in path.split(['/', '\\']).filter(|segment| !segment.is_empty()) {
        if segment == ".." {
            return LocalError::from_status(403).into_response();
        }
        let mut components = std::path::Path::new(segment).components();
        let normal = matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
        if segment.starts_with('.') || !normal {
            return LocalError::not_found().into_response();
        }
        file.push(segment);
    }
    serve(file, request).await
}

/// Serves a regular file with its type, `Last-Modified` and ranges, keeping the security headers; else the JSON 404.
async fn serve(file: PathBuf, request: Request) -> Response {
    if !tokio::fs::metadata(&file)
        .await
        .is_ok_and(|metadata| metadata.is_file())
    {
        return LocalError::not_found().into_response();
    }
    match ServeFile::new(file).oneshot(request).await {
        Ok(response) => response.map(Body::new),
        Err(never) => match never {},
    }
}

/// One client's fixed window, as `@fastify/rate-limit`'s in-memory store keeps it.
struct Window {
    count: u64,
    start: Instant,
}

#[derive(Default)]
struct RateLimiter(Mutex<HashMap<IpAddr, Window>>);

/// The rate limit of the TCP transport: 240 requests a minute per peer address, in fixed windows from each client's
/// first request, counting only requests that reach a route (the session and the 404 come first), with the
/// `x-ratelimit-*` headers and, once exceeded, 429 `RATE_LIMITED` and `retry-after`.
async fn rate_limit(State(limiter): State<Arc<RateLimiter>>, request: Request, next: Next) -> Response {
    let Some(ConnectInfo(peer)) = request.extensions().get::<ConnectInfo<SocketAddr>>().copied() else {
        return next.run(request).await;
    };
    let now = Instant::now();
    let (count, reset) = {
        let mut clients = limiter.0.lock().unwrap_or_else(PoisonError::into_inner);
        if clients.len() >= 5000 {
            clients.retain(|_, window| window.start + RATE_WINDOW > now);
        }
        let window = clients.entry(peer.ip()).or_insert(Window { count: 0, start: now });
        if window.start + RATE_WINDOW <= now {
            *window = Window { count: 0, start: now };
        }
        window.count += 1;
        let left = u64::try_from((window.start + RATE_WINDOW - now).as_millis()).unwrap_or(u64::MAX);
        (window.count, left.div_ceil(1000))
    };
    let mut response = if count > RATE_LIMIT {
        let mut response = LocalError::from_status(429).into_response();
        response.headers_mut().insert(header::RETRY_AFTER, reset.into());
        response
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert("x-ratelimit-limit", RATE_LIMIT.into());
    headers.insert("x-ratelimit-remaining", RATE_LIMIT.saturating_sub(count).into());
    headers.insert("x-ratelimit-reset", reset.into());
    response
}
