//! The collector-backed routes (`apps/server/src/local-routes.ts`, and `PUT /api/local/collection`, the pause switch
//! and the weekly rank of `startLocalServer` in `app.ts`): status, detection, source authorisation, refresh, pause,
//! the usage queries and the CSV export, the Rust-only local days (F3): a `tz` on the usage queries and
//! `GET /api/local/day`, the Rust-only usage limits (F6): `GET /api/local/limits`, and, for the Mac app's pages, the
//! cached overview and the Rust-only last 24 hours: `since`/`until` on the usage queries and `GET /api/local/hours`.
//! Collector and store calls are synchronous, so they run on the blocking pool, and only there is the store held.
use crate::app::{LocalState, encode_uri_component, hosted};
use crate::body::JsonBody;
use crate::error::{LocalError, json, object};
use crate::link::is_js_space;
use crate::server::{LocalOptions, LocalOverview, OpenError, PricingDownload};
use crate::sync::{CloudSync, SyncStatus};
use axum::Router;
use axum::extract::{DefaultBodyLimit, FromRequest, Path, Request, State};
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use jiff::tz::TimeZone;
use serde::Serialize;
use serde_json::{Map, Value};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::Duration;
use time::{Date, OffsetDateTime};
use tokentracky_collector::detect::{DetectedTool, default_source_paths, detect_tools};
use tokentracky_collector::git_remote::project_repository;
use tokentracky_collector::readers::adapter;
use tokentracky_collector::scheduler::{BoxFuture, RetryAfter, Step, StepError};
use tokentracky_collector::store::{QueryOptions, SourceConfiguration, StoreError, UsageStore};
use tokentracky_collector::{LocalCollector, RefreshError, RefreshScheduler, RefreshStatus, ServiceError};
use tokentracky_core::{
    MAX_SAFE_INTEGER, MenuOverview, ProjectSummary, SourceState, SourceStatus, ToolId, TopTool, is_utc_day,
};
use tokio::sync::watch;

const SOURCE_NOT_FOUND: LocalError = LocalError::new(404, "SOURCE_NOT_FOUND", "Unknown tool.");
const INVALID_PATHS: LocalError = LocalError::new(400, "INVALID_PATHS", "Choose up to 20 absolute source paths.");
const SOURCE_UNAVAILABLE: LocalError = LocalError::new(
    400,
    "SOURCE_UNAVAILABLE",
    "The selected source paths are unavailable. Check the paths and permissions.",
);
const COLLECTION_PAUSED: LocalError = LocalError::new(
    409,
    "COLLECTION_PAUSED",
    "Resume collection from the desktop tray before refreshing.",
);
/// The scheduler's own refusal, for a pause that lands after the route's check.
const CYCLE_PAUSED: LocalError = LocalError::new(409, "COLLECTION_PAUSED", "Resume collection before refreshing.");
const INVALID_PAUSE: LocalError = LocalError::new(400, "INVALID_REQUEST", "Choose whether collection is paused.");
const INVALID_FILTER: LocalError =
    LocalError::new(400, "INVALID_FILTER", "Choose a supported reporting period and tool.");
const RANGE_DAYS: [f64; 4] = [7.0, 30.0, 90.0, 365.0];
const QUARTER_HOUR_MS: i64 = 15 * 60_000;
/// How long the status waits for a cycle in flight.
const SETTLE: Duration = Duration::from_secs(1);

/// The collector's handles, shared by the collector-backed routes, the refresh cycle and `LocalApp`.
pub(crate) struct Collection {
    pub(crate) collector: Arc<LocalCollector<PricingDownload>>,
    pub(crate) scheduler: RefreshScheduler,
    /// True from a cycle's scan until it publishes, after `refreshing` is cleared.
    cycling: Arc<watch::Sender<bool>>,
    paused: Arc<AtomicBool>,
    /// Settles once the latest pause change has applied; the next change waits for it (`collectionChange`).
    change: Mutex<watch::Receiver<bool>>,
    /// The published rank this week, looked up after every cycle.
    rank: Mutex<Option<i64>>,
    /// The overview of the last cycle, or of the first request since one when nothing listens to the cycle, with the
    /// UTC day it was computed on.
    cached_overview: Mutex<Option<(Date, LocalOverview)>>,
    /// This launch turned on the tools it found (the first run).
    first_run: bool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs synchronous collector work on the blocking pool; a panic there is a 500.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, LocalError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| LocalError::internal())
}

/// `linked()`: a link is saved; a failing credential store has none.
async fn is_linked(sync: &CloudSync) -> bool {
    sync.secrets().get().await.is_ok_and(|link| link.is_some())
}

impl LocalState {
    /// [`Self::new`] over the collector's store, with the handles of the collector-backed routes and a refresh
    /// scheduler, not yet started, whose cycle syncs when linked and then looks up the weekly rank.
    pub(crate) fn with_collector(
        collector: LocalCollector<PricingDownload>,
        options: LocalOptions,
    ) -> Result<Self, OpenError> {
        let mut state = Self::new(
            collector.store().clone(),
            options.secrets,
            options.client,
            options.cloud_url.as_deref(),
        )?;
        let paused = Arc::new(AtomicBool::new(options.initially_paused));
        let sync = state.sync.clone();
        let step: Step = Box::new(move || {
            let sync = sync.clone();
            Box::pin(async move {
                match sync.sync().await {
                    Ok(_) => Ok(()),
                    // The cycle's backoff honours the hosted service's deadline.
                    Err(error) => Err(match sync.retry_after() {
                        Some(delay) => Box::new(RetryAfter(delay)) as StepError,
                        None => Box::new(error) as StepError,
                    }),
                }
            })
        });
        let sync = state.sync.clone();
        let linked = Box::new(move || -> BoxFuture<bool> {
            let sync = sync.clone();
            Box::pin(async move { is_linked(&sync).await })
        });
        let check = paused.clone();
        let mut refresh = collector.refresh_options(step, linked, Box::new(move || check.load(Ordering::SeqCst)));
        refresh.interval_ms = options.refresh_interval_ms;
        // A cycle starts with its scan and ends when it publishes.
        let cycling = Arc::new(watch::channel(false).0);
        let (scan, started) = (refresh.scan, cycling.clone());
        refresh.scan = Box::new(move || {
            started.send_replace(true);
            scan()
        });
        // The scheduler exists before its collection does, so its hook finds the collection here.
        let published: Arc<OnceLock<Weak<Collection>>> = Arc::default();
        let (slot, base, callback, ended) = (published.clone(), state.clone(), options.on_refresh, cycling.clone());
        refresh.on_refresh = Some(Box::new(move || -> BoxFuture<()> {
            ended.send_replace(false);
            let (local, state, callback) = (slot.get().and_then(Weak::upgrade), base.clone(), callback.clone());
            Box::pin(async move {
                let Some(local) = local else { return };
                let last = *lock(&local.rank);
                let rank = weekly_rank(&state, last).await;
                *lock(&local.rank) = rank;
                // With nothing listening (the CLI), the next overview request makes the pass over the usage.
                let Some(callback) = callback else {
                    *lock(&local.cached_overview) = None;
                    return;
                };
                let day = OffsetDateTime::now_utc().date();
                let overview = local.overview(&state.sync).await.ok();
                *lock(&local.cached_overview) = overview.clone().map(|overview| (day, overview));
                if let Some(overview) = overview {
                    callback(overview);
                }
            })
        }));
        let scheduler = RefreshScheduler::new(refresh)?;
        let first_run = set_up(&collector, &options.detected)?;
        add_found_folders(&collector, &options.detected)?;
        let collection = Arc::new(Collection {
            collector: Arc::new(collector),
            scheduler,
            cycling,
            paused,
            change: Mutex::new(watch::channel(true).1),
            rank: Mutex::new(None),
            cached_overview: Mutex::new(None),
            first_run,
        });
        let _ = published.set(Arc::downgrade(&collection));
        state.collection = Some(collection);
        Ok(state)
    }

    /// The collector's handles. Only states from [`Self::with_collector`] serve the collector-backed routes.
    pub(crate) fn collection(&self) -> &Arc<Collection> {
        self.collection
            .as_ref()
            .expect("the collector-backed routes are served with LocalState::with_collector")
    }
}

/// The first run (`setupCompleted`): while no source has ever been configured, turns on each detected tool that has a
/// reader, at the folders found, and records that setup is done, so a tool turned off later stays off. An
/// install with a configured source is recorded as set up and keeps its choices. With nothing turned on nothing is
/// recorded, and a later launch looks again. True when it turned tools on.
fn set_up(collector: &LocalCollector<PricingDownload>, detected: &[DetectedTool]) -> Result<bool, ServiceError> {
    let store = collector.store();
    if lock(store).setup_completed()? {
        return Ok(false);
    }
    let configured = lock(store)
        .source_statuses()?
        .iter()
        .any(|source| !matches!(source.state, SourceState::PermissionRequired | SourceState::Unsupported));
    let readable = |tool: &&DetectedTool| adapter(tool.id).is_some();
    let mut enabled = false;
    if !configured {
        for tool in detected.iter().filter(readable) {
            let configuration = SourceConfiguration {
                enabled: true,
                paths: tool.paths.clone(),
            };
            // A folder gone since it was found is left for the user to choose.
            enabled |= collector.service().configure_source(tool.id, &configuration).is_ok();
        }
    }
    if configured || enabled {
        lock(store).complete_setup()?;
    }
    Ok(enabled)
}

/// Gives each enabled tool the folders found since it was set up (a tool home created later, such as T3 Code's
/// profiles), each once: a folder removed by hand stays removed.
fn add_found_folders(
    collector: &LocalCollector<PricingDownload>,
    detected: &[DetectedTool],
) -> Result<(), ServiceError> {
    let store = collector.store();
    let mut offered = lock(store).offered_folders()?;
    let sources = lock(store).source_statuses()?;
    let before = offered.len();
    for tool in detected {
        let Some(source) = sources.iter().find(|source| source.id == tool.id && source.enabled) else {
            continue;
        };
        let found: Vec<String> = tool
            .paths
            .iter()
            .filter_map(|path| std::fs::canonicalize(path).ok())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let new: Vec<String> = found
            .iter()
            .filter(|path| !source.paths.contains(path) && !offered.contains(path))
            .cloned()
            .collect();
        let configuration = SourceConfiguration {
            enabled: true,
            paths: [source.paths.clone(), new.clone()].concat(),
        };
        // A folder gone since it was found is left for the next launch.
        if new.is_empty() || collector.service().configure_source(tool.id, &configuration).is_ok() {
            offered.extend(
                found
                    .into_iter()
                    .filter(|path| !offered.contains(path))
                    .collect::<Vec<_>>(),
            );
        }
    }
    if offered.len() > before {
        lock(store).set_offered_folders(&offered)?;
    }
    Ok(())
}

/// `weeklyRank`: the published rank this week, when linked under an alias. A missing profile clears it; any other
/// failure keeps the last one.
async fn weekly_rank(state: &LocalState, last: Option<i64>) -> Option<i64> {
    let alias = state.sync.status().alias.filter(|alias| !alias.is_empty())?;
    if !is_linked(&state.sync).await {
        return None;
    }
    let path = format!("/api/profiles/{}", encode_uri_component(&alias));
    match hosted(state, &path, Some("period=week")).await {
        Err(error) => last.filter(|_| error.status != 404),
        // `null.rank` throws inside the lookup, which keeps the last rank.
        Ok(body) => match serde_json::from_slice::<Value>(&body) {
            Ok(Value::Null) | Err(_) => last,
            Ok(profile) => profile
                .get("rank")
                .and_then(Value::as_f64)
                .filter(|rank| rank.fract() == 0.0 && rank.abs() <= MAX_SAFE_INTEGER as f64)
                .map(|rank| rank as i64),
        },
    }
}

impl Collection {
    pub(crate) fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// `setPaused`: changes apply one at a time, in call order. Pausing waits for a scan in flight; resuming starts
    /// a cycle. The change runs on its own task, so a caller that goes away does not cut it short.
    pub(crate) fn set_paused(self: &Arc<Self>, paused: bool) -> impl Future<Output = ()> + Send + 'static {
        let (done, settled) = watch::channel(false);
        let mut previous = std::mem::replace(&mut *lock(&self.change), settled);
        let this = self.clone();
        let change = tokio::spawn(async move {
            let _ = previous.wait_for(|done| *done).await;
            this.paused.store(paused, Ordering::SeqCst);
            if paused {
                let collector = this.collector.clone();
                let _ = tokio::task::spawn_blocking(move || collector.service().stop()).await;
            } else {
                this.scheduler.trigger();
            }
            done.send_replace(true);
        });
        async move {
            let _ = change.await;
        }
    }

    /// One full cycle (scan, prices, sync when linked, rank), or the one in flight.
    pub(crate) async fn cycle(&self) -> Result<(), LocalError> {
        self.scheduler.refresh().await.map_err(|error| match error {
            RefreshError::Paused => CYCLE_PAUSED,
            RefreshError::Failed(_) => LocalError::internal(),
        })
    }

    /// `overview()`, its totals in local days in the computer's zone (F3).
    pub(crate) async fn overview(&self, sync: &CloudSync) -> Result<LocalOverview, LocalError> {
        let store = self.collector.store().clone();
        let totals = blocking(move || lock(&store).period_totals(OffsetDateTime::now_utc(), Some(&TimeZone::system())))
            .await?
            .map_err(|_| LocalError::internal())?;
        Ok(LocalOverview {
            totals,
            rank: *lock(&self.rank),
            alias: sync.status().alias,
            paused: self.paused(),
            refresh: self.scheduler.status(),
        })
    }
}

/// The collector-backed routes, for `base_router`'s `local`, over a state from [`LocalState::with_collector`].
pub(crate) fn local_routes() -> Router<LocalState> {
    Router::new()
        .route("/api/local/status", get(get_status))
        .route("/api/local/detect", get(detect))
        .route(
            "/api/local/sources/{id}",
            put(source).layer(DefaultBodyLimit::max(16_384)),
        )
        // `scan` predates the refresh cycle; both run one full cycle.
        .route("/api/local/refresh", post(refresh))
        .route("/api/local/scan", post(refresh))
        .route("/api/local/collection", put(collection))
        .route("/api/local/summary", get(summary))
        .route("/api/local/sessions", get(sessions))
        .route("/api/local/breakdown", get(breakdown))
        .route("/api/local/projects", get(projects))
        .route("/api/local/export", get(export))
        .route("/api/local/overview", get(overview))
        .route("/api/local/day", get(day))
        .route("/api/local/hours", get(hours))
        .route("/api/local/limits", get(limits))
}

/// `GET /api/local/status`, in TypeScript's key order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    sources: Vec<SourceStatus>,
    collecting: bool,
    last_scan_at: Option<String>,
    cloud_linked: bool,
    #[serde(flatten)]
    sync: SyncStatus,
    #[serde(flatten)]
    refresh: RefreshStatus,
    pricing_version: String,
    /// Only in the launch that turned tools on: TypeScript has no first run, so its status keeps the shape it shares.
    #[serde(skip_serializing_if = "Option::is_none")]
    first_run: Option<FirstRun>,
}

/// What the first run found, for the setup panel: every token counted so far.
#[derive(Serialize)]
struct FirstRun {
    tokens: u64,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}
fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

/// The collector's status, with the suggested folder of each unconfigured source (the one detected here, else the
/// usual one) for one-click Start tracking, enabled sources reported paused while collection is and no scan runs,
/// the link, sync, refresh and price-table state, and in the first run the all-time total. A failing credential store
/// reads as unlinked, with `syncError: "CREDENTIAL_STORE_UNAVAILABLE"`.
///
/// It first waits up to a second for a cycle in flight. TypeScript runs a short cycle's last writes and its times in
/// one turn of the event loop, so a status read after the cycle's usage is visible reports the finished cycle; here
/// the scan runs on another thread, and would otherwise be seen between its writes and the cycle's times.
async fn status(state: &LocalState) -> Result<Status, LocalError> {
    let local = state.collection();
    let mut cycling = local.cycling.subscribe();
    let _ = tokio::time::timeout(SETTLE, cycling.wait_for(|cycling| !cycling)).await;
    let collector = local.collector.clone();
    let current = blocking(move || collector.service().status())
        .await?
        .map_err(|_| LocalError::internal())?;
    let link = state.sync.secrets().get().await;
    let (cloud_linked, credential_error) = (link.as_ref().is_ok_and(Option::is_some), link.is_err());
    let (detected, defaults) = blocking(|| {
        let home = home();
        (detect_tools(env, &home), default_source_paths(env, &home))
    })
    .await?;
    // A tool the collector does not read gets no suggested folder.
    let suggested = |id: ToolId| match detected.iter().find(|tool| tool.id == id) {
        Some(tool) => tool.paths.clone(),
        None if !tokentracky_collector::readers::is_supported(id) => Vec::new(),
        None => defaults
            .iter()
            .find(|(tool, _)| *tool == id)
            .map(|(_, paths)| paths.iter().take(1).cloned().collect())
            .unwrap_or_default(),
    };
    let (paused, scanning) = (local.paused(), current.collecting);
    let collecting = scanning || (!paused && current.sources.iter().any(|source| source.enabled));
    let sources = current
        .sources
        .into_iter()
        .map(|mut source| {
            if source.paths.is_empty() {
                source.paths = suggested(source.id);
            }
            if paused && !scanning && source.enabled {
                source.state = SourceState::Paused;
            }
            source
        })
        .collect();
    let mut sync = state.sync.status();
    if credential_error {
        sync.sync_error = Some("CREDENTIAL_STORE_UNAVAILABLE");
    }
    let first_run = if local.first_run {
        let tokens = local.overview(&state.sync).await?.totals.all_time;
        Some(FirstRun { tokens })
    } else {
        None
    };
    Ok(Status {
        sources,
        collecting,
        last_scan_at: current.last_scan_at,
        cloud_linked,
        sync,
        refresh: local.scheduler.status(),
        pricing_version: local.collector.pricing_table().version().to_owned(),
        first_run,
    })
}

async fn get_status(State(state): State<LocalState>) -> Result<Response, LocalError> {
    Ok(json(StatusCode::OK, &status(&state).await?))
}

/// First-run discovery: the supported tools whose default log folder exists here. Stats only; never reads.
async fn detect() -> Result<Response, LocalError> {
    let tools = blocking(|| detect_tools(env, &home())).await?;
    Ok(json(StatusCode::OK, &serde_json::json!({ "tools": tools })))
}

/// Authorises, pauses or re-scopes one source, starts a cycle when it is enabled, and answers the status.
async fn source(
    State(state): State<LocalState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, LocalError> {
    // Fastify's router matches decoded parameters of at most 100 UTF-16 units, before it reads the body.
    if id.encode_utf16().count() > 100 {
        return Err(LocalError::not_found());
    }
    let JsonBody(body) = JsonBody::from_request(request, &state).await?;
    let tool = serde_json::from_value::<ToolId>(Value::String(id)).map_err(|_| SOURCE_NOT_FOUND)?;
    let body = object(body.as_ref(), &["enabled", "paths"])?;
    let paths = body
        .get("paths")
        .and_then(Value::as_array)
        .filter(|paths| paths.len() <= 20)
        .and_then(|paths| {
            paths
                .iter()
                .map(|path| {
                    path.as_str()
                        .filter(|path| path.encode_utf16().count() <= 4096)
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<_>>>()
        });
    let (Some(enabled), Some(paths)) = (body.get("enabled").and_then(Value::as_bool), paths) else {
        return Err(INVALID_PATHS);
    };
    let local = state.collection();
    let collector = local.collector.clone();
    let configuration = SourceConfiguration { enabled, paths };
    let configured = blocking(move || collector.service().configure_source(tool, &configuration)).await;
    if !matches!(configured, Ok(Ok(_))) {
        return Err(SOURCE_UNAVAILABLE);
    }
    if enabled {
        local.scheduler.trigger();
    }
    get_status(State(state)).await
}

async fn refresh(State(state): State<LocalState>, _: JsonBody) -> Result<Response, LocalError> {
    let local = state.collection();
    if local.paused() {
        return Err(COLLECTION_PAUSED);
    }
    local.cycle().await?;
    get_status(State(state)).await
}

/// Exactly `{paused: boolean}`; answers once the change has applied.
async fn collection(State(state): State<LocalState>, JsonBody(body): JsonBody) -> Result<Response, LocalError> {
    let paused = body
        .as_ref()
        .and_then(Value::as_object)
        .filter(|body| body.keys().all(|key| key == "paused"))
        .and_then(|body| body.get("paused")?.as_bool())
        .ok_or(INVALID_PAUSE)?;
    let local = state.collection();
    local.set_paused(paused).await;
    Ok(json(StatusCode::OK, &serde_json::json!({ "paused": local.paused() })))
}

/// `Number(text)`: decimal literals and `Infinity` with an optional sign, or `0x`, `0o` and `0b` integers, between
/// JavaScript white space; empty is 0 and anything else NaN.
pub(crate) fn js_number(text: &str) -> f64 {
    let text = text.trim_matches(is_js_space);
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = text.strip_prefix(prefix) {
            let value = digits.chars().try_fold(0.0, |value: f64, c| {
                c.to_digit(radix)
                    .map(|digit| value * f64::from(radix) + f64::from(digit))
            });
            return value.filter(|_| !digits.is_empty()).unwrap_or(f64::NAN);
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust also reads `inf`, `nan` and their spellings, which JavaScript does not.
    if !unsigned
        .bytes()
        .all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// The query parameters as Fastify reads them: a repeated one is a list, which no filter accepts.
fn params(query: Option<&str>) -> Value {
    let mut params = Map::new();
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or("").as_bytes()) {
        let value = Value::String(value.into_owned());
        match params.get_mut(key.as_ref()) {
            None => {
                params.insert(key.into_owned(), value);
            }
            Some(Value::Array(values)) => values.push(value),
            Some(first) => *first = Value::Array(vec![first.take(), value]),
        }
    }
    Value::Object(params)
}

/// `tz`: an IANA time zone name the system's zone database knows.
fn time_zone(value: &Value) -> Option<TimeZone> {
    value.as_str().and_then(|name| TimeZone::get(name).ok())
}

/// `queryOptions`: a rolling `days` window (7 by default), optionally shifted back `offset` days (a whole number from 0
/// to 365), or inclusive `from`/`to` days, a tool or `all`, and a search text of up to 200 characters. Days are UTC, or
/// local in an IANA zone `tz` (Rust only; TypeScript refuses the parameter). A rolling window starts and ends on the
/// quarter hours at or before its instants, as the store's saved totals are kept. Rust only: `since`/`until`, instants
/// in milliseconds on whole quarter hours, select `[since, until)` exactly (the Tokens page's last 24 hours).
fn query_options(query: Option<&str>) -> Result<QueryOptions, LocalError> {
    let params = params(query);
    let query = object(
        Some(&params),
        &["days", "offset", "from", "to", "since", "until", "tool", "q", "tz"],
    )?;
    let text = |key: &str| query.get(key).and_then(Value::as_str);
    let custom = query.contains_key("from") || query.contains_key("to");
    let exact = query.contains_key("since") || query.contains_key("until");
    let days = match query.get("days") {
        None => (!custom && !exact).then_some(7.0),
        Some(days) => Some(days.as_str().map_or(f64::NAN, js_number)),
    };
    // A whole number of quarter hours from the epoch, in milliseconds, written as an integer.
    let instant = |key: &str| {
        let value = query.get(key)?.as_str()?.parse::<i64>().ok()?;
        let safe = (0..=MAX_SAFE_INTEGER as i64).contains(&value);
        (safe && value % QUARTER_HOUR_MS == 0).then_some(value)
    };
    let (since, until) = (instant("since"), instant("until"));
    let offset = query
        .get("offset")
        .map(|offset| offset.as_str().map_or(f64::NAN, js_number));
    let range = matches!(
        (text("from").filter(|day| is_utc_day(day)), text("to").filter(|day| is_utc_day(day))),
        (Some(from), Some(to)) if from <= to
    );
    // `Some(None)` is every tool, and no search.
    let tool = match query.get("tool") {
        None => Some(None),
        Some(Value::String(tool)) if tool == "all" => Some(None),
        Some(tool) => serde_json::from_value::<ToolId>(tool.clone()).ok().map(Some),
    };
    let q = match query.get("q") {
        None => Some(None),
        Some(q) => q.as_str().filter(|q| q.encode_utf16().count() <= 200).map(Some),
    };
    let tz = match query.get("tz") {
        None => Some(None),
        Some(tz) => time_zone(tz).map(Some),
    };
    let (Some(tool), Some(q), Some(tz)) = (tool, q, tz) else {
        return Err(INVALID_FILTER);
    };
    // `Number.isSafeInteger(offset) && offset >= 0 && offset <= 365`; NaN is in no range.
    let whole_days = |offset: f64| offset.fract() == 0.0 && (0.0..=365.0).contains(&offset);
    if days.is_some_and(|days| custom || !RANGE_DAYS.contains(&days))
        || (custom && !range)
        || offset.is_some_and(|offset| custom || !whole_days(offset))
        || (exact && (custom || days.is_some() || offset.is_some()))
        || (exact && !matches!((since, until), (Some(since), Some(until)) if since < until))
    {
        return Err(INVALID_FILTER);
    }
    Ok(QueryOptions {
        days: days.map(|days| days as i64),
        offset: offset.map(|offset| offset as i64),
        from: text("from").map(str::to_owned),
        to: text("to").map(str::to_owned),
        since,
        until,
        tool,
        q: q.map(str::to_owned),
        now: None,
        tz,
    })
}

/// One store query over the request's filters.
async fn query<T: Send + 'static>(
    state: &LocalState,
    uri: &Uri,
    call: fn(&UsageStore, &QueryOptions) -> Result<T, StoreError>,
) -> Result<T, LocalError> {
    let options = query_options(uri.query())?;
    let store = state.store.clone();
    blocking(move || call(&lock(&store), &options))
        .await?
        .map_err(|_| LocalError::internal())
}

async fn summary(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    Ok(json(StatusCode::OK, &query(&state, &uri, UsageStore::summary).await?))
}

async fn sessions(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    let items = query(&state, &uri, UsageStore::sessions).await?;
    Ok(json(StatusCode::OK, &serde_json::json!({ "items": items })))
}

async fn breakdown(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    let items = query(&state, &uri, UsageStore::breakdown).await?;
    Ok(json(StatusCode::OK, &serde_json::json!({ "items": items })))
}

/// Projects with the repository named by each folder's local git remote, read once the store is released.
async fn projects(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    let projects = query(&state, &uri, UsageStore::projects).await?;
    let items = blocking(move || {
        let named = |project: ProjectSummary| ProjectSummary {
            repository: Some(project_repository(&project.name)),
            ..project
        };
        projects.into_iter().map(named).collect::<Vec<_>>()
    })
    .await?;
    Ok(json(StatusCode::OK, &serde_json::json!({ "items": items })))
}

/// The menu bar's overview without another pass over the usage: the totals of the last cycle, its rank while the
/// alias is still the one it was looked up for, and the alias, collection and refresh as they are now. Without one (before the first cycle, or after one with nothing listening)
/// it is computed once, as `LocalApp::overview` is.
async fn overview(State(state): State<LocalState>) -> Result<Response, LocalError> {
    let local = state.collection();
    let today = OffsetDateTime::now_utc().date();
    let cached = current(&lock(&local.cached_overview), today);
    let last = match cached {
        Some(last) => last,
        None => {
            let first = local.overview(&state.sync).await?;
            let mut cache = lock(&local.cached_overview);
            // A cycle that has published meanwhile wins.
            current(&cache, today).unwrap_or_else(|| {
                *cache = Some((today, first.clone()));
                first
            })
        }
    };
    let (totals, refresh, alias) = (last.totals, local.scheduler.status(), state.sync.status().alias);
    let overview = MenuOverview {
        today: totals.today,
        week: totals.week,
        month: totals.month,
        all_time: totals.all_time,
        top_tool: totals.top_tool.map(|top| TopTool {
            tool: top.tool,
            tokens: top.tokens,
        }),
        // A link or unlink since the cycle leaves its rank behind.
        rank: last.rank.filter(|_| alias.is_some() && alias == last.alias),
        alias,
        paused: local.paused(),
        refreshing: refresh.refreshing,
        refreshed_at: last.refresh.last_refresh_at,
        next_refresh_at: refresh.next_refresh_at,
    };
    Ok(json(StatusCode::OK, &overview))
}

/// The cached overview, if it was computed on `today` (UTC); after midnight its today and week may have ended.
fn current(cached: &Option<(Date, LocalOverview)>, today: Date) -> Option<LocalOverview> {
    cached
        .as_ref()
        .filter(|(day, _)| *day == today)
        .map(|(_, overview)| overview.clone())
}

/// `GET /api/local/day?date=YYYY-MM-DD&tz=Area/City`: that local day's tokens by half hour (F3's chart of today).
async fn day(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    let params = params(uri.query());
    let query = object(Some(&params), &["date", "tz"])?;
    let date = query.get("date").and_then(Value::as_str).filter(|day| is_utc_day(day));
    let (Some(date), Some(tz)) = (date.map(str::to_owned), query.get("tz").and_then(time_zone)) else {
        return Err(INVALID_FILTER);
    };
    let store = state.store.clone();
    let series = blocking(move || lock(&store).day_series(&date, &tz))
        .await?
        .map_err(|_| LocalError::internal())?;
    Ok(json(StatusCode::OK, &series))
}

/// `GET /api/local/hours?since=&until=`, with the usage queries' `tool` and `q`: the window's tokens by hour, tool and
/// model, hours counted from `since` (the Tokens page's bars of the last 24 hours). The window is whole hours, at most
/// a day. Rust only.
async fn hours(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    const HOUR_MS: i64 = 3_600_000;
    let options = query_options(uri.query())?;
    let (Some(since), Some(until)) = (options.since, options.until) else {
        return Err(INVALID_FILTER);
    };
    if (until - since) % HOUR_MS != 0 || until - since > 24 * HOUR_MS {
        return Err(INVALID_FILTER);
    }
    let store = state.store.clone();
    let items = blocking(move || lock(&store).hours(&options))
        .await?
        .map_err(|_| LocalError::internal())?;
    Ok(json(StatusCode::OK, &serde_json::json!({ "items": items })))
}

/// `GET /api/local/limits`, with no parameters: Claude Code's and Codex's latest usage-limit readings, each window with
/// its pace now (F6). Local only.
async fn limits(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    object(Some(&params(uri.query())), &[])?;
    let store = state.store.clone();
    let readings = blocking(move || lock(&store).limits())
        .await?
        .map_err(|_| LocalError::internal())?;
    let now = OffsetDateTime::now_utc().unix_timestamp_nanos().div_euclid(1_000_000) as i64;
    Ok(json(StatusCode::OK, &crate::limits::limits(&readings, now)))
}

/// The CSV download. Its headers are set on success only (the crate root's second quirk).
async fn export(State(state): State<LocalState>, uri: Uri) -> Result<Response, LocalError> {
    let csv = query(&state, &uri, UsageStore::export_csv).await?;
    let headers = [
        (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
        (
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"tokentracky-usage.csv\"",
        ),
    ];
    Ok((headers, csv).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokentracky_collector::store::PeriodTotals;

    #[test]
    fn a_cached_overview_lasts_for_the_utc_day_it_was_computed_on() {
        let totals = PeriodTotals {
            today: 1,
            week: 2,
            month: 3,
            all_time: 4,
            top_tool: None,
        };
        let refresh = RefreshStatus {
            last_refresh_at: None,
            next_refresh_at: None,
            refreshing: false,
        };
        let overview = LocalOverview {
            totals,
            rank: None,
            alias: None,
            paused: false,
            refresh,
        };
        let today = OffsetDateTime::UNIX_EPOCH.date();
        let yesterday = today.previous_day().unwrap();
        assert_eq!(current(&Some((today, overview.clone())), today), Some(overview.clone()));
        assert_eq!(current(&Some((yesterday, overview)), today), None);
        assert_eq!(current(&None, today), None);
    }
}
