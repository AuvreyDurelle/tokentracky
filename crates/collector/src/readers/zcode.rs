//! ZCode (Z.ai): `~/.zcode/cli/db/db.sqlite`, opened read-only. Its `model_usage` table holds one row per model request
//! attempt (`docs/design/v2/usage-observability.md`); ZCode deletes rows older than 30 days, so it is read from a
//! watermark and usage once seen stays counted. ZCode also keeps token snapshots in its OpenCode-derived `message`
//! table, written for the same requests once `model_usage` exists, so a message counts only when it was last updated
//! before the first `model_usage` row. Both tables hold ZCode's `ModelUsage` (`docs/design/v2/model/token-usage.md`):
//! input includes both caches and output includes reasoning.
use super::adapters::{Adapter, SourceKind};
use super::iso;
use super::opencode::has;
use super::parser::{
    Counted, EventMap, Invalid, Object, TEXT_LIMIT, counter, epoch, event_id, field, file_name, note, object, optional,
    parse_json, safe_integer, safe_sum, text, usage_event,
};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Row};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;
use tokentracky_core::{ParseResult, SourceCapabilities, TokenCounts, ToolId, UsageEvent};

/// ZCode's bundled Claude Code, Codex and Gemini CLI sub-agents run under these providers, and those tools log the
/// same usage themselves. Z.ai and BigModel plans (`builtin:…`, `account:…`) and custom providers (a random id) are
/// ZCode's own.
const SUB_AGENTS: [&str; 3] = ["anthropic", "openai", "google"];
/// A request's row is written when it ends but dated when it started, so rows started up to a day before the newest
/// are read again.
const TAIL_MS: u64 = 24 * 60 * 60 * 1000;
const NATIVE: [&str; 15] = [
    "id",
    "logical_request_id",
    "attempt_index",
    "session_id",
    "provider_id",
    "model_id",
    "status",
    "started_at",
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "provider_total_tokens",
    "computed_total_tokens",
];
const LEGACY: [&str; 5] = ["id", "session_id", "time_created", "time_updated", "data"];
/// Completed attempts started from `?` on, with the provider's total, else ZCode's own.
fn native_rows(directory: bool) -> String {
    let (directory, join) = if directory {
        ("s.directory", "LEFT JOIN session s ON s.id = mu.session_id")
    } else {
        ("NULL", "")
    };
    format!(
        "SELECT mu.id, mu.logical_request_id, mu.attempt_index, mu.session_id, mu.provider_id, mu.model_id,
  mu.started_at, mu.input_tokens, mu.output_tokens, mu.reasoning_tokens, mu.cache_read_input_tokens,
  mu.cache_creation_input_tokens, coalesce(mu.provider_total_tokens, mu.computed_total_tokens) AS total,
  {directory} AS directory
  FROM model_usage mu {join} WHERE mu.status = 'completed' AND mu.started_at >= ? ORDER BY mu.started_at, mu.id"
    )
}
/// Assistant messages, without the copies a fork makes (`metadata.forkOrigin`). Only usage fields leave SQLite.
const LEGACY_ROWS: &str = "SELECT id, session_id AS session, time_updated AS updated,
  json_extract(data, '$.time.created') AS created,
  coalesce(json_extract(data, '$.providerID'), json_extract(data, '$.providerId')) AS provider,
  coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.modelId')) AS model,
  json_extract(data, '$.tokens') AS tokens, json_extract(data, '$.path.cwd') AS cwd
  FROM message WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.metadata.forkOrigin') IS NULL END
  ORDER BY time_created, id";

fn own(provider: Option<&Value>) -> bool {
    let provider = provider.and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    !provider.is_empty() && !SUB_AGENTS.iter().any(|sub| provider.contains(sub))
}

/// Our kinds from ZCode's inclusive counters. A record's total is its input plus output. A total that also counts both
/// caches is a row whose input left them out (an input of 0 makes ZCode total the caches), which ZCode's own
/// `inputSideTokensFromStoredUsage` reads the same way. Without a total, input includes both caches.
fn counts(input: u64, output: u64, reasoning: u64, read: u64, write: u64, total: Option<u64>) -> Counted<TokenCounts> {
    let cache = safe_sum(&[read, write])?;
    let input = match total {
        None => input.checked_sub(cache),
        Some(total) if total == safe_sum(&[input, output])? => input.checked_sub(cache),
        Some(total) if total == safe_sum(&[input, cache, output])? => Some(input),
        Some(_) => None,
    };
    Ok(TokenCounts {
        input: input.ok_or(Invalid)?,
        output,
        cache_read: read,
        cache_write: write,
        reasoning: Some(reasoning),
        cache_write_1h: None,
    })
}

/// A row as an object of its columns, so its counters are checked as every reader checks them.
fn record(row: &Row) -> rusqlite::Result<Object> {
    let statement = row.as_ref();
    (0..statement.column_count())
        .map(|index| {
            let value = match row.get_ref(index)? {
                ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                ValueRef::Integer(n) => Value::from(n),
                ValueRef::Real(n) => Value::from(n),
                ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text)),
            };
            Ok((statement.column_name(index)?.to_owned(), value))
        })
        .collect()
}

/// One `model_usage` attempt, keyed by its id (or request id and attempt), dated when it started.
fn native_event(row: &Object) -> Counted<Option<UsageEvent>> {
    let key = text(row.get("id"), 512).map(str::to_owned).or_else(|| {
        let request = text(row.get("logical_request_id"), 512)?;
        Some(format!("{request}#{}", safe_integer(row.get("attempt_index")?)?))
    });
    let (Some(key), Some(session)) = (key, text(row.get("session_id"), 512)) else {
        return Ok(None);
    };
    let tokens = counts(
        optional(row.get("input_tokens"))?,
        optional(row.get("output_tokens"))?,
        optional(row.get("reasoning_tokens"))?,
        optional(row.get("cache_read_input_tokens"))?,
        optional(row.get("cache_creation_input_tokens"))?,
        Some(optional(row.get("total"))?),
    )?;
    usage_event(
        ToolId::ZCode,
        &key,
        session,
        text(row.get("directory"), TEXT_LIMIT),
        text(row.get("model_id"), 256).unwrap_or("unknown"),
        epoch(row.get("started_at")),
        tokens,
    )
}

/// A legacy message's key, as OpenCode keys its messages.
fn legacy_key(row: &Object) -> Option<(String, &str)> {
    let session = text(row.get("session"), 512)?;
    Some((format!("{session}|{}", text(row.get("id"), 512)?), session))
}
fn legacy_event(row: &Object) -> Counted<Option<UsageEvent>> {
    let tokens = row.get("tokens").and_then(Value::as_str).and_then(parse_json);
    let (Some(Value::Object(tokens)), Some((key, session))) = (tokens, legacy_key(row)) else {
        return Ok(None);
    };
    let cache = object(tokens.get("cache"));
    let total = tokens.get("total").filter(|total| !total.is_null());
    let tokens = counts(
        optional(tokens.get("input"))?,
        optional(tokens.get("output"))?,
        optional(tokens.get("reasoning"))?,
        optional(field(cache, "read"))?,
        optional(field(cache, "write"))?,
        total.map(|total| counter(Some(total), false)).transpose()?,
    )?;
    usage_event(
        ToolId::ZCode,
        &key,
        session,
        text(row.get("cwd"), TEXT_LIMIT),
        text(row.get("model"), 256).unwrap_or("unknown"),
        epoch(row.get("created")),
        tokens,
    )
}

fn add(event: Counted<Option<UsageEvent>>, events: &mut EventMap, diagnostics: &mut Vec<String>) {
    match event {
        Ok(event) => event.into_iter().for_each(|event| events.insert(event)),
        Err(Invalid) => note(diagnostics, "invalid_counters"),
    }
}

/// The database from `watermark`: at 0 every completed `model_usage` row and the legacy messages before the first
/// row, otherwise the rows started at or after it. The next watermark is 0 while `model_usage` is empty, so legacy
/// messages keep being read.
pub(crate) fn read(path: &Path, known: &[UsageEvent], watermark: u64) -> rusqlite::Result<(ParseResult, u64)> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    db.busy_timeout(Duration::from_millis(500))?;
    db.execute_batch("BEGIN DEFERRED")?;
    let (mut events, mut diagnostics) = (EventMap::default(), Vec::new());
    let native = has(&db, "model_usage", &NATIVE)?;
    let (first, last): (Option<i64>, Option<i64>) = if native {
        db.query_row("SELECT min(started_at), max(started_at) FROM model_usage", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
    } else {
        (None, None)
    };
    let from = if first.is_some() { watermark } else { 0 };
    if from == 0 && has(&db, "message", &LEGACY)? {
        let mut statement = db.prepare(LEGACY_ROWS)?;
        let rows = statement.query_map([], record)?.collect::<rusqlite::Result<Vec<_>>>()?;
        // Once ZCode has deleted its oldest `model_usage` rows (or all of them), usage counted earlier that no message
        // explains was native, and the messages from then on repeat it. Before `model_usage` exists, such usage is
        // only deleted messages.
        let messages: HashSet<String> = rows
            .iter()
            .filter_map(|row| Some(event_id(ToolId::ZCode, &legacy_key(row)?.0)))
            .collect();
        let counted = known
            .iter()
            .filter(|event| native && !messages.contains(&event.event_id))
            .filter_map(|event| iso::parse(event.occurred_at.as_deref()?))
            .min();
        let boundary = first.into_iter().chain(counted).min();
        for row in rows.iter().filter(|row| own(row.get("provider"))) {
            let updated = row.get("updated").and_then(safe_integer);
            if boundary.is_none_or(|boundary| updated.is_some_and(|updated| updated < boundary)) {
                add(legacy_event(row), &mut events, &mut diagnostics);
            }
        }
    }
    if native {
        let mut statement = db.prepare(&native_rows(has(&db, "session", &["id", "directory"])?))?;
        let mut rows = statement.query([i64::try_from(from).unwrap_or(i64::MAX)])?;
        while let Some(row) = rows.next()? {
            let row = record(row)?;
            if own(row.get("provider_id")) {
                add(native_event(&row), &mut events, &mut diagnostics);
            }
        }
    }
    let next = last.map_or(0, |last| {
        u64::try_from(last).unwrap_or(0).saturating_sub(TAIL_MS).max(1)
    });
    let result = ParseResult {
        events: events.into_events(),
        diagnostics,
        withdrawn: None,
    };
    Ok((result, next))
}

static ZCODE: Adapter = Adapter {
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: false,
        quotas: false,
    },
    // Not its backups (`db.sqlite.bak-…`).
    kind: |path| (file_name(path) == "db.sqlite").then_some(SourceKind::Sqlite),
    ledger: true,
    document: None,
    sidecars: None,
    database: Some(|path, known| read(path, known, 0).map(|(result, _)| result)),
    incremental: Some(read),
    line: None,
    text: None,
    database_supersedes_documents: false,
};

pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&ZCODE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(tokens: Counted<TokenCounts>) -> Option<[u64; 5]> {
        let t = tokens.ok()?;
        Some([t.input, t.output, t.cache_read, t.cache_write, t.reasoning?])
    }

    #[test]
    fn splits_both_caches_out_of_input_and_keeps_reasoning_inside_output() {
        // input 5000 holds read 3000 and write 500; output 800 holds reasoning 300; total = input + output.
        assert_eq!(
            kinds(counts(5000, 800, 300, 3000, 500, Some(5800))),
            Some([1500, 800, 3000, 500, 300])
        );
        assert_eq!(
            kinds(counts(5000, 800, 300, 3000, 500, None)),
            Some([1500, 800, 3000, 500, 300])
        );
    }
    #[test]
    fn reads_input_without_caches_when_the_total_counts_them_too() {
        // ZCode totals the caches when input is 0.
        assert_eq!(kinds(counts(0, 50, 0, 400, 0, Some(450))), Some([0, 50, 400, 0, 0]));
        assert_eq!(kinds(counts(100, 50, 0, 300, 0, Some(450))), Some([100, 50, 300, 0, 0]));
    }
    #[test]
    fn rejects_totals_that_do_not_add_up_and_caches_above_input() {
        assert_eq!(kinds(counts(100, 50, 0, 0, 0, Some(9999))), None);
        assert_eq!(kinds(counts(100, 50, 0, 300, 0, Some(150))), None);
        assert_eq!(kinds(counts(100, 50, 0, 300, 0, None)), None);
    }
    #[test]
    fn keeps_only_zcodes_own_providers() {
        let own = |provider: &str| own(Some(&Value::from(provider)));
        assert!(own("builtin:zai-coding-plan") && own("account:bigmodel-team-coding-plan"));
        assert!(own("265956bf-0000-4000-8000-000000000001"));
        assert!(!own("anthropic") && !own("OpenAI") && !own("google-vertex") && !own(""));
        assert!(!super::own(None));
    }
}
