//! `status`: the report both `status --json` and `doctor` are built from, and its text form.
use crate::compact::compact;
use crate::{CliError, Context, database_path, other};
use jiff::tz::TimeZone;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use time::OffsetDateTime;
use tokentracky_collector::store::{PeriodTotals, StoreError, UsageStore};
use tokentracky_core::{SourceState, ToolId};
use tokentracky_local_api::{PricingDownload, SecretStore, cloud_origin};
use tokentracky_pricing::{PricingRefresher, RefresherOptions};

/// `StatusReport`; the field order is the order of the keys in `status --json`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub version: String,
    pub data_dir: String,
    /// A `serve` process owns the data folder.
    pub running: bool,
    pub last_refresh_at: Option<String>,
    pub totals: PeriodTotals,
    pub sources: Vec<SourceLine>,
    pub leaderboard: Leaderboard,
    pub pricing_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLine {
    pub id: ToolId,
    pub name: String,
    pub enabled: bool,
    pub state: SourceState,
    pub event_count: u64,
    pub last_imported_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Leaderboard {
    pub linked: bool,
    pub url: Option<String>,
    /// `CREDENTIAL_STORE_UNAVAILABLE` when the credential file cannot be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

impl Leaderboard {
    fn unlinked() -> Self {
        Self {
            linked: false,
            url: None,
            error: None,
        }
    }
}

async fn leaderboard(store: Option<&Arc<dyn SecretStore>>) -> Leaderboard {
    let Some(store) = store else {
        return Leaderboard::unlinked();
    };
    let origin = match store.get().await {
        Ok(Some(link)) => cloud_origin(&link.url).map(Some).map_err(|_| ()),
        Ok(None) => Ok(None),
        Err(_) => Err(()),
    };
    match origin {
        Ok(Some(url)) => Leaderboard {
            linked: true,
            url: Some(url),
            error: None,
        },
        Ok(None) => Leaderboard::unlinked(),
        Err(()) => Leaderboard {
            error: Some("CREDENTIAL_STORE_UNAVAILABLE"),
            ..Leaderboard::unlinked()
        },
    }
}

/// Reads the data folder without creating it. A database a running `serve` holds is read-only.
pub async fn report(directory: &Path, context: &Context) -> Result<StatusReport, CliError> {
    let path = database_path(directory);
    let mut running = false;
    let store = if path.exists() {
        Some(match UsageStore::open(&path) {
            Ok(store) => store,
            Err(StoreError::CollectorDatabaseLocked(_)) => {
                running = true;
                UsageStore::open_read_only(&path)?
            }
            Err(error) => return Err(error.into()),
        })
    } else {
        None
    };
    let read = async {
        let (last_refresh_at, totals, statuses) = match &store {
            Some(store) => (
                store.last_scan_at()?,
                // Local days in the computer's zone, as the menu-bar title counts them (F3).
                store.period_totals(OffsetDateTime::now_utc(), Some(&TimeZone::system()))?,
                store.source_statuses()?,
            ),
            None => (
                None,
                PeriodTotals {
                    today: 0,
                    week: 0,
                    month: 0,
                    all_time: 0,
                    top_tool: None,
                },
                Vec::new(),
            ),
        };
        // The same cached table the collector uses, or the bundled snapshot.
        let pricing = PricingRefresher::new(RefresherOptions {
            cache_path: directory.join("pricing").join("litellm.json"),
            enabled: context.pricing_refresh(),
            url: None,
            transport: PricingDownload::new().map_err(other)?,
            now: None,
        });
        Ok::<_, CliError>(StatusReport {
            version: context.version.clone(),
            data_dir: directory.to_string_lossy().into_owned(),
            running,
            last_refresh_at,
            totals,
            sources: statuses
                .into_iter()
                .map(|source| SourceLine {
                    id: source.id,
                    name: source.name,
                    enabled: source.enabled,
                    state: source.state,
                    event_count: source.event_count,
                    last_imported_at: source.last_imported_at,
                })
                .collect(),
            leaderboard: leaderboard(context.secret_store.as_ref()).await,
            pricing_version: pricing.current().version().to_owned(),
        })
    }
    .await;
    if let Some(store) = store {
        let _ = store.close();
    }
    read
}

/// The text `status` prints.
pub fn text(value: &StatusReport) -> String {
    let totals = &value.totals;
    let mut lines = vec![
        format!(
            "Tokentracky {} · {}{}",
            value.version,
            value.data_dir,
            if value.running { " · running" } else { "" }
        ),
        format!(
            "Today {} · This week {} · This month {} · All time {} tokens",
            compact(totals.today),
            compact(totals.week),
            compact(totals.month),
            compact(totals.all_time)
        ),
    ];
    if let Some(top) = &totals.top_tool {
        lines.push(format!("Top tool this week: {}", top.tool.name()));
    }
    let enabled: Vec<String> = value
        .sources
        .iter()
        .filter(|source| source.enabled)
        .map(|source| {
            let state = serde_json::to_value(source.state).ok();
            let state = state
                .as_ref()
                .and_then(|state| state.as_str())
                .unwrap_or("")
                .replacen('_', " ", 1);
            format!("{} ({state}, {} events)", source.name, source.event_count)
        })
        .collect();
    lines.push(if enabled.is_empty() {
        "Tracking: nothing yet. Run `tokentracky serve` and choose Start tracking.".to_owned()
    } else {
        format!("Tracking: {}", enabled.join(", "))
    });
    let board = &value.leaderboard;
    lines.push(match (&board.url, board.error) {
        (Some(url), _) if board.linked => format!("Leaderboard: linked to {url}"),
        (_, Some(_)) => "Leaderboard: the credential store is unavailable".to_owned(),
        _ => "Leaderboard: not linked. Run `tokentracky login` to join.".to_owned(),
    });
    lines.push(format!(
        "Last refresh: {}",
        value.last_refresh_at.as_deref().unwrap_or("never")
    ));
    lines.join("\n") + "\n"
}
