//! GitHub Copilot, from two local sources:
//! - `~/.copilot/session-store.db` (Copilot CLI 1.0.70+ and the Copilot App), opened read-only: only its
//!   `assistant_usage_events` table, one append-only row per request, read from the last row id seen. Input includes
//!   cache reads and writes, and reasoning is a "subset of outputTokens" (github/copilot-sdk
//!   `docs/features/streaming-events.md`).
//! - OpenTelemetry file exports, `*.jsonl` directly in `~/.copilot/otel` or `~/.copilot-otel`, which exist only when the
//!   user turned on Copilot's file exporter: Copilot Chat inference records with `gen_ai.operation.name` `chat`. In the
//!   GenAI semantic conventions input includes cache reads and writes and output includes reasoning.
//!
//! CLI chat spans (`type` `span`) are not read: the CLI also writes each request to the store, and a span shares no id
//! with its row, so it would count twice. Spans exported by a CLI older than the store are therefore not counted.
use super::adapters::{Adapter, SourceKind};
use super::parser::{
    Counted, Invalid, Object, ParserState, counter, date, epoch, field, file_name, is, keep, object, optional,
    parent_name, parse_json, safe_integer, safe_sum, text, usage_event,
};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Row};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tokentracky_core::{ParseResult, SourceCapabilities, TokenCounts, ToolId, UsageEvent};

static COPILOT: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: false,
        costs: false,
        quotas: false,
    },
    kind: |path| {
        let name = file_name(path);
        if name == "session-store.db" {
            Some(SourceKind::Sqlite)
        } else {
            let otel = matches!(&*parent_name(path), "otel" | ".copilot-otel");
            (otel && name.ends_with(".jsonl")).then_some(SourceKind::Jsonl)
        }
    },
    ledger: false,
    document: None,
    sidecars: None,
    database: Some(|path, known| read_store(path, known, 0).map(|(result, _)| result)),
    incremental: Some(read_store),
    line: Some(read_otel),
    text: None,
    database_supersedes_documents: false,
};

/// The tool's adapter.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&COPILOT)
}

/// Our kinds from inclusive counts: input less both caches, which it must hold; output with reasoning inside.
fn inclusive(input: u64, output: u64, read: u64, write: u64, reasoning: u64) -> Counted<TokenCounts> {
    Ok(TokenCounts {
        input: input.checked_sub(safe_sum(&[read, write])?).ok_or(Invalid)?,
        output,
        cache_read: read,
        cache_write: write,
        reasoning: Some(reasoning),
        cache_write_1h: None,
    })
}

const ROWS: &str = "SELECT id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, token_details_json, created_at FROM assistant_usage_events WHERE id > ? ORDER BY id";

/// The rows after `watermark` and the last row id. A store whose rows end below the watermark was replaced and is read
/// again from the start.
fn read_store(path: &Path, _: &[UsageEvent], watermark: u64) -> rusqlite::Result<(ParseResult, u64)> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    db.busy_timeout(Duration::from_millis(500))?;
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_usage_events')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok((ParseResult::default(), 0));
    }
    let last: i64 = db.query_row("SELECT coalesce(max(id), 0) FROM assistant_usage_events", [], |row| {
        row.get(0)
    })?;
    let from = if watermark > last.max(0) as u64 { 0 } else { watermark };
    let (mut events, mut diagnostics, mut next) = (Vec::new(), Vec::new(), from);
    let mut statement = db.prepare(ROWS)?;
    let mut rows = statement.query([from as i64])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        next = next.max(id.max(0) as u64);
        let values = (1..10)
            .map(|index| column(row, index))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        keep(
            store_event(id, &values, &mut diagnostics),
            &mut events,
            &mut diagnostics,
        );
    }
    let result = ParseResult {
        events,
        diagnostics,
        withdrawn: None,
    };
    Ok((result, next))
}

fn column(row: &Row, index: usize) -> rusqlite::Result<Value> {
    Ok(match row.get_ref(index)? {
        ValueRef::Integer(n) => Value::from(n),
        ValueRef::Real(n) => Value::from(n),
        ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
    })
}

/// One `assistant_usage_events` row: `[session_id, model, input, output, cache read, cache write, reasoning,
/// token_details_json, created_at]`.
fn store_event(id: i64, values: &[Value], diagnostics: &mut Vec<String>) -> Counted<Option<UsageEvent>> {
    let [session, model, input, output, read, write, reasoning, details, created] = values else {
        return Err(Invalid);
    };
    let Some(session) = text(Some(session), 512) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let input = optional(Some(input))?;
    let (input, read, write) = match split(details.as_str(), input) {
        Some(parts) => (input, parts[1], parts[2]),
        None => (input, optional(Some(read))?, optional(Some(write))?),
    };
    usage_event(
        ToolId::Copilot,
        &format!("store|{session}|{id}"),
        session,
        None,
        text(Some(model), 256).unwrap_or("unknown"),
        date(Some(created)),
        inclusive(input, optional(Some(output))?, read, write, optional(Some(reasoning))?)?,
    )
}

/// The exact prompt split `token_details_json` gives (input, cache read, cache write), when its parts add up to the
/// row's input.
fn split(details: Option<&str>, input: u64) -> Option<[u64; 3]> {
    let mut parts = [0u64; 3];
    for entry in parse_json(details?)?.as_array()? {
        let at = match field(entry.as_object(), "tokenType").and_then(Value::as_str) {
            Some("input") => 0,
            Some("cache_read") => 1,
            Some("cache_write") => 2,
            _ => continue,
        };
        parts[at] = parts[at].checked_add(counter(field(entry.as_object(), "tokenCount"), false).ok()?)?;
    }
    (safe_sum(&parts).ok()? == input).then_some(parts)
}

/// OpenTelemetry `[seconds, nanoseconds]`.
fn hr_time(value: Option<&Value>) -> Option<String> {
    let [seconds, nanos] = value?.as_array()?.as_slice() else {
        return None;
    };
    let ms = safe_integer(seconds)?
        .checked_mul(1000)?
        .checked_add(safe_integer(nanos)? / 1_000_000)?;
    epoch(Some(&Value::from(ms)))
}

/// One exported Copilot Chat log record, whose span context several requests can share, so it is keyed by the response
/// id. CLI spans are left to the store.
fn read_otel(
    record: &Object,
    _: &Path,
    _: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    if is(record.get("type"), "span") {
        return Ok(None);
    }
    let Some(attributes) = object(record.get("attributes")).filter(|a| is(a.get("gen_ai.operation.name"), "chat"))
    else {
        return Ok(None);
    };
    let count = |key: &str| optional(attributes.get(key));
    let write = match attributes.get("gen_ai.usage.cache_write.input_tokens") {
        Some(write) => optional(Some(write))?,
        None => count("gen_ai.usage.cache_creation.input_tokens")?,
    };
    let tokens = inclusive(
        count("gen_ai.usage.input_tokens")?,
        count("gen_ai.usage.output_tokens")?,
        count("gen_ai.usage.cache_read.input_tokens")?,
        write,
        count("gen_ai.usage.reasoning.output_tokens")?,
    )?;
    if tokentracky_core::total_tokens(&tokens) == 0 {
        return Ok(None);
    }
    let Some(response) = text(attributes.get("gen_ai.response.id"), 512) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let session = text(attributes.get("gen_ai.conversation.id"), 512)
        .or_else(|| text(field(object(record.get("spanContext")), "traceId"), 512))
        .unwrap_or(response);
    let model = text(attributes.get("gen_ai.response.model"), 256)
        .or_else(|| text(attributes.get("gen_ai.request.model"), 256))
        .unwrap_or("unknown");
    let occurred_at = hr_time(record.get("hrTime")).or_else(|| hr_time(record.get("hrTimeObserved")));
    usage_event(
        ToolId::Copilot,
        &format!("response|{response}"),
        session,
        None,
        model,
        occurred_at,
        tokens,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::readers::parse_usage_file;
    use serde_json::json;

    fn otel(record: Value) -> ParseResult {
        parse_usage_file(ToolId::Copilot, &record.to_string(), Path::new("/c/otel/a.jsonl"))
    }

    #[test]
    fn reads_only_the_store_and_the_exported_files() {
        let kind = |path: &str| (COPILOT.kind)(Path::new(path));
        assert_eq!(kind("/h/.copilot/session-store.db"), Some(SourceKind::Sqlite));
        assert_eq!(kind("/h/.copilot/otel/copilot-otel-1.jsonl"), Some(SourceKind::Jsonl));
        assert_eq!(kind("/h/.copilot-otel/copilot-otel-1.jsonl"), Some(SourceKind::Jsonl));
        for never in [
            "/h/.copilot/data.db",
            "/h/.copilot/auth.db",
            "/h/.copilot/session-store.db-wal",
            "/h/.copilot/session-state/s/events.jsonl",
            "/h/.copilot/otel/nested/a.jsonl",
            "/h/.copilot/otel/a.log",
        ] {
            assert_eq!(kind(never), None, "{never}");
        }
    }

    #[test]
    fn uses_the_detailed_split_only_when_it_adds_up_to_the_input() {
        let details = |parts: Value| Value::from(parts.to_string());
        let parts = json!([{"tokenType": "input", "tokenCount": 5, "batchSize": 1}, {"tokenType": "cache_read",
            "tokenCount": 40}, {"tokenType": "cache_write", "tokenCount": 5}, {"tokenType": "output", "tokenCount": 2}]);
        let row = |details: Value| {
            let values = [
                json!("s"),
                json!("gpt-5"),
                json!(50),
                json!(2),
                json!(30),
                json!(0),
                json!(1),
                details,
                json!("2026-07-10T10:00:00Z"),
            ];
            store_event(7, &values, &mut Vec::new())
                .map_err(|_| ())
                .map(|event| event.unwrap().tokens)
        };
        let exact = row(details(parts)).unwrap();
        assert_eq!(
            (exact.input, exact.cache_read, exact.cache_write, exact.output),
            (5, 40, 5, 2)
        );
        // Parts that do not add up, malformed JSON or none: the columns.
        for fallback in [
            details(json!([{"tokenType": "input", "tokenCount": 9}])),
            json!("{bad"),
            Value::Null,
        ] {
            let read = row(fallback.clone()).unwrap();
            assert_eq!(
                (read.input, read.cache_read, read.cache_write),
                (20, 30, 0),
                "{fallback}"
            );
            assert_eq!(read.reasoning, Some(1));
        }
    }

    #[test]
    fn reads_the_store_from_the_last_row_id_and_again_from_the_start_when_it_was_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session-store.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
              model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
              cache_write_tokens INTEGER, reasoning_tokens INTEGER, token_details_json TEXT, created_at TEXT);
             INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens)
              VALUES ('s', 'gpt-5', 10, 1), ('s', 'gpt-5', 20, 2), ('s', 'gpt-5', 30, 3);",
        )
        .unwrap();
        let read = |watermark| {
            let (result, next) = read_store(&path, &[], watermark).unwrap();
            let totals: Vec<u64> = result
                .events
                .iter()
                .map(|e| tokentracky_core::total_tokens(&e.tokens))
                .collect();
            (totals, next)
        };
        assert_eq!(read(0), (vec![11, 22, 33], 3));
        assert_eq!(read(2), (vec![33], 3));
        assert_eq!(read(3), (vec![], 3));
        assert_eq!(read(9), (vec![11, 22, 33], 3));
        let empty = directory.path().join("other.db");
        Connection::open(&empty)
            .unwrap()
            .execute_batch("CREATE TABLE t (x)")
            .unwrap();
        assert_eq!(read_store(&empty, &[], 5).unwrap(), (ParseResult::default(), 0));
    }

    #[test]
    fn reads_log_records_with_caches_inside_input_and_leaves_cli_spans_to_the_store() {
        let span = json!({"type": "span", "traceId": "t1", "spanId": "s1", "attributes": {
            "gen_ai.operation.name": "chat", "gen_ai.response.id": "msg_1", "gen_ai.usage.input_tokens": 1000,
            "gen_ai.usage.output_tokens": 300}});
        assert_eq!(otel(span), ParseResult::default());
        // Copilot Chat writes cache writes as cache_creation; they are still inside input, never added again.
        let record = |response: Option<&str>| {
            otel(
                json!({"hrTime": [1_792_746_000, 0], "spanContext": {"traceId": "t2", "spanId": "s2"},
                "attributes": {"event.name": "gen_ai.client.inference.operation.details",
                "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4.1", "gen_ai.response.id": response,
                "gen_ai.usage.input_tokens": 50, "gen_ai.usage.output_tokens": 5,
                "gen_ai.usage.cache_creation.input_tokens": 20}}),
            )
        };
        let chat = record(Some("chatcmpl-1"));
        assert_eq!(tokentracky_core::total_tokens(&chat.events[0].tokens), 55);
        assert_eq!(
            (chat.events[0].tokens.input, chat.events[0].session_id.as_str()),
            (30, "t2")
        );
        assert_eq!(record(None).diagnostics, ["missing_stable_identity"]);
        // Caches above input cannot be converted; other operations and metrics are not usage.
        let over = json!({"hrTime": [1_792_746_000, 0], "attributes": {"gen_ai.operation.name": "chat",
            "gen_ai.response.id": "chatcmpl-2", "gen_ai.usage.input_tokens": 5,
            "gen_ai.usage.cache_read.input_tokens": 6}});
        assert_eq!(otel(over).diagnostics, ["invalid_counters"]);
        let tool = json!({"hrTime": [1_792_746_000, 0], "attributes": {
            "gen_ai.operation.name": "execute_tool", "gen_ai.response.id": "chatcmpl-3", "gen_ai.usage.input_tokens": 5}});
        assert_eq!(otel(tool), ParseResult::default());
    }
}
