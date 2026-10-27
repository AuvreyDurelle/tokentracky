//! Hermes Agent: `~/.hermes/state.db` and each profile's `profiles/<name>/state.db`, opened read-only. Its `sessions`
//! table (NousResearch/hermes-agent `hermes_state_common.py`) keeps one running total per session: `input_tokens`
//! without either cache, `cache_read_tokens`, `cache_write_tokens`, `output_tokens` with `reasoning_tokens` inside it
//! (`agent/usage_pricing.py` `normalize_usage`). Each read counts a session's growth since the usage already counted
//! from the file, dated at the session's latest start, end or activity time, so the hour and day are coarse, and given
//! to the session's model. A session compressed into a new one starts the new one at zero. Only the id, model, times
//! and counters are selected, never prompts or messages. The full copies in `state-snapshots/` and `backups/` are not
//! read.
use super::adapters::{Adapter, SourceKind};
use super::opencode::has;
use super::parser::{Counted, EventMap, Object, epoch, file_name, keep, optional, text};
use super::zed::{counted, growth, open, record};
use std::path::Path;
use tokentracky_core::{ParseResult, SourceCapabilities, TokenCounts, ToolId, UsageEvent};

const COLUMNS: [&str; 9] = [
    "id",
    "model",
    "started_at",
    "ended_at",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
];

/// A session's running total: Hermes' kinds are ours already.
fn session_counts(row: &Object) -> Counted<TokenCounts> {
    Ok(TokenCounts {
        input: optional(row.get("input_tokens"))?,
        output: optional(row.get("output_tokens"))?,
        cache_read: optional(row.get("cache_read_tokens"))?,
        cache_write: optional(row.get("cache_write_tokens"))?,
        reasoning: Some(optional(row.get("reasoning_tokens"))?),
        cache_write_1h: None,
    })
}

fn read(path: &Path, known: &[UsageEvent]) -> rusqlite::Result<ParseResult> {
    let db = open(path)?;
    let (mut events, mut diagnostics) = (EventMap::default(), Vec::new());
    if has(&db, "sessions", &COLUMNS)? {
        let activity = if has(&db, "sessions", &["last_activity_at"])? {
            "coalesce(last_activity_at, started_at)"
        } else {
            "started_at"
        };
        // Times are seconds since the epoch, as reals.
        let sql = format!(
            "SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  CAST(round(max(coalesce(ended_at, started_at), {activity}, started_at) * 1000) AS INTEGER) AS updated
  FROM sessions ORDER BY started_at, id"
        );
        let counted = counted(known);
        let mut statement = db.prepare(&sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let row = record(row)?;
            let Some(session) = text(row.get("id"), 512) else {
                continue;
            };
            let model = text(row.get("model"), 256).unwrap_or("unknown");
            let event = session_counts(&row).and_then(|total| {
                let before = counted.get(session);
                growth(
                    ToolId::Hermes,
                    session,
                    model,
                    epoch(row.get("updated")),
                    total,
                    before,
                    &mut diagnostics,
                )
            });
            let mut kept = Vec::new();
            keep(event, &mut kept, &mut diagnostics);
            kept.into_iter().for_each(|event| events.insert(event));
        }
    }
    Ok(ParseResult {
        events: events.into_events(),
        diagnostics,
        withdrawn: None,
    })
}

/// `state.db`, but not the copies Hermes keeps of it (`hermes_cli/backup.py`).
fn kind(path: &Path) -> Option<SourceKind> {
    let copy = path
        .components()
        .any(|part| matches!(part.as_os_str().to_str(), Some("state-snapshots" | "backups")));
    (file_name(path) == "state.db" && !copy).then_some(SourceKind::Sqlite)
}

static HERMES: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: false,
        costs: false,
        quotas: false,
    },
    kind,
    ledger: true,
    document: None,
    sidecars: None,
    database: Some(read),
    // Read whole every time (a watermark of 0): the running totals are compared with what was counted.
    incremental: Some(|path, known, _| read(path, known).map(|result| (result, 0))),
    line: None,
    text: None,
    database_supersedes_documents: false,
};

/// The tool's adapter.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&HERMES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_main_and_profile_databases_but_not_their_copies() {
        let kind = |path: &str| kind(Path::new(path));
        assert_eq!(kind("/h/.hermes/state.db"), Some(SourceKind::Sqlite));
        assert_eq!(kind("/h/.hermes/profiles/work/state.db"), Some(SourceKind::Sqlite));
        assert_eq!(kind("/h/.hermes/state-snapshots/s1/state.db"), None);
        assert_eq!(kind("/h/.hermes/backups/b/state.db"), None);
        assert_eq!(kind("/h/.hermes/state.db.pre-update-emergency-1.bak"), None);
    }
}
