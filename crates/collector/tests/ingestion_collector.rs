//! The local collector's wiring (`apps/server/src/local-collector.ts`): store, service, the price table applied to the
//! store, the cycle steps a scheduler runs, and closing.
mod support;

use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use support::fixture_text;
use tokentracky_collector::store::{QueryOptions, SourceConfiguration, UsageStore};
use tokentracky_collector::{LocalCollector, LocalCollectorOptions, RefreshScheduler};
use tokentracky_core::ToolId;
use tokentracky_pricing::{Transport, TransportError};

/// Any download fails; the collector keeps the bundled table.
struct Offline;
impl Transport for Offline {
    async fn fetch(&self, _: &str) -> Result<String, TransportError> {
        Err("offline".into())
    }
}

#[tokio::test]
async fn prices_with_the_bundled_table_scans_through_a_refresh_cycle_and_releases_the_database_on_close() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = fs::canonicalize(temporary.path()).unwrap();
    let source = directory.join("authorized");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("session.jsonl"),
        fixture_text("claude/cache-categories-disjoint/root/session.jsonl"),
    )
    .unwrap();
    let database = directory.join("data").join("usage.sqlite");
    let collector = LocalCollector::open(LocalCollectorOptions {
        database_path: database.clone(),
        pricing_refresh: false,
        claude_config_file: None,
        transport: Offline,
    })
    .unwrap();
    assert!(!collector.has_enabled_source());
    let configuration = SourceConfiguration {
        enabled: true,
        paths: vec![source.to_string_lossy().into_owned()],
    };
    collector
        .service()
        .configure_source(ToolId::Claude, &configuration)
        .unwrap();
    assert!(collector.has_enabled_source());

    let synced = Arc::new(AtomicBool::new(false));
    let marked = synced.clone();
    let options = collector.refresh_options(
        Box::new(move || {
            marked.store(true, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }),
        Box::new(|| Box::pin(async { false })),
        Box::new(|| false),
    );
    let scheduler = RefreshScheduler::new(options).unwrap();
    scheduler.refresh().await.unwrap();
    assert!(!synced.load(Ordering::SeqCst), "not linked, so no sync");
    assert!(scheduler.status().last_refresh_at.is_some());
    // Off by default: no download, and the table stays the bundled one.
    collector.refresh_pricing().await.unwrap();
    let events = collector
        .store()
        .lock()
        .unwrap()
        .export_data(&QueryOptions::default())
        .unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].cost_microusd.is_some());
    assert_eq!(
        events[0].pricing_version.as_deref(),
        Some(collector.pricing_table().version())
    );
    assert!(!directory.join("data/pricing/litellm.json").exists());

    scheduler.stop().await;
    drop(scheduler);
    collector.close().unwrap();
    UsageStore::open(&database).unwrap().close().unwrap();
}

#[test]
fn prices_codex_fast_turns_at_the_priority_rates_of_the_bundled_table() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = fs::canonicalize(temporary.path()).unwrap();
    let source = directory.join("authorized");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("rollout.jsonl"),
        fixture_text("codex/service-tier-priority/root/rollout.jsonl"),
    )
    .unwrap();
    let collector = LocalCollector::open(LocalCollectorOptions {
        database_path: directory.join("data").join("usage.sqlite"),
        pricing_refresh: false,
        claude_config_file: None,
        transport: Offline,
    })
    .unwrap();
    let configuration = SourceConfiguration {
        enabled: true,
        paths: vec![source.to_string_lossy().into_owned()],
    };
    collector
        .service()
        .configure_source(ToolId::Codex, &configuration)
        .unwrap();
    collector.service().scan().unwrap();
    let events = collector
        .store()
        .lock()
        .unwrap()
        .export_data(&QueryOptions::default())
        .unwrap();
    // gpt-5 per million: $1.25 in, $10 out, $0.125 cached, doubled on the Fast tier. In event-id order: the turn after
    // the reset to default (50 in, 10 out, 10 cached: 163.75 µUSD), the Fast turn (100, 30, 100) and the turn before
    // any setting (60, 20, 40).
    let priced: Vec<_> = events
        .iter()
        .map(|event| (event.service_tier.as_deref(), event.cost_microusd))
        .collect();
    assert_eq!(
        priced,
        [
            (None, Some(164)),
            (Some("priority"), Some(250 + 600 + 25)),
            (None, Some(75 + 200 + 5))
        ]
    );
    collector.close().unwrap();
}
