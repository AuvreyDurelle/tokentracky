//! The refresh cycle: at start, every
//! interval, on a stale wake, after a source is enabled and on demand; cycles never overlap, and there is no timer
//! between cycles beyond the next one. A failed push is retried by a later cycle, after a backoff. Every method that
//! starts work must be called inside a tokio runtime.
use crate::Clock;
use serde::Serialize;
use std::error::Error;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use time::{Duration, OffsetDateTime};
use tokentracky_core::{is_js_space, iso_timestamp};
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// Default cycle cadence: scan, totals and push.
pub const DEFAULT_REFRESH_INTERVAL_MS: u64 = 5 * 60_000;
pub const MIN_REFRESH_INTERVAL_MS: u64 = 60_000;
/// Wake from sleep refreshes when the last cycle is older than one interval.
pub const WAKE_STALE_MS: u64 = DEFAULT_REFRESH_INTERVAL_MS;
/// Failed pushes wait this long, doubling per failure up to the maximum, before a cycle pushes again.
pub const SYNC_BACKOFF_MS: (u64, u64) = (60_000, 30 * 60_000);

/// A sync step's error carrying the server's `Retry-After`: no push, not even a manual one, before it has passed.
#[derive(Debug, thiserror::Error)]
#[error("retry after {0:?}")]
pub struct RetryAfter(pub std::time::Duration);

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type StepError = Box<dyn Error + Send + Sync>;
/// One step of the cycle. The step starts when it is called, so a scan begins as its cycle does.
pub type Step = Box<dyn Fn() -> BoxFuture<Result<(), StepError>> + Send + Sync>;
pub type Check = Box<dyn Fn() -> bool + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IntervalError {
    #[error("TOKENTRACKY_REFRESH_INTERVAL_MS must be an integer of at least {MIN_REFRESH_INTERVAL_MS}")]
    Environment,
    #[error("invalid_refresh_interval")]
    Option,
}

/// `TOKENTRACKY_REFRESH_INTERVAL_MS` as `Number(value)` reads it: unset or empty is the five-minute default.
pub fn refresh_interval(value: Option<&str>) -> Result<u64, IntervalError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(DEFAULT_REFRESH_INTERVAL_MS);
    };
    let value = value.trim_matches(is_js_space);
    let radix = |prefix: [&str; 2], radix| {
        let digits = value
            .strip_prefix(prefix[0])
            .or_else(|| value.strip_prefix(prefix[1]))?;
        Some(u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64))
    };
    let number = radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
        .unwrap_or_else(|| match value {
            "" => 0.0,
            // Rust also reads `inf` and `nan`, which JavaScript does not; neither is an integer either way.
            _ => value.parse().unwrap_or(f64::NAN),
        });
    let safe = number.fract() == 0.0 && number.abs() <= tokentracky_core::MAX_SAFE_INTEGER as f64;
    if !safe || number < MIN_REFRESH_INTERVAL_MS as f64 {
        return Err(IntervalError::Environment);
    }
    Ok(number as u64)
}

/// What a cycle does, supplied by the caller.
pub struct RefreshOptions {
    pub scan: Step,
    pub sync: Step,
    pub linked: Box<dyn Fn() -> BoxFuture<bool> + Send + Sync>,
    pub has_enabled_source: Check,
    /// Daily price-table check; failures keep the current table and never fail the cycle.
    pub refresh_pricing: Option<Step>,
    pub is_paused: Check,
    /// Publishes new totals (menu bar, open dashboards) after every refresh, successful or not.
    pub on_refresh: Option<Box<dyn Fn() -> BoxFuture<()> + Send + Sync>>,
    /// Defaults to [`DEFAULT_REFRESH_INTERVAL_MS`].
    pub interval_ms: Option<u64>,
    /// Defaults to the system clock.
    pub now: Option<Clock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshStatus {
    pub last_refresh_at: Option<String>,
    pub next_refresh_at: Option<String>,
    pub refreshing: bool,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum RefreshError {
    /// The local API's 409 `COLLECTION_PAUSED`.
    #[error("Resume collection before refreshing.")]
    Paused,
    /// The cycle's scan failed (the schedule is kept and totals were still published), or the cycle was cancelled.
    #[error("{0}")]
    Failed(Arc<dyn Error + Send + Sync>),
}

type Settled = watch::Receiver<Option<Result<(), RefreshError>>>;
#[derive(Default)]
struct State {
    /// The run in flight (a cycle and any follow-up), which concurrent callers share.
    active: Option<Settled>,
    refreshing: bool,
    timer: Option<JoinHandle<()>>,
    /// Pushes that failed in a row; each doubles the wait before the next.
    failures: u32,
    /// Cycles skip the push until then; a manual refresh does not.
    backoff_until: Option<OffsetDateTime>,
    /// The server's `Retry-After` deadline, which a manual refresh also keeps.
    server_until: Option<OffsetDateTime>,
    /// A source was enabled while a cycle ran; another cycle follows so it is read now, not next hour.
    again: bool,
    running: bool,
    last_refresh_at: Option<OffsetDateTime>,
    next_refresh_at: Option<OffsetDateTime>,
}
struct Inner {
    options: RefreshOptions,
    interval: u64,
    now: Clock,
    state: Mutex<State>,
}

/// One refresh cycle: scan enabled sources, check prices, sync approved aggregates if linked, publish totals.
/// Runs at start, every interval, on stale wake, after a source is enabled and on demand. Cycles never overlap.
#[derive(Clone)]
pub struct RefreshScheduler {
    inner: Arc<Inner>,
}

impl RefreshScheduler {
    pub fn new(options: RefreshOptions) -> Result<Self, IntervalError> {
        let interval = options.interval_ms.unwrap_or(DEFAULT_REFRESH_INTERVAL_MS);
        if !(MIN_REFRESH_INTERVAL_MS..=tokentracky_core::MAX_SAFE_INTEGER).contains(&interval) {
            return Err(IntervalError::Option);
        }
        let now = options.now.clone().unwrap_or_else(|| Arc::new(OffsetDateTime::now_utc));
        Ok(Self {
            inner: Arc::new(Inner {
                options,
                interval,
                now,
                state: Mutex::default(),
            }),
        })
    }
    pub fn status(&self) -> RefreshStatus {
        let state = self.inner.lock();
        RefreshStatus {
            last_refresh_at: state.last_refresh_at.map(iso_timestamp),
            next_refresh_at: state.next_refresh_at.map(iso_timestamp),
            refreshing: state.refreshing,
        }
    }
    pub fn start(&self) {
        let inner = &self.inner;
        if std::mem::replace(&mut inner.lock().running, true) {
            return;
        }
        if (inner.options.has_enabled_source)() && !(inner.options.is_paused)() {
            inner.background();
        } else {
            inner.schedule();
        }
    }
    /// Manual refresh. Concurrent callers share the active run (including any follow-up cycle), which settles after
    /// totals are published.
    pub async fn refresh(&self) -> Result<(), RefreshError> {
        settled(self.inner.begin(true)?).await
    }
    pub fn wake(&self) {
        let now = (self.inner.now)();
        let stale = {
            let state = self.inner.lock();
            let stale = Duration::milliseconds(WAKE_STALE_MS as i64);
            state.running && state.last_refresh_at.is_none_or(|last| now - last > stale)
        };
        if stale {
            self.inner.background();
        }
    }
    /// Enabling a source or resuming collection starts a cycle straight away, or one more after the active one.
    pub fn trigger(&self) {
        {
            let mut state = self.inner.lock();
            if !state.running {
                return;
            }
            if state.active.is_some() {
                state.again = true;
                return;
            }
        }
        self.inner.background();
    }
    pub async fn stop(&self) {
        let active = {
            let mut state = self.inner.lock();
            state.running = false;
            clear_timers(&mut state);
            state.next_refresh_at = None;
            state.active.clone()
        };
        if let Some(active) = active {
            let _ = settled(active).await;
        }
    }
}

/// The cycle's result once it has published; a cycle dropped unfinished (a panicking step) counts as failed.
async fn settled(mut active: Settled) -> Result<(), RefreshError> {
    match active.wait_for(Option::is_some).await {
        Ok(result) => result.clone().expect("waited for a result"),
        Err(cancelled) => Err(RefreshError::Failed(Arc::new(cancelled))),
    }
}
fn clear_timers(state: &mut State) {
    if let Some(timer) = state.timer.take() {
        timer.abort();
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// `refresh()` up to its first await: joins the active run or starts one, whose scan starts now. A `manual` run
    /// pushes even while failed pushes back off.
    fn begin(self: &Arc<Self>, manual: bool) -> Result<Settled, RefreshError> {
        if (self.options.is_paused)() {
            return Err(RefreshError::Paused);
        }
        let (done, settled) = watch::channel(None);
        {
            let mut state = self.lock();
            if let Some(active) = &state.active {
                return Ok(active.clone());
            }
            state.refreshing = true;
            state.active = Some(settled.clone());
        }
        let scan = self.start_cycle();
        let inner = self.clone();
        tokio::spawn(async move {
            let result = inner.cycles(scan, manual).await;
            inner.lock().refreshing = false;
            if let Some(on_refresh) = &inner.options.on_refresh {
                on_refresh().await;
            }
            inner.lock().active = None;
            done.send_replace(Some(result));
        });
        Ok(settled)
    }
    fn background(self: &Arc<Self>) {
        if (self.options.is_paused)() {
            self.schedule();
            return;
        }
        let _ = self.begin(false);
    }
    /// A cycle, then another while a source was enabled during it (and the scheduler runs, unpaused). A failed scan
    /// ends the run.
    async fn cycles(
        self: &Arc<Self>,
        mut scan: BoxFuture<Result<(), StepError>>,
        manual: bool,
    ) -> Result<(), RefreshError> {
        loop {
            self.cycle(scan, manual).await?;
            let again = {
                let state = self.lock();
                state.again && state.running
            };
            if !again || (self.options.is_paused)() {
                return Ok(());
            }
            scan = self.start_cycle();
        }
    }
    /// `cycle()` up to its first await: clears the timer and starts the scan.
    fn start_cycle(&self) -> BoxFuture<Result<(), StepError>> {
        {
            let mut state = self.lock();
            state.again = false;
            clear_timers(&mut state);
        }
        (self.options.scan)()
    }
    async fn cycle(self: &Arc<Self>, scan: BoxFuture<Result<(), StepError>>, manual: bool) -> Result<(), RefreshError> {
        let result = match scan.await {
            Ok(()) => {
                self.lock().last_refresh_at = Some((self.now)());
                if let Some(refresh_pricing) = &self.options.refresh_pricing {
                    let _ = refresh_pricing().await;
                }
                let now = (self.now)();
                {
                    let mut state = self.lock();
                    if state.running {
                        state.next_refresh_at = Some(now + Duration::milliseconds(self.interval as i64));
                    }
                }
                self.sync_if_linked(manual).await;
                Ok(())
            }
            Err(error) => Err(RefreshError::Failed(Arc::from(error))),
        };
        self.schedule();
        result
    }
    async fn sync_if_linked(self: &Arc<Self>, manual: bool) {
        let now = (self.now)();
        {
            let state = self.lock();
            let waiting = |until: Option<OffsetDateTime>| until.is_some_and(|until| now < until);
            if waiting(state.server_until) || (!manual && waiting(state.backoff_until)) {
                return;
            }
        }
        if !(self.options.linked)().await {
            return;
        }
        let result = (self.options.sync)().await;
        let now = (self.now)();
        let mut state = self.lock();
        match result {
            Ok(()) => {
                state.failures = 0;
                state.backoff_until = None;
                state.server_until = None;
            }
            // The sync records its error code for status; local totals stay current and later cycles still scan.
            Err(error) => {
                state.failures += 1;
                let (initial, max) = SYNC_BACKOFF_MS;
                let wait = max.min(initial << (state.failures - 1).min(10));
                state.backoff_until = Some(now + Duration::milliseconds(wait as i64));
                if let Some(RetryAfter(delay)) = error.downcast_ref::<RetryAfter>() {
                    state.server_until = Some(now + *delay);
                }
            }
        }
    }
    fn schedule(self: &Arc<Self>) {
        let now = (self.now)();
        let mut state = self.lock();
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
        if !state.running {
            return;
        }
        state.next_refresh_at = Some(now + Duration::milliseconds(self.interval as i64));
        let inner = self.clone();
        state.timer = Some(tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(inner.interval)).await;
            inner.background();
        }));
    }
}
