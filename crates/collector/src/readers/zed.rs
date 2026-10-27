//! Zed Agent: `~/Library/Application Support/Zed/threads/threads.db`, opened read-only. Each row of its `threads`
//! table holds a whole thread as JSON, zstd-compressed by current releases (`data_type` `zstd`; zed-industries/zed
//! `crates/agent/src/db.rs`). It is decoded in memory and only the thread's `cumulative_token_usage` and `model` are
//! kept; messages are never read into our structures.
//!
//! Zed's provider converters take both caches out of input (`crates/google_ai/src/completion.rs`), so input is
//! disjoint; output includes reasoning, except that Zed drops Gemini's thought tokens. The cumulative total only grows
//! (`Thread::accumulate_token_usage`; truncating a thread does not lower it), so each read counts its growth since the
//! usage already counted from the file, dated when the thread was last saved and given to the thread's model at that
//! time. Zed's per-request `request_token_usage` is not read: it keeps only the latest request of each turn, and a
//! context overflow writes a synthetic one.
//!
//! The helpers below the adapter serve the other readers of per-session running totals (Hermes Agent, Goose).
use super::adapters::{Adapter, MAX_DOCUMENT_BYTES, SourceKind};
use super::opencode::has;
use super::parser::{
    Counted, EventMap, Invalid, Object, date, field, file_name, keep, note, object, optional, text, usage_event,
};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Row};
use ruzstd::decoding::StreamingDecoder;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::time::Duration;
use tokentracky_core::{ParseResult, SourceCapabilities, TokenCounts, ToolId, UsageEvent};

/// The fields of a thread that are read; serde skips the rest (messages, summaries, drafts) without keeping them.
#[derive(Deserialize)]
struct Thread {
    #[serde(default)]
    cumulative_token_usage: Option<Value>,
    #[serde(default)]
    model: Option<Value>,
    #[serde(default)]
    imported: Option<Value>,
}

/// A thread blob: plain JSON, or one zstd frame of it. `Err` is a diagnostic code.
fn decode(data_type: Option<&str>, data: &[u8]) -> Result<Thread, &'static str> {
    let unpacked;
    let json = match data_type {
        Some("json") => data,
        Some("zstd") => {
            unpacked = unpack(data)?;
            &unpacked[..]
        }
        _ => return Err("invalid_record"),
    };
    serde_json::from_slice(json).map_err(|_| "malformed_json")
}
/// One zstd frame, decompressed in memory up to [`MAX_DOCUMENT_BYTES`]. `Err` is a diagnostic code.
pub(super) fn unpack(data: &[u8]) -> Result<Vec<u8>, &'static str> {
    let decoder = StreamingDecoder::new(data).map_err(|_| "invalid_record")?;
    let mut bytes = Vec::new();
    decoder
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "invalid_record")?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("record_too_large");
    }
    Ok(bytes)
}

/// A thread's running total in our kinds: Zed's input already leaves both caches out.
fn thread_counts(usage: Option<&Object>) -> Counted<TokenCounts> {
    Ok(TokenCounts {
        input: optional(field(usage, "input_tokens"))?,
        output: optional(field(usage, "output_tokens"))?,
        cache_read: optional(field(usage, "cache_read_input_tokens"))?,
        cache_write: optional(field(usage, "cache_creation_input_tokens"))?,
        reasoning: None,
        cache_write_1h: None,
    })
}

fn read(path: &Path, known: &[UsageEvent]) -> rusqlite::Result<ParseResult> {
    let db = open(path)?;
    let (mut events, mut diagnostics) = (EventMap::default(), Vec::new());
    if has(&db, "threads", &["id", "updated_at", "data_type", "data"])? {
        let counted = counted(known);
        let mut statement =
            db.prepare("SELECT id, updated_at, data_type, data FROM threads ORDER BY updated_at, id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let (id, updated) = (value(row, 0)?, value(row, 1)?);
            let Some(id) = text(Some(&id), 512) else {
                note(&mut diagnostics, "missing_stable_identity");
                continue;
            };
            let thread = match row.get_ref(3)? {
                ValueRef::Blob(data) | ValueRef::Text(data) => decode(row.get_ref(2)?.as_str().ok(), data),
                _ => Err("invalid_record"),
            };
            let thread = match thread {
                Ok(thread) => thread,
                Err(code) => {
                    note(&mut diagnostics, code);
                    continue;
                }
            };
            if thread.imported.as_ref().and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let model = text(field(object(thread.model.as_ref()), "model"), 256).unwrap_or("unknown");
            let event = thread_counts(object(thread.cumulative_token_usage.as_ref())).and_then(|total| {
                let before = counted.get(id);
                growth(
                    ToolId::Zed,
                    id,
                    model,
                    date(Some(&updated)),
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

static ZED: Adapter = Adapter {
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: false,
        costs: false,
        quotas: false,
    },
    kind: |path| (file_name(path) == "threads.db").then_some(SourceKind::Sqlite),
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
    Some(&ZED)
}

/// A database opened read-only, inside one read transaction so every query sees the same snapshot.
pub(super) fn open(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    db.busy_timeout(Duration::from_millis(500))?;
    db.execute_batch("BEGIN DEFERRED")?;
    Ok(db)
}
/// A column as a JSON value, so its counters are checked as every reader checks them. A blob reads as `null`.
pub(super) fn value(row: &Row, index: usize) -> rusqlite::Result<Value> {
    Ok(match row.get_ref(index)? {
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
        ValueRef::Integer(n) => Value::from(n),
        // An integral real reads as an integer, as JavaScript reads it.
        ValueRef::Real(n) if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 => Value::from(n as i64),
        ValueRef::Real(n) => Value::from(n),
        ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text)),
    })
}
/// A row as an object of its named columns.
pub(super) fn record(row: &Row) -> rusqlite::Result<Object> {
    let statement = row.as_ref();
    (0..statement.column_count())
        .map(|index| Ok((statement.column_name(index)?.to_owned(), value(row, index)?)))
        .collect()
}

/// What has been counted from a file per session: input, output, cache read, cache write and reasoning.
pub(super) type Counts = [u64; 5];
pub(super) fn counted<'a>(known: impl IntoIterator<Item = &'a UsageEvent>) -> HashMap<&'a str, Counts> {
    let mut sums: HashMap<&str, Counts> = HashMap::new();
    for event in known {
        let tokens = &event.tokens;
        let sum = sums.entry(&event.session_id).or_default();
        let kinds = [
            tokens.input,
            tokens.output,
            tokens.cache_read,
            tokens.cache_write,
            tokens.reasoning.unwrap_or(0),
        ];
        for (sum, kind) in sum.iter_mut().zip(kinds) {
            *sum = sum.saturating_add(kind);
        }
    }
    sums
}
/// The usage a session's running `total` gained over what was already counted from the file (`before`): a new event
/// keyed by the session and the new total, so the days already counted stay as they were. Nothing when the total did
/// not grow; when any kind went down (a reset or a replaced session), usage once seen stays and nothing is added.
pub(super) fn growth(
    tool: ToolId,
    session: &str,
    model: &str,
    occurred_at: Option<String>,
    total: TokenCounts,
    before: Option<&Counts>,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    if total.reasoning.unwrap_or(0) > total.output {
        return Err(Invalid);
    }
    let before = before.copied().unwrap_or_default();
    let now = [total.input, total.output, total.cache_read, total.cache_write];
    if now.iter().zip(before).any(|(now, before)| *now < before) {
        note(diagnostics, "cumulative_reset_or_branch");
        return Ok(None);
    }
    let output = now[1] - before[1];
    let tokens = TokenCounts {
        input: now[0] - before[0],
        output,
        cache_read: now[2] - before[2],
        cache_write: now[3] - before[3],
        reasoning: total
            .reasoning
            .map(|reasoning| reasoning.saturating_sub(before[4]).min(output)),
        cache_write_1h: None,
    };
    let key = format!("{session}|{}|{}|{}|{}", now[0], now[1], now[2], now[3]);
    usage_event(tool, &key, session, None, model, occurred_at, tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(input: u64, output: u64, cache_read: u64, cache_write: u64, reasoning: Option<u64>) -> TokenCounts {
        TokenCounts {
            input,
            output,
            cache_read,
            cache_write,
            reasoning,
            cache_write_1h: None,
        }
    }
    #[test]
    fn decodes_json_and_zstd_threads_and_keeps_only_usage_and_model() {
        let json = br#"{"title":"PRIVATE_TITLE","messages":[{"User":{"content":"PRIVATE_PROMPT"}}],"model":{"provider":"zed.dev","model":"claude-sonnet-4-6"},"cumulative_token_usage":{"input_tokens":5,"output_tokens":2}}"#;
        let packed = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x11, 0x00, 0x00, b'{', b'}'];
        let thread = decode(Some("json"), json).unwrap();
        assert_eq!(thread.cumulative_token_usage.unwrap()["input_tokens"], 5);
        assert_eq!(thread.model.unwrap()["model"], "claude-sonnet-4-6");
        assert!(decode(Some("zstd"), &packed).is_ok());
        assert_eq!(decode(Some("zstd"), json).err(), Some("invalid_record"));
        assert_eq!(decode(Some("bogus"), json).err(), Some("invalid_record"));
        assert_eq!(decode(Some("json"), b"{").err(), Some("malformed_json"));
    }
    #[test]
    fn counts_only_the_growth_of_a_running_total() {
        let mut diagnostics = Vec::new();
        let total = tokens(100, 40, 1000, 50, Some(10));
        let first = growth(ToolId::Zed, "t", "m", None, total.clone(), None, &mut diagnostics)
            .ok()
            .flatten()
            .unwrap();
        assert_eq!(first.tokens, total);
        let before = counted([&first]);
        let same = growth(
            ToolId::Zed,
            "t",
            "m",
            None,
            total.clone(),
            before.get("t"),
            &mut diagnostics,
        );
        assert!(matches!(same, Ok(None)));
        let grown = tokens(150, 60, 1800, 50, Some(15));
        let next = growth(ToolId::Zed, "t", "m", None, grown, before.get("t"), &mut diagnostics)
            .ok()
            .flatten()
            .unwrap();
        assert_eq!(next.tokens, tokens(50, 20, 800, 0, Some(5)));
        assert_ne!(next.event_id, first.event_id);
        assert!(diagnostics.is_empty());
        let lower = tokens(90, 60, 1800, 50, None);
        let reset = growth(ToolId::Zed, "t", "m", None, lower, before.get("t"), &mut diagnostics);
        assert!(matches!(reset, Ok(None)));
        assert_eq!(diagnostics, ["cumulative_reset_or_branch"]);
    }
}
