//! The refresh scheduler, on tokio's paused clock.
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use time::OffsetDateTime;
use time::macros::datetime;
use tokentracky_collector::scheduler::{
    BoxFuture, IntervalError, RefreshError, RefreshOptions, RefreshScheduler, RefreshStatus, RetryAfter,
    SYNC_BACKOFF_MS, Step, StepError, WAKE_STALE_MS, refresh_interval,
};
use tokio::sync::Notify;
use tokio::time::Instant;

const HOUR: u64 = 3_600_000;
/// The default cycle.
const INTERVAL: u64 = 5 * MINUTE;
const MINUTE: u64 = 60_000;
const START: OffsetDateTime = datetime!(2026-10-23 12:00 UTC);

/// The calls each step makes, in order.
#[derive(Clone, Default)]
struct Calls(Arc<Mutex<Vec<&'static str>>>);
impl Calls {
    fn push(&self, call: &'static str) {
        self.0.lock().unwrap().push(call);
    }
    fn all(&self) -> Vec<&'static str> {
        self.0.lock().unwrap().clone()
    }
    fn count(&self, call: &str) -> usize {
        self.all().iter().filter(|made| **made == call).count()
    }
}
/// A step that records its call and then succeeds, or fails with `error`.
fn step(calls: &Calls, call: &'static str, error: Option<&'static str>) -> Step {
    let calls = calls.clone();
    Box::new(move || {
        calls.push(call);
        Box::pin(async move { error.map_or(Ok(()), |error| Err(error.into())) })
    })
}
fn flag(value: &Arc<AtomicBool>) -> Box<dyn Fn() -> bool + Send + Sync> {
    let value = value.clone();
    Box::new(move || value.load(Ordering::SeqCst))
}

struct Fixture {
    paused: Arc<AtomicBool>,
    enabled: Arc<AtomicBool>,
    linked: Arc<AtomicBool>,
    calls: Calls,
    started: Instant,
}
impl Fixture {
    fn new() -> Self {
        Self {
            paused: Arc::default(),
            enabled: Arc::new(AtomicBool::new(true)),
            linked: Arc::new(AtomicBool::new(true)),
            calls: Calls::default(),
            started: Instant::now(),
        }
    }
    fn options(&self) -> RefreshOptions {
        let (calls, linked, started) = (self.calls.clone(), self.linked.clone(), self.started);
        RefreshOptions {
            scan: step(&self.calls, "scan", None),
            sync: step(&self.calls, "sync", None),
            linked: Box::new(move || {
                let linked = linked.load(Ordering::SeqCst);
                Box::pin(async move { linked }) as BoxFuture<bool>
            }),
            has_enabled_source: flag(&self.enabled),
            refresh_pricing: None,
            is_paused: flag(&self.paused),
            on_refresh: Some(Box::new(move || {
                calls.push("publish");
                Box::pin(async {})
            })),
            interval_ms: None,
            // The fake clock moves with tokio's paused time, as vitest's fake timers move `Date`.
            now: Some(Arc::new(move || {
                START + Duration::from_millis((Instant::now() - started).as_millis() as u64)
            })),
        }
    }
    fn set(&self, flag: &AtomicBool, value: bool) {
        flag.store(value, Ordering::SeqCst);
    }
}

/// Lets every ready task run without moving the clock.
async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}
/// `vi.advanceTimersByTimeAsync(ms)`: each timer due by then fires at its own time, and what it starts settles.
async fn advance(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
    settle().await;
}
fn status(last: Option<&str>, next: Option<&str>, refreshing: bool) -> RefreshStatus {
    RefreshStatus {
        last_refresh_at: last.map(str::to_owned),
        next_refresh_at: next.map(str::to_owned),
        refreshing,
    }
}

mod refresh_cycle {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn runs_scan_sync_and_publish_once_at_launch_then_every_five_minutes() {
        let fixture = Fixture::new();
        let scheduler = RefreshScheduler::new(fixture.options()).unwrap();
        scheduler.start();
        advance(0).await;
        assert_eq!(fixture.calls.all(), ["scan", "sync", "publish"]);
        assert_eq!(
            scheduler.status(),
            status(
                Some("2026-10-23T12:00:00.000Z"),
                Some("2026-10-23T12:05:00.000Z"),
                false
            )
        );
        advance(INTERVAL - 1).await;
        assert_eq!(fixture.calls.all().len(), 3);
        advance(1).await;
        assert_eq!(
            fixture.calls.all(),
            ["scan", "sync", "publish", "scan", "sync", "publish"]
        );
        assert_eq!(
            scheduler.status().next_refresh_at.as_deref(),
            Some("2026-10-23T12:10:00.000Z")
        );
        scheduler.stop().await;
        advance(3 * INTERVAL).await;
        assert_eq!(fixture.calls.all().len(), 6);
        assert_eq!(scheduler.status().next_refresh_at, None);
    }

    #[tokio::test(start_paused = true)]
    async fn waits_for_a_source_before_the_launch_cycle_and_skips_sync_when_not_linked() {
        let fixture = Fixture::new();
        let scheduler = RefreshScheduler::new(fixture.options()).unwrap();
        fixture.set(&fixture.enabled, false);
        fixture.set(&fixture.linked, false);
        scheduler.start();
        advance(0).await;
        assert_eq!(fixture.calls.all(), Vec::<&str>::new());
        assert_eq!(
            scheduler.status(),
            status(None, Some("2026-10-23T12:05:00.000Z"), false)
        );
        fixture.set(&fixture.enabled, true);
        scheduler.trigger();
        advance(0).await;
        assert_eq!(fixture.calls.all(), ["scan", "publish"]);
    }

    #[tokio::test(start_paused = true)]
    async fn shares_one_active_cycle_between_refreshes_and_wakes_and_resets_the_cycle_timer_after_a_manual_refresh() {
        let fixture = Fixture::new();
        let finish = Arc::new(Notify::new());
        let (calls, waiting) = (fixture.calls.clone(), finish.clone());
        let scan: Step = Box::new(move || {
            calls.push("scan");
            let finish = waiting.clone();
            Box::pin(async move {
                finish.notified().await;
                Ok(())
            })
        });
        let scheduler = RefreshScheduler::new(RefreshOptions {
            scan,
            ..fixture.options()
        })
        .unwrap();
        scheduler.start();
        let manual = tokio::spawn({
            let scheduler = scheduler.clone();
            async move { scheduler.refresh().await }
        });
        let again = tokio::spawn({
            let scheduler = scheduler.clone();
            async move { scheduler.refresh().await }
        });
        scheduler.wake();
        assert!(scheduler.status().refreshing);
        advance(30 * MINUTE).await;
        finish.notify_one();
        manual.await.unwrap().unwrap();
        again.await.unwrap().unwrap();
        assert_eq!(fixture.calls.count("scan"), 1);
        assert_eq!(
            scheduler.status(),
            status(
                Some("2026-10-23T12:30:00.000Z"),
                Some("2026-10-23T12:35:00.000Z"),
                false
            )
        );
    }

    #[tokio::test(start_paused = true)]
    async fn refreshes_on_wake_only_when_the_last_cycle_is_more_than_5_minutes_old() {
        let fixture = Fixture::new();
        // A longer cycle, so the timer does not refresh first (as when the computer slept through it).
        let scheduler = RefreshScheduler::new(RefreshOptions {
            interval_ms: Some(HOUR),
            ..fixture.options()
        })
        .unwrap();
        scheduler.start();
        advance(WAKE_STALE_MS).await;
        scheduler.wake();
        advance(0).await;
        assert_eq!(fixture.calls.count("scan"), 1);
        advance(1).await;
        scheduler.wake();
        advance(0).await;
        assert_eq!(fixture.calls.count("scan"), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn blocks_every_cycle_while_paused_and_keeps_the_schedule() {
        let fixture = Fixture::new();
        let scheduler = RefreshScheduler::new(fixture.options()).unwrap();
        fixture.set(&fixture.paused, true);
        scheduler.start();
        let error = scheduler.refresh().await.unwrap_err();
        // The local API answers it with 409 COLLECTION_PAUSED.
        assert!(matches!(error, RefreshError::Paused));
        assert_eq!(error.to_string(), "Resume collection before refreshing.");
        scheduler.trigger();
        scheduler.wake();
        advance(2 * INTERVAL).await;
        assert_eq!(fixture.calls.count("scan"), 0);
        assert_eq!(
            scheduler.status().next_refresh_at.as_deref(),
            Some("2026-10-23T12:15:00.000Z")
        );
        fixture.set(&fixture.paused, false);
        advance(INTERVAL).await;
        assert_eq!(fixture.calls.count("scan"), 1);
    }

    /// A sync step whose result `mode` chooses: 0 succeeds, 1 fails, 2 fails with the server's 15-minute Retry-After.
    fn switchable(calls: &Calls) -> (Step, Arc<AtomicUsize>) {
        let (calls, mode) = (calls.clone(), Arc::new(AtomicUsize::new(1)));
        let step: Step = Box::new({
            let mode = mode.clone();
            move || {
                calls.push("sync");
                let result: Result<(), StepError> = match mode.load(Ordering::SeqCst) {
                    0 => Ok(()),
                    1 => Err("offline".into()),
                    _ => Err(Box::new(RetryAfter(Duration::from_secs(900)))),
                };
                Box::pin(async move { result })
            }
        });
        (step, mode)
    }
    async fn at(fixture: &Fixture, minute: u64) {
        tokio::time::sleep_until(fixture.started + Duration::from_millis(minute * MINUTE)).await;
        settle().await;
    }

    #[tokio::test(start_paused = true)]
    async fn backs_off_failed_pushes_across_cycles_from_1_to_30_minutes_while_every_cycle_scans() {
        assert_eq!(SYNC_BACKOFF_MS, (MINUTE, 30 * MINUTE));
        let fixture = Fixture::new();
        let (sync, _) = switchable(&fixture.calls);
        let scheduler = RefreshScheduler::new(RefreshOptions {
            sync,
            ..fixture.options()
        })
        .unwrap();
        scheduler.start();
        // Failures at 0, 5, 10, 15, 25, 45 and 75 wait 1, 2, 4, 8, 16, 30 and 30 minutes: the next cycle at or after
        // each deadline pushes again.
        let pushes = [
            (0, 1),
            (5, 2),
            (10, 3),
            (15, 4),
            (20, 4),
            (25, 5),
            (40, 5),
            (45, 6),
            (70, 6),
            (75, 7),
            (100, 7),
            (105, 8),
        ];
        for (minute, syncs) in pushes {
            at(&fixture, minute).await;
            assert_eq!(fixture.calls.count("sync"), syncs, "minute {minute}");
            assert_eq!(fixture.calls.count("scan"), minute as usize / 5 + 1, "minute {minute}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn waits_out_the_servers_retry_after_and_resets_the_backoff_after_a_success() {
        let fixture = Fixture::new();
        let (sync, mode) = switchable(&fixture.calls);
        mode.store(2, Ordering::SeqCst);
        let scheduler = RefreshScheduler::new(RefreshOptions {
            sync,
            ..fixture.options()
        })
        .unwrap();
        scheduler.start();
        at(&fixture, 10).await;
        assert_eq!(fixture.calls.count("sync"), 1);
        mode.store(1, Ordering::SeqCst);
        // 15 minutes after the 429 the cycle pushes again; it fails, so the next push waits 2 minutes.
        at(&fixture, 15).await;
        assert_eq!(fixture.calls.count("sync"), 2);
        mode.store(0, Ordering::SeqCst);
        at(&fixture, 20).await;
        assert_eq!(fixture.calls.count("sync"), 3);
        // After the success a failure waits 1 minute again, not 4: the cycle at 25 fails, the one at 30 pushes.
        mode.store(1, Ordering::SeqCst);
        at(&fixture, 30).await;
        assert_eq!(fixture.calls.count("sync"), 5);
    }

    #[tokio::test(start_paused = true)]
    async fn a_manual_refresh_pushes_during_the_backoff_but_not_before_the_servers_deadline() {
        let fixture = Fixture::new();
        let (sync, mode) = switchable(&fixture.calls);
        let scheduler = RefreshScheduler::new(RefreshOptions {
            sync,
            ..fixture.options()
        })
        .unwrap();
        scheduler.start();
        // Failures at 0 and 5: no cycle pushes before minute 7.
        at(&fixture, 6).await;
        assert_eq!(fixture.calls.count("sync"), 2);
        mode.store(2, Ordering::SeqCst);
        scheduler.refresh().await.unwrap();
        assert_eq!(fixture.calls.count("sync"), 3);
        // The server asked for 15 minutes: even a manual refresh waits.
        at(&fixture, 8).await;
        scheduler.refresh().await.unwrap();
        assert_eq!(fixture.calls.count("sync"), 3);
        assert_eq!(fixture.calls.count("scan"), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn runs_a_follow_up_cycle_when_a_source_is_enabled_after_the_active_cycle_has_scanned() {
        let fixture = Fixture::new();
        let release_pricing = Arc::new(Notify::new());
        let (calls, waiting) = (fixture.calls.clone(), release_pricing.clone());
        let refresh_pricing: Step = Box::new(move || {
            calls.push("pricing");
            let release = waiting.clone();
            Box::pin(async move {
                release.notified().await;
                Ok(())
            })
        });
        let scheduler = RefreshScheduler::new(RefreshOptions {
            refresh_pricing: Some(refresh_pricing),
            ..fixture.options()
        })
        .unwrap();
        scheduler.start();
        advance(0).await;
        assert_eq!(fixture.calls.count("scan"), 1);
        scheduler.trigger();
        let refreshed = Arc::new(AtomicBool::new(false));
        let manual = tokio::spawn({
            let (scheduler, refreshed) = (scheduler.clone(), refreshed.clone());
            async move {
                let result = scheduler.refresh().await;
                refreshed.store(true, Ordering::SeqCst);
                result
            }
        });
        // `refresh()` joins the active run before the price check is released, as it does synchronously in TypeScript.
        settle().await;
        release_pricing.notify_one();
        advance(0).await;
        assert_eq!(fixture.calls.count("scan"), 2);
        assert!(!refreshed.load(Ordering::SeqCst));
        release_pricing.notify_one();
        manual.await.unwrap().unwrap();
        assert_eq!(fixture.calls.count("sync"), 2);
        assert_eq!(fixture.calls.count("publish"), 1);
        scheduler.trigger();
        release_pricing.notify_one();
        advance(0).await;
        assert_eq!(fixture.calls.count("scan"), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_schedule_and_still_publishes_when_a_scan_fails() {
        let fixture = Fixture::new();
        let scheduler = RefreshScheduler::new(RefreshOptions {
            scan: step(&fixture.calls, "scan", Some("disk")),
            ..fixture.options()
        })
        .unwrap();
        scheduler.start();
        let error = scheduler.refresh().await.unwrap_err();
        assert_eq!(error.to_string(), "disk");
        assert_eq!(fixture.calls.count("sync"), 0);
        assert!(fixture.calls.count("publish") > 0);
        assert_eq!(
            scheduler.status(),
            status(None, Some("2026-10-23T12:05:00.000Z"), false)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn validates_the_configured_interval() {
        assert_eq!(refresh_interval(None), Ok(INTERVAL));
        assert_eq!(refresh_interval(Some("")), Ok(INTERVAL));
        assert_eq!(refresh_interval(Some("60000")), Ok(MINUTE));
        for value in ["59999", "90000.5", "abc", "-60000"] {
            let error = refresh_interval(Some(value)).unwrap_err();
            assert!(error.to_string().contains("TOKENTRACKY_REFRESH_INTERVAL_MS"), "{value}");
        }
        let fixture = Fixture::new();
        let rejected = RefreshScheduler::new(RefreshOptions {
            interval_ms: Some(1000),
            ..fixture.options()
        });
        assert_eq!(rejected.err(), Some(IntervalError::Option));
        assert_eq!(IntervalError::Option.to_string(), "invalid_refresh_interval");
    }
}

mod price_table_refresh_inside_the_cycle {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn checks_prices_after_the_scan_and_before_sync_and_never_fails_the_cycle_on_a_pricing_error() {
        let fixture = Fixture::new();
        let scheduler = RefreshScheduler::new(RefreshOptions {
            refresh_pricing: Some(step(&fixture.calls, "pricing", Some("offline"))),
            ..fixture.options()
        })
        .unwrap();
        scheduler.refresh().await.unwrap();
        assert_eq!(fixture.calls.all(), ["scan", "pricing", "sync", "publish"]);
        assert!(scheduler.status().last_refresh_at.is_some());
    }
}
