//! Passive readers for local tool records, the SQLite usage store, ingestion of authorised folders,
//! and the refresh scheduler.
mod collector;
pub mod detect;
pub mod git_remote;
pub mod limits;
pub mod readers;
pub mod scheduler;
pub mod service;
pub mod store;

pub use collector::{LocalCollector, LocalCollectorOptions};
pub use scheduler::{RefreshError, RefreshOptions, RefreshScheduler, RefreshStatus};
pub use service::{CollectorStatus, IngestionOptions, IngestionService, ScanResult, ScanTicket, ServiceError};

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use time::{OffsetDateTime, UtcOffset};

/// An injectable clock, shared by the service and the scheduler.
pub type Clock = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;

/// `Date.prototype.toISOString` for the years a clock gives.
pub(crate) fn iso(time: OffsetDateTime) -> String {
    let t = time.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

/// `path.normalize` (and so `path.join`): `.`, `..`, repeated and trailing separators removed lexically, never
/// following links. A relative path stays relative.
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if matches!(normalized.components().next_back(), Some(Component::Normal(_))) => {
                normalized.pop();
            }
            // `/..` is `/`.
            Component::ParentDir if normalized.has_root() => {}
            other => normalized.push(other),
        }
    }
    normalized
}
/// `path.resolve`: [`normalize`] of the absolute path.
pub(crate) fn resolve(path: &Path) -> PathBuf {
    normalize(&std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()))
}

/// White space as JavaScript's `\s` and `trim` see it.
pub(crate) fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}
