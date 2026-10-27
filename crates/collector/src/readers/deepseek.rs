//! DeepSeek Harness: `~/.dsh/sessions/<project>/<session>/session[.vN].jsonl`, or `.jsonl.zstd` (one independent zstd
//! frame per append batch, the default). The first line is the session header; each later line is a `SessionEvent`
//! with `seq`, `time` (epoch ms) and `data`. An `assistant/message` carries one model call's `usage`.
//!
//! A session folder can hold several copies of a log: the harness keeps the old format generation beside the new
//! `session.vN` one, and a fork copies the source's events into a new session. Format migrations renumber `seq`, so the
//! key is the assistant message's id, which the harness keeps "across every representation boundary"
//! (`packages/llm/llm/src/message.ts`); copies count once. Usage of v0 and v1 logs sits in stream chunks instead and is
//! not read; the harness migrates such a log to a later generation when it resumes it.
use super::adapters::{Adapter, SourceKind};
use super::parser::{
    Counted, Invalid, Object, ParserState, TEXT_LIMIT, counter, epoch, field, file_name, is, object, optional,
    safe_sum, text, usage_event,
};
use serde_json::{Map, Value};
use std::path::Path;
use tokentracky_core::{SourceCapabilities, TokenCounts, ToolId, UsageEvent};

static DEEPSEEK: Adapter = Adapter {
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: false,
        quotas: false,
    },
    kind: session_log,
    ledger: false,
    document: None,
    sidecars: None,
    database: None,
    incremental: None,
    line: Some(read_line),
    text: None,
    database_supersedes_documents: false,
};

/// The tool's adapter.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&DEEPSEEK)
}

/// `session.jsonl[.zstd]` or `session.v<N>.jsonl[.zstd]` with `N` a positive number without leading zeros: the names of
/// committed generations (`packages/session/session-persistence-jsonl/src/format.ts`). Temporary files are never read.
fn session_log(path: &Path) -> Option<SourceKind> {
    let name = file_name(path);
    let (stem, kind) = match name.strip_suffix(".zstd") {
        Some(stem) => (stem, SourceKind::CompressedJsonl),
        None => (&*name, SourceKind::Jsonl),
    };
    let version = stem.strip_prefix("session")?.strip_suffix(".jsonl")?;
    let positive = |n: &str| !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit());
    (version.is_empty() || version.strip_prefix(".v").is_some_and(positive)).then_some(kind)
}

/// Disjoint counts (`TokenUsage` in `packages/llm/llm/src/types.ts`): input excludes both caches, and reasoning is inside
/// output, as the harness rejects reasoning above output. A `totalTokens` is the exact full-call total and must match.
fn tokens(usage: &Object) -> Counted<TokenCounts> {
    let tokens = TokenCounts {
        input: counter(usage.get("inputTokens"), false)?,
        output: counter(usage.get("outputTokens"), false)?,
        cache_read: optional(usage.get("cacheReadTokens"))?,
        cache_write: optional(usage.get("cacheWriteTokens"))?,
        reasoning: Some(optional(usage.get("reasoningTokens"))?),
        cache_write_1h: None,
    };
    let sum = safe_sum(&[tokens.input, tokens.output, tokens.cache_read, tokens.cache_write])?;
    match usage.get("totalTokens") {
        Some(total) if counter(Some(total), false)? != sum => Err(Invalid),
        _ => Ok(tokens),
    }
}

fn read_line(
    record: &Map<String, Value>,
    _: &Path,
    state: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    let data = object(record.get("data"));
    if is(record.get("type"), "session") {
        state.session_id = text(record.get("id"), 512).map(Into::into);
        state.project = text(record.get("cwd"), TEXT_LIMIT).map(Into::into);
        return Ok(None);
    }
    if is(record.get("type"), "request/header") {
        let config = object(field(object(field(data, "header")), "config"));
        if let Some(model) = text(field(config, "model"), 256) {
            state.model = model.into();
        }
        return Ok(None);
    }
    let Some(usage) = object(field(data, "usage")).filter(|_| is(record.get("type"), "assistant/message")) else {
        return Ok(None);
    };
    let message = object(field(data, "message"));
    let (Some(session), Some(id)) = (state.session_id.as_deref(), text(field(message, "id"), 512)) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let model = text(field(object(field(message, "source")), "model"), 256).unwrap_or(&state.model);
    usage_event(
        ToolId::DeepSeek,
        id,
        session,
        state.project.as_deref(),
        model,
        epoch(record.get("time")),
        tokens(usage)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::readers::parse_usage_file;
    use serde_json::json;

    fn usage(usage: Value) -> Result<TokenCounts, ()> {
        tokens(usage.as_object().unwrap()).map_err(|_| ())
    }

    #[test]
    fn reads_only_the_names_of_committed_generations() {
        for (name, kind) in [
            ("session.jsonl", Some(SourceKind::Jsonl)),
            ("session.v4.jsonl", Some(SourceKind::Jsonl)),
            ("session.jsonl.zstd", Some(SourceKind::CompressedJsonl)),
            ("session.v12.jsonl.zstd", Some(SourceKind::CompressedJsonl)),
            ("session.v0.jsonl", None),
            ("session.v04.jsonl", None),
            ("session.v.jsonl", None),
            ("session.V4.jsonl", None),
            ("session.jsonl.zst", None),
            ("session.jsonl.tmp", None),
            (".session.jsonl.zstd.tmp-1", None),
            ("other.jsonl", None),
        ] {
            assert_eq!(session_log(Path::new("/s/p/id").join(name).as_path()), kind, "{name}");
        }
    }

    #[test]
    fn keeps_reasoning_inside_output_and_checks_the_total() {
        // Reasoning is already included in output; do not add it again.
        let read = usage(json!({"inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 900,
            "cacheWriteTokens": 10, "reasoningTokens": 30, "totalTokens": 1060}))
        .unwrap();
        assert_eq!(
            (
                read.input,
                read.output,
                read.cache_read,
                read.cache_write,
                read.reasoning
            ),
            (100, 50, 900, 10, Some(30))
        );
        assert_eq!(tokentracky_core::total_tokens(&read), 1060);
        // Optional caches, reasoning and total.
        let bare = usage(json!({"inputTokens": 7, "outputTokens": 3})).unwrap();
        assert_eq!(
            (bare.input, bare.output, bare.cache_read, bare.reasoning),
            (7, 3, 0, Some(0))
        );
        for invalid in [
            json!({"inputTokens": 100, "outputTokens": 50, "totalTokens": 151}),
            json!({"inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 5, "totalTokens": 150}),
            json!({"outputTokens": 50}),
            json!({"inputTokens": -1, "outputTokens": 50}),
            json!({"inputTokens": 1, "outputTokens": 50, "totalTokens": "51"}),
        ] {
            assert_eq!(usage(invalid.clone()), Err(()), "{invalid}");
        }
    }

    #[test]
    fn keys_on_the_message_id_so_renumbered_and_forked_copies_count_once() {
        let log = |session: &str, seq: u64, model: Option<&str>| {
            [
                json!({"type": "session", "version": 4, "id": session, "createdAt": 1, "cwd": "/w", "isSeeded": false}),
                json!({"type": "request/header", "seq": seq - 1, "time": 1_792_746_000_000_u64,
                    "data": {"header": {"config": {"provider": "deepseek-official", "model": "deepseek-v4-pro"}}}}),
                json!({"type": "assistant/message", "seq": seq, "time": 1_792_746_000_000_u64,
                    "data": {"turn": 1, "step": 1, "message": {"id": "m-1", "role": "assistant", "content": [],
                    "source": {"kind": "model", "provider": "deepseek-official", "model": model}},
                    "stream": [], "usage": {"inputTokens": 10, "outputTokens": 5}}}),
            ]
            .map(|line| line.to_string())
            .join("\n")
        };
        let read = |text: &str| parse_usage_file(ToolId::DeepSeek, text, Path::new("/s/p/a/session.jsonl"));
        let flash = Some("deepseek-v4-flash");
        let (v3, v4, fork) = (
            read(&log("a", 5, flash)),
            read(&log("a", 7, flash)),
            read(&log("b", 5, flash)),
        );
        assert_eq!(v3.events[0].event_id, v4.events[0].event_id);
        assert_eq!(v3.events[0].event_id, fork.events[0].event_id);
        assert_eq!(v3.events[0].model, "deepseek-v4-flash");
        assert_eq!(v3.events[0].occurred_at.as_deref(), Some("2026-10-23T09:00:00.000Z"));
        // Without the message's model, the request header's.
        assert_eq!(read(&log("a", 5, None)).events[0].model, "deepseek-v4-pro");
    }
}
