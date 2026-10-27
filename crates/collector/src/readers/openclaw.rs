//! OpenClaw: each agent's transcripts under `~/.openclaw/agents` (`OPENCLAW_STATE_DIR`), read without its plugin.
//!
//! - `<agent>/agent/openclaw-agent.sqlite`, opened read-only (openclaw/openclaw `src/state/openclaw-agent-schema.sql`):
//!   `transcript_events` rows of every session window but compaction checkpoints, whose events copy the transcript
//!   under new ids. An event is `event_json` text, of which SQLite returns only the usage fields, or a zstd frame
//!   (`event_zstd`) that is decoded in memory and dropped once those fields are read.
//! - `<agent>/sessions/<id>.jsonl` session logs and their `.jsonl.reset.<time>` and `.jsonl.deleted.<time>` archives,
//!   zstd-compressed (`.zst`) by current releases. Not read: `.jsonl.bak.*` compaction backups and cold archives.
//!
//! Usage is on assistant `message` entries: `message.usage` `{input, output, cacheRead, cacheWrite, totalTokens}`
//! (`packages/llm-core/src/types.ts`). Input leaves both caches out and output includes reasoning
//! (`packages/ai/src/providers/anthropic-usage.ts`, `packages/ai/src/transports/openai-transport-shared.ts`), so the
//! total must be their sum. The key is the entry id, a random UUID, so the same message in the database, a log and an
//! archive counts once.
use super::adapters::{Adapter, SourceKind};
use super::opencode::has;
use super::parser::{
    Counted, EventMap, Invalid, Object, ParserState, counter, date, field, file_name, is, is_metadata_text, keep, note,
    object, optional, parent_name, parse_json, safe_sum, text, usage_event,
};
use super::zed::{open, record, unpack};
use serde_json::{Map, Value, json};
use std::path::Path;
use tokentracky_core::{ParseResult, SourceCapabilities, TokenCounts, ToolId, UsageEvent};

/// Our kinds from a message's usage; a total must equal the four kinds.
fn usage_counts(usage: &Object) -> Counted<TokenCounts> {
    let (input, output) = (
        counter(usage.get("input"), false)?,
        counter(usage.get("output"), false)?,
    );
    let (cache_read, cache_write) = (optional(usage.get("cacheRead"))?, optional(usage.get("cacheWrite"))?);
    if let Some(total) = usage.get("totalTokens").filter(|total| !total.is_null())
        && counter(Some(total), false)? != safe_sum(&[input, output, cache_read, cache_write])?
    {
        return Err(Invalid);
    }
    let reasoning = usage.get("reasoningTokens").filter(|reasoning| !reasoning.is_null());
    Ok(TokenCounts {
        input,
        output,
        cache_read,
        cache_write,
        reasoning: reasoning.map(|reasoning| counter(Some(reasoning), false)).transpose()?,
        cache_write_1h: None,
    })
}
/// One transcript entry of `session`: the usage of an assistant message, keyed by the entry id.
fn entry_event(entry: &Object, session: &str, diagnostics: &mut Vec<String>) -> Counted<Option<UsageEvent>> {
    let message = object(entry.get("message"));
    let usage = object(field(message, "usage"));
    let (true, true, Some(usage)) = (
        is(entry.get("type"), "message"),
        is(field(message, "role"), "assistant"),
        usage,
    ) else {
        return Ok(None);
    };
    let Some(id) = text(entry.get("id"), 512) else {
        note(diagnostics, "missing_stable_identity");
        return Ok(None);
    };
    let model = text(field(message, "model"), 256).unwrap_or("unknown");
    usage_event(
        ToolId::OpenClaw,
        id,
        session,
        None,
        model,
        date(entry.get("timestamp")),
        usage_counts(usage)?,
    )
}

/// A session log line. The `session` header names the session; without one, the file name does.
fn line(
    record: &Object,
    path: &Path,
    state: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    if is(record.get("type"), "session") {
        if state.session_id.is_none() {
            state.session_id = text(record.get("id"), 512).map(Into::into);
        }
        return Ok(None);
    }
    let name = file_name(path);
    let stem = name.split(".jsonl").next().filter(|stem| is_metadata_text(stem, 512));
    let Some(session) = state.session_id.as_deref().or(stem) else {
        note(diagnostics, "missing_stable_identity");
        return Ok(None);
    };
    entry_event(record, session, diagnostics)
}

/// Assistant events of every window but compaction checkpoints; a compressed event is returned whole, to be decoded.
fn events_sql(packed: bool, roles: bool) -> String {
    let (packed, filter) = match (packed, roles) {
        (false, _) => ("NULL", ""),
        (true, false) => ("e.event_zstd", ""),
        (true, true) => (
            "e.event_zstd",
            "AND (e.event_json IS NOT NULL OR e.message_role = 'assistant')",
        ),
    };
    format!(
        "WITH e AS (
    SELECT e.session_id, e.seq, CASE WHEN json_valid(e.event_json) THEN e.event_json END AS event,
      CASE WHEN e.event_json IS NULL THEN {packed} END AS packed
    FROM transcript_events e JOIN session_windows w ON w.session_id = e.session_id
    WHERE w.reason IS NOT 'compaction' {filter})
  SELECT session_id, json_extract(event, '$.type') AS type, json_extract(event, '$.id') AS id,
    json_extract(event, '$.timestamp') AS timestamp, json_extract(event, '$.message.role') AS role,
    json_extract(event, '$.message.model') AS model, json_extract(event, '$.message.usage') AS usage, packed
  FROM e WHERE json_extract(event, '$.message.role') = 'assistant' OR packed IS NOT NULL
  ORDER BY session_id, seq"
    )
}
/// The entry a row stands for: the usage fields SQLite returned, or a compressed event decoded. `Err` is a code.
fn row_entry(row: &Object, packed: Option<&[u8]>) -> Result<Object, &'static str> {
    if let Some(packed) = packed {
        let bytes = unpack(packed)?;
        return match serde_json::from_slice(&bytes) {
            Ok(Value::Object(entry)) => Ok(entry),
            _ => Err("malformed_json"),
        };
    }
    let usage = row.get("usage").and_then(Value::as_str).and_then(parse_json);
    let entry = json!({"type": row.get("type"), "id": row.get("id"), "timestamp": row.get("timestamp"),
        "message": {"role": row.get("role"), "model": row.get("model"), "usage": usage}});
    Ok(entry.as_object().cloned().unwrap_or_else(Map::new))
}

fn read(path: &Path, _known: &[UsageEvent]) -> rusqlite::Result<ParseResult> {
    let db = open(path)?;
    let (mut events, mut diagnostics) = (EventMap::default(), Vec::new());
    if has(&db, "transcript_events", &["session_id", "seq", "event_json"])?
        && has(&db, "session_windows", &["session_id", "reason"])?
    {
        let packed = has(&db, "transcript_events", &["event_zstd"])?;
        let roles = has(&db, "transcript_events", &["message_role"])?;
        let mut statement = db.prepare(&events_sql(packed, roles))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let blob = row.get_ref("packed")?.as_blob_or_null()?.map(<[u8]>::to_vec);
            let row = record(row)?;
            let Some(session) = text(row.get("session_id"), 512) else {
                continue;
            };
            let entry = match row_entry(&row, blob.as_deref()) {
                Ok(entry) => entry,
                Err(code) => {
                    note(&mut diagnostics, code);
                    continue;
                }
            };
            let mut kept = Vec::new();
            let event = entry_event(&entry, session, &mut diagnostics);
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

/// The agent database, and session logs with their reset and deletion archives.
fn kind(path: &Path) -> Option<SourceKind> {
    let name = file_name(path);
    if name == "openclaw-agent.sqlite" {
        return Some(SourceKind::Sqlite);
    }
    if parent_name(path) != "sessions" {
        return None;
    }
    let archive = name.contains(".jsonl.reset.") || name.contains(".jsonl.deleted.");
    if name.ends_with(".jsonl") || (archive && !name.ends_with(".zst")) {
        Some(SourceKind::Jsonl)
    } else {
        archive.then_some(SourceKind::CompressedJsonl)
    }
}

static OPENCLAW: Adapter = Adapter {
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
    // Read whole every time (a watermark of 0).
    incremental: Some(|path, known, _| read(path, known).map(|result| (result, 0))),
    line: Some(line),
    text: None,
    database_supersedes_documents: false,
};

/// The tool's adapter.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&OPENCLAW)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_cache_out_of_input_and_checks_the_total() {
        let usage = json!({"input": 20, "output": 30, "cacheRead": 800, "cacheWrite": 100, "totalTokens": 950});
        let tokens = usage_counts(usage.as_object().unwrap()).ok().unwrap();
        assert_eq!(
            [tokens.input, tokens.output, tokens.cache_read, tokens.cache_write],
            [20, 30, 800, 100]
        );
        // A total that counts the cache read inside input as well is not subtracted a second time.
        let usage = json!({"input": 100, "output": 20, "cacheRead": 80, "cacheWrite": 10, "totalTokens": 130});
        assert!(usage_counts(usage.as_object().unwrap()).is_err());
    }
    #[test]
    fn reads_logs_and_their_archives_but_not_backups() {
        let kind = |path: &str| kind(Path::new(path));
        assert_eq!(kind("/a/main/agent/openclaw-agent.sqlite"), Some(SourceKind::Sqlite));
        assert_eq!(kind("/a/main/sessions/s.jsonl"), Some(SourceKind::Jsonl));
        assert_eq!(
            kind("/a/main/sessions/s.jsonl.reset.2026-10-20T10-00-00.000Z"),
            Some(SourceKind::Jsonl)
        );
        assert_eq!(
            kind("/a/main/sessions/s.jsonl.deleted.2026-10-20T10-00-00.000Z.zst"),
            Some(SourceKind::CompressedJsonl)
        );
        assert_eq!(kind("/a/main/sessions/s.jsonl.bak.1"), None);
        assert_eq!(kind("/a/main/sessions/cold/x.jsonl.zst"), None);
        assert_eq!(kind("/a/main/other/s.jsonl"), None);
    }
}
