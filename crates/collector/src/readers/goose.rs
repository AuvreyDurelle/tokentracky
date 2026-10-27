//! Goose: `sessions.db` (block/goose `crates/goose/src/session/session_manager.rs`), opened read-only. Goose's
//! `input_tokens` include both caches, the cache columns are parts of it, output includes reasoning, and a total is
//! input plus output (`crates/goose-provider-types/src/conversation/token_usage.rs`); no reasoning count is kept.
//!
//! - `usage_ledger`: one row per model request, keyed by its row id and dated when it was written. When Goose first
//!   writes a ledger row for a session that predates the ledger, it adds a `carried_forward` row holding the session's
//!   earlier total; usage already counted for that session from its running total is taken out of it.
//! - Sessions without ledger rows: the `accumulated_*` running totals, of which each read counts the growth since the
//!   usage already counted from the file, dated when the session was last updated (coarse) and given to its model.
//!
//! Only ids, times, models and counters are selected, never messages or prompts.
use super::adapters::{Adapter, SourceKind};
use super::opencode::has;
use super::parser::{
    Counted, EventMap, Invalid, Object, counter, date, epoch, event_id, file_name, keep, note, optional, safe_sum,
    text, usage_event,
};
use super::zed::{Counts, counted, growth, open, record};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tokentracky_core::{ParseResult, SourceCapabilities, TokenCounts, ToolId, UsageEvent};

const SESSIONS: [&str; 8] = [
    "id",
    "updated_at",
    "model_config_json",
    "accumulated_input_tokens",
    "accumulated_output_tokens",
    "accumulated_total_tokens",
    "accumulated_cache_read_tokens",
    "accumulated_cache_write_tokens",
];
const LEDGER: [&str; 10] = [
    "id",
    "session_id",
    "created_timestamp",
    "model",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cost_source",
];
/// `updated_at` is SQLite's `CURRENT_TIMESTAMP`, in UTC.
const SESSION_ROWS: &str = "SELECT id, strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated,
  CASE WHEN json_valid(model_config_json) THEN json_extract(model_config_json, '$.model_name') END AS model,
  accumulated_input_tokens AS input, accumulated_output_tokens AS output, accumulated_total_tokens AS total,
  accumulated_cache_read_tokens AS cache_read, accumulated_cache_write_tokens AS cache_write
  FROM sessions ORDER BY id";
/// `created_timestamp` is seconds since the epoch.
const LEDGER_ROWS: &str = "SELECT id, session_id, created_timestamp * 1000 AS created, model, input_tokens AS input,
  output_tokens AS output, total_tokens AS total, cache_read_tokens AS cache_read, cache_write_tokens AS cache_write,
  cost_source FROM usage_ledger ORDER BY id";

/// Our kinds from Goose's: both caches leave input, and a total must be input plus output.
fn goose_counts(row: &Object) -> Counted<TokenCounts> {
    let (input, output) = (optional(row.get("input"))?, optional(row.get("output"))?);
    let (cache_read, cache_write) = (optional(row.get("cache_read"))?, optional(row.get("cache_write"))?);
    if let Some(total) = row.get("total").filter(|total| !total.is_null())
        && counter(Some(total), false)? != safe_sum(&[input, output])?
    {
        return Err(Invalid);
    }
    Ok(TokenCounts {
        input: input
            .checked_sub(safe_sum(&[cache_read, cache_write])?)
            .ok_or(Invalid)?,
        output,
        cache_read,
        cache_write,
        reasoning: None,
        cache_write_1h: None,
    })
}
/// `tokens` less what was counted before, or `None` where that is more.
fn less(tokens: TokenCounts, before: Option<&Counts>) -> Option<TokenCounts> {
    let before = before.copied().unwrap_or_default();
    Some(TokenCounts {
        input: tokens.input.checked_sub(before[0])?,
        output: tokens.output.checked_sub(before[1])?,
        cache_read: tokens.cache_read.checked_sub(before[2])?,
        cache_write: tokens.cache_write.checked_sub(before[3])?,
        ..tokens
    })
}
fn ledger_key(row: &Object) -> Option<(String, &str)> {
    let session = text(row.get("session_id"), 512)?;
    Some((format!("{session}|{}", row.get("id")?.as_i64()?), session))
}

fn read(path: &Path, known: &[UsageEvent]) -> rusqlite::Result<ParseResult> {
    let db = open(path)?;
    let (mut events, mut diagnostics) = (EventMap::default(), Vec::new());
    let mut add = |event, diagnostics: &mut Vec<String>| {
        let mut kept = Vec::new();
        keep(event, &mut kept, diagnostics);
        kept.into_iter().for_each(|event| events.insert(event));
    };
    let mut sessions = Vec::new();
    if has(&db, "sessions", &SESSIONS)? {
        let mut statement = db.prepare(SESSION_ROWS)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            sessions.push(record(row)?);
        }
    }
    let mut ledger = Vec::new();
    if has(&db, "usage_ledger", &LEDGER)? {
        let mut statement = db.prepare(LEDGER_ROWS)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            ledger.push(record(row)?);
        }
    }
    let models: HashMap<&str, &str> = sessions
        .iter()
        .filter_map(|row| Some((text(row.get("id"), 512)?, text(row.get("model"), 256)?)))
        .collect();
    // What was counted from running totals: everything counted from this file but the ledger's rows.
    let rows: HashSet<String> = ledger
        .iter()
        .filter_map(|row| Some(event_id(ToolId::Goose, &ledger_key(row)?.0)))
        .collect();
    let before = counted(known.iter().filter(|event| !rows.contains(&event.event_id)));
    for row in &ledger {
        let Some((key, session)) = ledger_key(row) else {
            continue;
        };
        let mut tokens = match goose_counts(row) {
            Ok(tokens) => tokens,
            Err(invalid) => {
                add(Err(invalid), &mut diagnostics);
                continue;
            }
        };
        if row.get("cost_source").and_then(Value::as_str) == Some("carried_forward") {
            let Some(rest) = less(tokens, before.get(session)) else {
                note(&mut diagnostics, "cumulative_reset_or_branch");
                continue;
            };
            tokens = rest;
        }
        let model = text(row.get("model"), 256).or_else(|| models.get(session).copied());
        let event = usage_event(
            ToolId::Goose,
            &key,
            session,
            None,
            model.unwrap_or("unknown"),
            epoch(row.get("created")),
            tokens,
        );
        add(event, &mut diagnostics);
    }
    let ledgered: HashSet<&str> = ledger
        .iter()
        .filter_map(|row| ledger_key(row).map(|(_, session)| session))
        .collect();
    for row in &sessions {
        let Some(session) = text(row.get("id"), 512).filter(|session| !ledgered.contains(session)) else {
            continue;
        };
        let model = text(row.get("model"), 256).unwrap_or("unknown");
        let event = goose_counts(row).and_then(|total| {
            growth(
                ToolId::Goose,
                session,
                model,
                date(row.get("updated")),
                total,
                before.get(session),
                &mut diagnostics,
            )
        });
        add(event, &mut diagnostics);
    }
    Ok(ParseResult {
        events: events.into_events(),
        diagnostics,
        withdrawn: None,
    })
}

static GOOSE: Adapter = Adapter {
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: false,
        costs: false,
        quotas: false,
    },
    kind: |path| (file_name(path) == "sessions.db").then_some(SourceKind::Sqlite),
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
    Some(&GOOSE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn counts(row: Value) -> Option<[u64; 4]> {
        let tokens = goose_counts(row.as_object()?).ok()?;
        Some([tokens.input, tokens.output, tokens.cache_read, tokens.cache_write])
    }
    #[test]
    fn takes_both_caches_out_of_input_and_checks_the_total() {
        let row = json!({"input": 1000, "output": 200, "total": 1200, "cache_read": 600, "cache_write": 100});
        assert_eq!(counts(row), Some([300, 200, 600, 100]));
        assert_eq!(
            counts(json!({"input": 1000, "output": 200, "total": null})),
            Some([1000, 200, 0, 0])
        );
        // A total with more than input and output is never read as reasoning.
        assert_eq!(counts(json!({"input": 1000, "output": 200, "total": 1250})), None);
        assert_eq!(counts(json!({"input": 100, "output": 2, "cache_read": 101})), None);
    }
}
