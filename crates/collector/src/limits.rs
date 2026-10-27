//! Usage limits for the local Limits page (F6): Claude Code's own cached reading in its `.claude.json`, taken with each
//! scan while Claude Code is enabled, and each Codex rollout's latest rate-limit snapshot, which comes with its records
//! (`ParserState::rate_limits`). No credentials and no network. The store keeps one reading per tool in a local table
//! that the upload projection never reads.
use crate::normalize;
use crate::readers::{RateLimits, RateWindow, iso};
use serde::Deserialize;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use tokentracky_core::ToolId;

/// The largest `.claude.json` read; a larger one has no reading. Claude Code also keeps per-project state there.
pub const MAX_CLAUDE_CONFIG_BYTES: u64 = 64 * 1024 * 1024;
/// `TimeClip`: the largest distance from the epoch a JavaScript date can hold.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

/// Claude Code's windows, as its usage reading names them, with their lengths in minutes.
pub const CLAUDE_WINDOWS: [(&str, u64); 3] = [("five_hour", 300), ("seven_day", 10_080), ("seven_day_opus", 10_080)];
/// Codex's windows, as its rate-limit snapshots name them; each gives its own length.
pub const CODEX_WINDOWS: [&str; 2] = ["primary", "secondary"];

/// A tool's latest usage-limit reading: only these figures are ever kept.
#[derive(Debug, Clone, PartialEq)]
pub struct LimitReading {
    pub tool: ToolId,
    /// When the tool took the reading, in epoch milliseconds: Claude Code's `fetchedAtMs`, or the time of the Codex
    /// record.
    pub as_of_ms: i64,
    pub windows: Vec<LimitWindow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LimitWindow {
    /// One of the tool's [`CLAUDE_WINDOWS`] or [`CODEX_WINDOWS`].
    pub name: String,
    /// From 0 to 100.
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at_ms: Option<i64>,
}

/// The names a tool's windows may have, in the order they are listed.
pub(crate) fn window_names(tool: ToolId) -> &'static [&'static str] {
    const CLAUDE: [&str; 3] = [CLAUDE_WINDOWS[0].0, CLAUDE_WINDOWS[1].0, CLAUDE_WINDOWS[2].0];
    match tool {
        ToolId::Claude => &CLAUDE,
        ToolId::Codex => &CODEX_WINDOWS,
        _ => &[],
    }
}

impl LimitReading {
    /// A Codex rollout's snapshot as a reading.
    pub(crate) fn codex(limits: &RateLimits) -> Self {
        let window = |name: &str, window: RateWindow| LimitWindow {
            name: name.to_owned(),
            used_percent: window.used_percent,
            window_minutes: window.window_minutes,
            resets_at_ms: window.resets_at_ms,
        };
        let windows = [("primary", limits.primary), ("secondary", limits.secondary)];
        Self {
            tool: ToolId::Codex,
            as_of_ms: limits.at_ms,
            windows: windows
                .into_iter()
                .filter_map(|(name, found)| found.map(|found| window(name, found)))
                .collect(),
        }
    }
}

/// Where Claude Code keeps its settings file: `$CLAUDE_CONFIG_DIR/.claude.json` while that variable is set, else
/// `~/.claude.json`. An empty value counts as unset, as in [`crate::detect`].
pub fn claude_config_file(env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    let folder = env("CLAUDE_CONFIG_DIR")
        .filter(|folder| !folder.is_empty())
        .map_or_else(|| home.to_path_buf(), PathBuf::from);
    normalize(&folder.join(".claude.json"))
}

/// The content of Claude Code's settings file at `path`, kept in memory only to find its reading: `None` for no file,
/// one larger than `limit` bytes, or one that cannot be read. A link is followed, as dotfile managers make them, but
/// only a regular file is read.
pub(crate) fn read_claude_config(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    // Non-blocking, so a file swapped for a pipe meanwhile cannot hold the scan; it is refused below.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

/// What `.claude.json` holds of Claude Code's last usage reading and of the account it is signed in to. Every other
/// setting is skipped while the file is parsed and never kept.
#[derive(Deserialize)]
struct ClaudeConfig {
    #[serde(rename = "oauthAccount")]
    account: Option<Account>,
    #[serde(rename = "cachedUsageUtilization")]
    cached: Option<CachedUsage>,
}
#[derive(Deserialize)]
struct Account {
    #[serde(rename = "accountUuid")]
    uuid: Option<Value>,
}
/// Claude Code's copy of its last `/api/oauth/usage` answer.
#[derive(Deserialize)]
struct CachedUsage {
    #[serde(rename = "accountUuid")]
    uuid: Option<Value>,
    #[serde(rename = "fetchedAtMs")]
    fetched_at_ms: Option<Value>,
    utilization: Option<Utilization>,
}
#[derive(Deserialize)]
struct Utilization {
    five_hour: Option<Value>,
    seven_day: Option<Value>,
    seven_day_opus: Option<Value>,
}

/// Claude Code's reading from the content of its `.claude.json`: only when it was taken for the account signed in
/// (`cachedUsageUtilization.accountUuid` is `oauthAccount.accountUuid`), only its time and each window's % used (capped
/// at 100) and reset time. `None` for anything else, a file that does not parse included.
pub(crate) fn claude_reading(content: &[u8]) -> Option<LimitReading> {
    let config: ClaudeConfig = serde_json::from_slice(content).ok()?;
    let (account, cached) = (config.account?, config.cached?);
    if uuid(&cached.uuid)? != uuid(&account.uuid)? {
        return None;
    }
    let fetched = cached
        .fetched_at_ms?
        .as_f64()
        .filter(|ms| (1.0..=MAX_TIME_MS as f64).contains(ms))?;
    let utilization = cached.utilization?;
    let windows = [
        &utilization.five_hour,
        &utilization.seven_day,
        &utilization.seven_day_opus,
    ];
    let windows: Vec<LimitWindow> = CLAUDE_WINDOWS
        .iter()
        .zip(windows)
        .filter_map(|(&(name, minutes), window)| {
            let window = window.as_ref()?.as_object()?;
            let used = window.get("utilization")?.as_f64().filter(|used| *used >= 0.0)?;
            let resets_at = window.get("resets_at").and_then(Value::as_str).and_then(iso::parse);
            Some(LimitWindow {
                name: name.to_owned(),
                used_percent: used.min(100.0),
                window_minutes: Some(minutes),
                resets_at_ms: resets_at.filter(|at| *at > 0),
            })
        })
        .collect();
    (!windows.is_empty()).then_some(LimitReading {
        tool: ToolId::Claude,
        as_of_ms: fetched as i64,
        windows,
    })
}

/// An account id: compared, never kept.
fn uuid(value: &Option<Value>) -> Option<&str> {
    value.as_ref()?.as_str().filter(|uuid| !uuid.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_at_most_the_limit_and_only_a_regular_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join(".claude.json");
        fs::write(&path, "0123456789").unwrap();
        assert_eq!(read_claude_config(&path, 10).as_deref(), Some(&b"0123456789"[..]));
        assert_eq!(read_claude_config(&path, 9), None);
        assert_eq!(read_claude_config(folder.path(), 10), None);
        assert_eq!(read_claude_config(&folder.path().join("missing"), 10), None);
        let link = folder.path().join("link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(read_claude_config(&link, 10).as_deref(), Some(&b"0123456789"[..]));
    }
}
