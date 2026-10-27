//! The store, scanner and price table shared by the local API, Mac app and CLI.
//! Cloud sync lives with the local API, which supplies the cycle's sync steps.
use crate::scheduler::{BoxFuture, Check, RefreshOptions, Step};
use crate::service::{IngestionOptions, IngestionService, ServiceError};
use crate::store::{StoreError, UsageStore};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tokentracky_core::TOOL_IDS;
use tokentracky_pricing::{PricingError, PricingRefresher, PricingTable, RefresherOptions, Transport};

pub struct LocalCollectorOptions<T> {
    pub database_path: PathBuf,
    /// Allows the daily LiteLLM download (off by default so tests and embedders stay offline).
    pub pricing_refresh: bool,
    pub transport: T,
    /// Claude Code's own settings file, whose cached usage-limit reading each scan takes while Claude Code is enabled
    /// (`IngestionOptions::claude_config_file`); `None` reads none.
    pub claude_config_file: Option<PathBuf>,
}

/// One database's store, its ingestion service and the price table applied to it.
pub struct LocalCollector<T> {
    store: Arc<Mutex<UsageStore>>,
    service: Arc<IngestionService>,
    pricing: Arc<tokio::sync::Mutex<PricingRefresher<T>>>,
    table: Arc<Mutex<Active>>,
    /// The options allow the download; the app's setting decides within that.
    pricing_allowed: bool,
}
/// The price table events are priced with, and when it was fetched (milliseconds since the Unix epoch).
struct Active {
    table: Arc<PricingTable>,
    fetched_at: i64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
/// Prices the store's events with `table` from now on.
fn apply(store: &Mutex<UsageStore>, current: &Mutex<Active>, table: Arc<PricingTable>) {
    lock(current).table = table.clone();
    let version = table.version().to_owned();
    lock(store).set_pricer(
        Some(Box::new(move |event| {
            table.price_on_tier(&event.tokens, &event.model, event.tool, event.service_tier.as_deref())
        })),
        Some(&version),
    );
}
/// `hasEnabledSource`: a store that cannot be read has none.
fn has_enabled_source(store: &Mutex<UsageStore>) -> bool {
    let store = lock(store);
    TOOL_IDS
        .iter()
        .any(|&tool| store.get_source_configuration(tool).is_ok_and(|source| source.enabled))
}
async fn refresh_pricing<T: Transport>(
    pricing: &tokio::sync::Mutex<PricingRefresher<T>>,
    store: &Mutex<UsageStore>,
    current: &Mutex<Active>,
) -> Result<(), PricingError> {
    let mut pricing = pricing.lock().await;
    let changed = pricing.refresh().await?;
    lock(current).fetched_at = pricing.fetched_at();
    if changed {
        apply(store, current, pricing.current());
    }
    Ok(())
}

impl<T: Transport + 'static> LocalCollector<T> {
    /// Opens the store (taking its single-writer lock) with the price table cached under `<data dir>/pricing`.
    pub fn open(options: LocalCollectorOptions<T>) -> Result<Self, ServiceError> {
        let store = Arc::new(Mutex::new(UsageStore::open(&options.database_path)?));
        let ingestion = IngestionOptions {
            claude_config_file: options.claude_config_file,
            ..IngestionOptions::default()
        };
        let service = Arc::new(IngestionService::new(store.clone(), ingestion)?);
        let directory = options.database_path.parent().unwrap_or(Path::new(""));
        let price_refresh = lock(&store).settings()?.price_refresh;
        let pricing = PricingRefresher::new(RefresherOptions {
            cache_path: directory.join("pricing").join("litellm.json"),
            enabled: options.pricing_refresh && price_refresh,
            url: None,
            transport: options.transport,
            now: None,
        });
        let table = Arc::new(Mutex::new(Active {
            table: pricing.current(),
            fetched_at: pricing.fetched_at(),
        }));
        apply(&store, &table, pricing.current());
        Ok(Self {
            store,
            service,
            pricing: Arc::new(tokio::sync::Mutex::new(pricing)),
            table,
            pricing_allowed: options.pricing_refresh,
        })
    }
    pub fn store(&self) -> &Arc<Mutex<UsageStore>> {
        &self.store
    }
    pub fn service(&self) -> &Arc<IngestionService> {
        &self.service
    }
    /// The table events are priced with.
    pub fn pricing_table(&self) -> Arc<PricingTable> {
        lock(&self.table).table.clone()
    }
    /// When the table events are priced with was fetched, in milliseconds since the Unix epoch.
    pub fn pricing_fetched_at(&self) -> i64 {
        lock(&self.table).fetched_at
    }
    /// The app's daily-download setting, where the options allow downloads: off goes back to the bundled snapshot,
    /// on to the cached download. A changed table re-prices every event.
    pub async fn set_pricing_refresh(&self, on: bool) {
        let mut pricing = self.pricing.lock().await;
        if pricing.set_enabled(on && self.pricing_allowed) {
            apply(&self.store, &self.table, pricing.current());
        }
        lock(&self.table).fetched_at = pricing.fetched_at();
    }
    pub fn has_enabled_source(&self) -> bool {
        has_enabled_source(&self.store)
    }
    /// The daily price-table check; a changed table re-prices every event.
    pub async fn refresh_pricing(&self) -> Result<(), PricingError> {
        refresh_pricing(&self.pricing, &self.store, &self.table).await
    }
    /// The cycle steps the collector owns (scan, enabled sources, price table) with the caller's sync, link and pause
    /// checks; the caller may still set the interval, clock and publishing hook.
    pub fn refresh_options(
        &self,
        sync: Step,
        linked: Box<dyn Fn() -> BoxFuture<bool> + Send + Sync>,
        is_paused: Check,
    ) -> RefreshOptions {
        let (service, store) = (self.service.clone(), self.store.clone());
        let (pricing, table, priced) = (self.pricing.clone(), self.table.clone(), self.store.clone());
        RefreshOptions {
            scan: Box::new(move || {
                // Admitted here, so the scan counts as in flight from the moment its cycle starts (TypeScript's
                // synchronous `service.scan()` call): a pause or close that follows waits for it even while the
                // blocking pool has not started it yet.
                let ticket = service.admit();
                let scan = tokio::task::spawn_blocking(move || ticket.scan());
                Box::pin(async move {
                    scan.await??;
                    Ok(())
                })
            }),
            sync,
            linked,
            has_enabled_source: Box::new(move || has_enabled_source(&store)),
            refresh_pricing: Some(Box::new(move || {
                let (pricing, table, store) = (pricing.clone(), table.clone(), priced.clone());
                Box::pin(async move { Ok(refresh_pricing(&pricing, &store, &table).await?) })
            })),
            is_paused,
            on_refresh: None,
            interval_ms: None,
            now: None,
        }
    }
    /// Waits for an in-flight scan (blocking), then closes the store. While a scheduler built from
    /// [`Self::refresh_options`] still exists, the store closes when it is dropped instead.
    pub fn close(self) -> Result<(), StoreError> {
        self.service.stop();
        drop(self.service);
        match Arc::try_unwrap(self.store) {
            Ok(store) => store.into_inner().unwrap_or_else(PoisonError::into_inner).close(),
            Err(_) => Ok(()),
        }
    }
}
