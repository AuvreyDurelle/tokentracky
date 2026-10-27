//! Unsloth Studio: `studio.db` in its install folder (`UNSLOTH_STUDIO_HOME`, else `~/.unsloth/studio`; other accounts
//! keep theirs under `accounts/<id>/`), opened read-only (unslothai/unsloth `studio/backend/storage/studio_db.py`).
//! Only usage fields leave SQLite, never message content.
//!
//! - Chat replies: assistant `chat_messages` whose `metadata_json` holds `contextUsage` (`promptTokens`,
//!   `completionTokens`, `totalTokens`, `cachedTokens`, `cacheWriteTokens`, `modelId`: the requested checkpoint) and
//!   `responseDetails` (`responseModelId`, the model that answered, and `providerType`, `local` for a model running in
//!   Studio). Prompt tokens include both caches (`studio/backend/core/inference/pricing.py`) and the total is prompt
//!   plus completion. A tool loop sums its passes into one record. A route is local unless its provider type says
//!   otherwise or it requested an `external::` model; local models run on this computer and are named `local/<model>`.
//!   Usage Studio estimated (`estimated`) is skipped. Rows are finalised in place, so the whole table is read again.
//! - Forking a chat copies its earlier messages into the new thread with fresh ids but the same `created_at`
//!   (`fork_chat_thread`), so a reply is keyed by the thread it was first written in (following `forked_from_thread_id`
//!   while the message predates the fork) and its time: a copy counts once, and still counts once the original is gone.
//! - `api_usage_events`: one receipt per request made to Studio's API with an API key, holding prompt, completion and
//!   total tokens with no cache split, keyed by the receipt id. Such a request may run a local model or be passed to a
//!   connected provider, and the receipt does not say which, so its model is kept as written.
use super::adapters::{Adapter, SourceKind};
use super::opencode::has;
use super::parser::{
    Counted, EventMap, Invalid, Object, counter, epoch, file_name, is_metadata_text, keep, note, optional, safe_sum,
    text, usage_event,
};
use super::zed::{open, record};
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use tokentracky_core::{ParseResult, SourceCapabilities, TokenCounts, ToolId, UsageEvent};

const EXTERNAL: &str = "external::";
/// Assistant messages with usage, and only their usage and model fields.
const MESSAGES: &str = "WITH m AS (
    SELECT id, thread_id, created_at, CASE WHEN json_valid(metadata_json) THEN metadata_json END AS meta
    FROM chat_messages WHERE role = 'assistant')
  SELECT thread_id, created_at,
    json_extract(meta, '$.contextUsage.promptTokens') AS prompt,
    json_extract(meta, '$.contextUsage.completionTokens') AS completion,
    json_extract(meta, '$.contextUsage.totalTokens') AS total,
    json_extract(meta, '$.contextUsage.cachedTokens') AS cached,
    json_extract(meta, '$.contextUsage.cacheWriteTokens') AS written,
    json_extract(meta, '$.contextUsage.estimated') AS estimated,
    json_extract(meta, '$.contextUsage.modelId') AS requested,
    json_extract(meta, '$.responseDetails.responseModelId') AS answered,
    json_extract(meta, '$.responseDetails.providerType') AS provider
  FROM m WHERE json_type(meta, '$.contextUsage') = 'object' AND json_extract(meta, '$.importedFrom') IS NULL
  ORDER BY created_at, id";
const RECEIPTS: &str =
    "SELECT id, model, prompt_tokens, completion_tokens, total_tokens, created_at FROM api_usage_events
  ORDER BY created_at, id";

/// A thread's creation time, the thread it was forked from and its model.
struct Thread {
    created: i64,
    parent: Option<String>,
    model: Option<String>,
}
fn threads(db: &Connection) -> rusqlite::Result<HashMap<String, Thread>> {
    let parent = if has(db, "chat_threads", &["forked_from_thread_id"])? {
        "forked_from_thread_id"
    } else {
        "NULL"
    };
    let mut statement = db.prepare(&format!("SELECT id, created_at, {parent}, model_id FROM chat_threads"))?;
    let rows = statement.query_map([], |row| {
        let thread = Thread {
            created: row.get::<_, Option<i64>>(1)?.unwrap_or(i64::MIN),
            parent: row.get(2)?,
            model: row.get(3)?,
        };
        Ok((row.get::<_, String>(0)?, thread))
    })?;
    rows.collect()
}
/// The thread a message written at `created` in `thread` was first written in: a fork's copies predate the fork.
fn origin<'a>(threads: &'a HashMap<String, Thread>, mut thread: &'a str, created: i64) -> &'a str {
    for _ in 0..threads.len() {
        match threads.get(thread) {
            Some(Thread {
                created: forked,
                parent: Some(parent),
                ..
            }) if created < *forked => thread = parent,
            _ => break,
        }
    }
    thread
}

/// Our kinds from a reply's `contextUsage`: prompt tokens include both caches; the total is prompt plus completion.
fn reply_counts(prompt: u64, completion: u64, total: u64, cached: u64, written: u64) -> Counted<TokenCounts> {
    if total != safe_sum(&[prompt, completion])? {
        return Err(Invalid);
    }
    Ok(TokenCounts {
        input: prompt.checked_sub(safe_sum(&[cached, written])?).ok_or(Invalid)?,
        output: completion,
        cache_read: cached,
        cache_write: written,
        reasoning: None,
        cache_write_1h: None,
    })
}
/// The model a reply is priced by: the one that answered on a provider's route, `local/<model>` on a local one.
fn reply_model(provider: Option<&str>, requested: Option<&str>, answered: Option<&str>) -> String {
    let external = provider.is_some_and(|provider| provider != "local")
        || requested.is_some_and(|model| model.starts_with(EXTERNAL));
    let answered = answered.filter(|model| !model.starts_with(EXTERNAL));
    match (external, answered.or(requested)) {
        (true, _) => answered.unwrap_or("unknown").to_owned(),
        (false, Some(model)) => format!("local/{model}"),
        (false, None) => "unknown".to_owned(),
    }
}
fn reply(row: &Object, threads: &HashMap<String, Thread>) -> Counted<Option<UsageEvent>> {
    let (Some(thread), Some(created)) = (
        text(row.get("thread_id"), 512),
        row.get("created_at").and_then(Value::as_i64),
    ) else {
        return Ok(None);
    };
    let tokens = reply_counts(
        counter(row.get("prompt"), false)?,
        counter(row.get("completion"), false)?,
        counter(row.get("total"), false)?,
        optional(row.get("cached"))?,
        optional(row.get("written"))?,
    )?;
    // 250 leaves room for the `local/` prefix within the 256-character model limit.
    let fallback = threads.get(thread).and_then(|thread| thread.model.as_deref());
    let requested = text(row.get("requested"), 250).or(fallback.filter(|model| is_metadata_text(model, 250)));
    let model = reply_model(
        row.get("provider").and_then(Value::as_str),
        requested,
        text(row.get("answered"), 250),
    );
    let session = origin(threads, thread, created);
    let key = format!("{session}|{created}");
    usage_event(
        ToolId::Unsloth,
        &key,
        session,
        None,
        &model,
        epoch(row.get("created_at")),
        tokens,
    )
}
/// An API receipt: no cache split, so input is the whole prompt; the total is prompt plus completion.
fn receipt(row: &Object) -> Counted<Option<UsageEvent>> {
    let Some(id) = text(row.get("id"), 512) else {
        return Ok(None);
    };
    let (prompt, completion) = (
        counter(row.get("prompt_tokens"), false)?,
        counter(row.get("completion_tokens"), false)?,
    );
    if counter(row.get("total_tokens"), false)? != safe_sum(&[prompt, completion])? {
        return Err(Invalid);
    }
    let tokens = TokenCounts {
        input: prompt,
        output: completion,
        cache_read: 0,
        cache_write: 0,
        reasoning: None,
        cache_write_1h: None,
    };
    let model = text(row.get("model"), 256).unwrap_or("unknown");
    usage_event(
        ToolId::Unsloth,
        &format!("api|{id}"),
        "api",
        None,
        model,
        epoch(row.get("created_at")),
        tokens,
    )
}

fn read(path: &Path, _known: &[UsageEvent]) -> rusqlite::Result<ParseResult> {
    let db = open(path)?;
    let (mut events, mut diagnostics) = (EventMap::default(), Vec::new());
    let mut add = |event, diagnostics: &mut Vec<String>| {
        let mut kept = Vec::new();
        keep(event, &mut kept, diagnostics);
        kept.into_iter().for_each(|event| events.insert(event));
    };
    let chats = has(
        &db,
        "chat_messages",
        &["id", "thread_id", "role", "metadata_json", "created_at"],
    )? && has(&db, "chat_threads", &["id", "created_at", "model_id"])?;
    if chats {
        let threads = threads(&db)?;
        let mut statement = db.prepare(MESSAGES)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let row = record(row)?;
            if row
                .get("estimated")
                .is_some_and(|estimated| estimated.as_i64() == Some(1))
            {
                note(&mut diagnostics, "estimated_usage_skipped");
                continue;
            }
            add(reply(&row, &threads), &mut diagnostics);
        }
    }
    let receipts = [
        "id",
        "model",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "created_at",
    ];
    if has(&db, "api_usage_events", &receipts)? {
        let mut statement = db.prepare(RECEIPTS)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            add(receipt(&record(row)?), &mut diagnostics);
        }
    }
    Ok(ParseResult {
        events: events.into_events(),
        diagnostics,
        withdrawn: None,
    })
}

static UNSLOTH: Adapter = Adapter {
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: false,
        costs: false,
        quotas: false,
    },
    kind: |path| (file_name(path) == "studio.db").then_some(SourceKind::Sqlite),
    ledger: true,
    document: None,
    sidecars: None,
    database: Some(read),
    // Read whole every time (a watermark of 0): replies are finished in place.
    incremental: Some(|path, known, _| read(path, known).map(|result| (result, 0))),
    line: None,
    text: None,
    database_supersedes_documents: false,
};

/// The tool's adapter.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&UNSLOTH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_both_caches_out_of_the_prompt_and_checks_the_total() {
        let tokens = reply_counts(1000, 200, 1200, 600, 100).ok().unwrap();
        assert_eq!(
            [tokens.input, tokens.output, tokens.cache_read, tokens.cache_write],
            [300, 200, 600, 100]
        );
        assert!(reply_counts(1000, 200, 1300, 600, 100).is_err());
        assert!(reply_counts(500, 200, 700, 600, 100).is_err());
    }
    #[test]
    fn names_local_routes_and_the_model_that_answered_a_provider() {
        assert_eq!(
            reply_model(Some("local"), Some("unsloth/q"), Some("q.gguf")),
            "local/q.gguf"
        );
        assert_eq!(reply_model(None, Some("unsloth/q"), None), "local/unsloth/q");
        assert_eq!(
            reply_model(Some("openai"), Some("external::p::gpt"), Some("gpt-5")),
            "gpt-5"
        );
        // A request to a connection that no longer exists still names an external model.
        assert_eq!(
            reply_model(Some("local"), Some("external::p::gpt"), Some("external::p::gpt")),
            "unknown"
        );
        assert_eq!(reply_model(Some("local"), None, None), "unknown");
    }
    #[test]
    fn follows_forks_back_to_the_thread_a_message_was_written_in() {
        let thread = |created, parent: Option<&str>| Thread {
            created,
            parent: parent.map(Into::into),
            model: None,
        };
        let threads = HashMap::from([
            ("a".to_owned(), thread(10, None)),
            ("b".to_owned(), thread(20, Some("a"))),
            ("c".to_owned(), thread(30, Some("b"))),
        ]);
        assert_eq!(origin(&threads, "c", 15), "a");
        assert_eq!(origin(&threads, "c", 25), "b");
        assert_eq!(origin(&threads, "c", 35), "c");
        // A message copied from a thread that is gone is keyed by that thread's id.
        let orphan = HashMap::from([("d".to_owned(), thread(20, Some("gone")))]);
        assert_eq!(origin(&orphan, "d", 15), "gone");
    }
}
