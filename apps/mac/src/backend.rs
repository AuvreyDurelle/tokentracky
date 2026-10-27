//! The local app behind the menu and the window: [`LocalApp`] (the collector, cloud sync, the refresh cycle and the
//! whole local API router), held until quit.
use axum::Router;
use std::sync::Arc;
use tokentracky_local_api::{LocalApp, LocalError, LocalOptions, LocalOverview, OpenError};
use tokio::sync::RwLock;

/// The database file in the data directory (the CLI's name for it).
pub const DATABASE: &str = "usage.sqlite";

pub type Publish = Arc<dyn Fn(LocalOverview) + Send + Sync>;

/// [`LocalApp`] until [`Backend::close`], which consumes it once every operation in flight has finished.
pub struct Backend {
    app: RwLock<Option<LocalApp>>,
    /// The menu's `on_refresh`, also called by [`Backend::publish`].
    publish: Publish,
}

impl Backend {
    /// Opens the collector (taking the data directory's single-writer lock) and builds the router. `options.on_refresh`
    /// is replaced by `publish`, which receives the overview after every cycle. Call inside a tokio runtime.
    pub fn open(options: LocalOptions, publish: Publish) -> Result<Self, OpenError> {
        let app = LocalApp::open(LocalOptions {
            on_refresh: Some(publish.clone()),
            ..options
        })?;
        Ok(Self {
            app: RwLock::new(Some(app)),
            publish,
        })
    }
    /// The whole local API and the web build, in-process; `None` once closed.
    pub async fn router(&self) -> Option<Router> {
        self.app.read().await.as_ref().map(LocalApp::router)
    }
    /// Starts the refresh cycle: a cycle now if a source is enabled and collection runs, then every five minutes.
    pub async fn start(&self) {
        if let Some(app) = &*self.app.read().await {
            app.start();
        }
    }
    /// Hands the current overview to `publish` (the cycle does so itself after each run).
    pub async fn publish(&self) {
        if let Some(Ok(overview)) = self.overview().await {
            (self.publish)(overview);
        }
    }
    async fn overview(&self) -> Option<Result<LocalOverview, LocalError>> {
        Some(self.app.read().await.as_ref()?.overview().await)
    }
    /// Manual refresh: one full cycle, or the one in flight. 409 `COLLECTION_PAUSED` while paused.
    pub async fn refresh(&self) -> Result<LocalOverview, LocalError> {
        match &*self.app.read().await {
            Some(app) => app.refresh().await,
            None => Err(LocalError::internal()),
        }
    }
    /// Pauses (waiting for a scan in flight) or resumes (starting a cycle) collection.
    pub async fn set_paused(&self, paused: bool) {
        let change = self.app.read().await.as_ref().map(|app| app.set_paused(paused));
        if let Some(change) = change {
            change.await;
        }
    }
    /// After sleep: a cycle when the last one is stale.
    pub async fn wake(&self) {
        if let Some(app) = &*self.app.read().await {
            app.wake();
        }
    }
    /// Credential-free sync outcome for the bounded native runtime harness.
    pub async fn sync_status(&self) -> (Option<String>, Option<&'static str>) {
        match &*self.app.read().await {
            Some(app) => {
                let status = app.state().sync.status();
                (status.last_sync_at, status.sync_error)
            }
            None => (None, Some("BACKEND_CLOSED")),
        }
    }

    /// The linked hosted origin, else the configured one: where external links may go.
    pub async fn remote_origin(&self) -> Option<String> {
        self.app.read().await.as_ref()?.state().remote_origin().await
    }
    /// Stops the cycle and sync and closes the store, releasing the data directory's lock. Waits for operations in
    /// flight; the router clones they took are gone with them.
    pub async fn close(&self) -> bool {
        let app = self.app.write().await.take();
        match app {
            Some(app) => app.close().await.is_ok(),
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode, header};
    use serde_json::Value;
    use tokentracky_local_api::{MemorySecretStore, ReqwestClient, UsageStore};
    use tower::ServiceExt;

    /// A native smoke test without a window: the collector opens, the router answers in-process with the app's security
    /// headers, the first cycle publishes an overview to the menu, a pause refuses refresh, and closing frees the lock.
    #[tokio::test(flavor = "multi_thread")]
    async fn starts_the_collector_and_answers_health_in_process() {
        let data = tempfile::tempdir().unwrap();
        let database = data.path().join("Tokentracky").join(DATABASE);
        let (sender, mut overviews) = tokio::sync::mpsc::unbounded_channel();
        let options = LocalOptions {
            database_path: database.clone(),
            web_root: data.path().join("web"),
            cloud_url: None,
            secrets: Arc::new(MemorySecretStore::default()),
            client: Arc::new(ReqwestClient::new().unwrap()),
            pricing_refresh: false,
            initially_paused: false,
            refresh_interval_ms: None,
            on_refresh: None,
            detected: Vec::new(),
            claude_config_file: None,
        };
        let backend = Backend::open(options, Arc::new(move |overview| sender.send(overview).unwrap())).unwrap();
        assert!(database.is_file());
        assert!(
            UsageStore::open(&database).is_err(),
            "the app holds the single-writer lock"
        );

        let request = Request::get("app://localhost/api/health").body(Body::empty()).unwrap();
        let response = backend.router().await.unwrap().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // The R0 spike's policy: the hosted one, with no auth origin.
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
             connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let health: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            (health["mode"].as_str(), &health["cloudUrl"]),
            (Some("local"), &Value::Null)
        );
        let request = Request::get("app://localhost/api/local/status")
            .body(Body::empty())
            .unwrap();
        let status = backend.router().await.unwrap().oneshot(request).await.unwrap();
        assert_eq!(
            status.status(),
            StatusCode::OK,
            "the collector-backed routes are served"
        );

        backend.start().await;
        backend.publish().await;
        let first = overviews.recv().await.unwrap();
        assert_eq!((first.totals.today, first.rank, first.paused), (0, None, false));
        assert_eq!(first.refresh.last_refresh_at, None);
        backend.refresh().await.unwrap();
        let cycled = overviews.recv().await.unwrap();
        assert!(cycled.refresh.last_refresh_at.is_some() && !cycled.refresh.refreshing);

        backend.set_paused(true).await;
        let refused = backend.refresh().await.unwrap_err();
        assert_eq!((refused.status, refused.code), (409, "COLLECTION_PAUSED"));
        backend.publish().await;
        assert!(overviews.recv().await.unwrap().paused);

        assert!(backend.close().await);
        assert!(backend.router().await.is_none());
        UsageStore::open(&database).unwrap().close().unwrap();
    }
}
