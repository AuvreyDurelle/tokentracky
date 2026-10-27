//! Command Code (commandcode.ai): `~/.commandcode/projects/<cwd slug>/<session>.jsonl`, version 3 session logs. The
//! first line is a `session` header with the session `id` and `cwd`. Each assistant `message` entry carries its
//! request's top-level `model`, provider-qualified (`deepseek/deepseek-v4-flash`), and the AI SDK's
//! `usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`: input includes both caches and output
//! includes reasoning (`estimateCatalogCostUsd` in command-code 1.88.0 `dist/cli.mjs`; vercel/ai
//! `packages/ai/src/types/usage.ts`). Its `costUsd` estimate is ignored. `<session>.checkpoints.jsonl` and
//! `<session>.prompts.jsonl` beside a log are not usage.
//!
//! Resume and compaction rewrite a log, and forks and clones copy its entries into a new log under a new header, so an
//! entry's key is its 8-character `id` with its `timestamp`, without the session, and usage once seen stays counted.
use super::adapters::{Adapter, SourceKind};
use super::parser::{
    Counted, Invalid, Object, ParserState, TEXT_LIMIT, counter, date, file_name, is, is_metadata_text, object,
    optional, text, usage_event,
};
use std::path::Path;
use tokentracky_core::{SourceCapabilities, TokenCounts, ToolId, UsageEvent};

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
        if state.project.is_none() {
            state.project = text(record.get("cwd"), TEXT_LIMIT).map(Into::into);
        }
        return Ok(None);
    }
    let Some(usage) = object(record.get("usage")) else {
        return Ok(None);
    };
    if !is(record.get("type"), "message") {
        return Ok(None);
    }
    // A log is named after its session, for an entry read before any header.
    let stem = file_name(path).strip_suffix(".jsonl").map(str::to_owned);
    let session = state
        .session_id
        .clone()
        .or(stem.filter(|stem| is_metadata_text(stem, 512)));
    let (Some(id), Some(timestamp), Some(session)) =
        (text(record.get("id"), 512), text(record.get("timestamp"), 512), session)
    else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let cache_read = optional(usage.get("cacheReadTokens"))?;
    let cache_write = optional(usage.get("cacheWriteTokens"))?;
    let input = counter(usage.get("inputTokens"), false)?
        .checked_sub(cache_read)
        .and_then(|input| input.checked_sub(cache_write))
        .ok_or(Invalid)?;
    let tokens = TokenCounts {
        input,
        output: counter(usage.get("outputTokens"), false)?,
        cache_read,
        cache_write,
        reasoning: None,
        cache_write_1h: None,
    };
    let model = text(record.get("model"), 256)
        .and_then(|model| model.rsplit('/').next())
        .filter(|model| !model.is_empty())
        .unwrap_or("unknown");
    usage_event(
        ToolId::CommandCode,
        &format!("{id}|{timestamp}"),
        &session,
        state.project.as_deref(),
        model,
        date(record.get("timestamp")),
        tokens,
    )
}

static COMMAND_CODE: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: false,
        quotas: false,
    },
    kind: |path| {
        let name = file_name(path);
        let log = name.ends_with(".jsonl") && !name.ends_with(".checkpoints.jsonl") && !name.contains(".prompts.");
        log.then_some(SourceKind::Jsonl)
    },
    ledger: true,
    document: None,
    sidecars: None,
    database: None,
    incremental: None,
    line: Some(line),
    text: None,
    database_supersedes_documents: false,
};

/// The tool's adapter.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&COMMAND_CODE)
}

#[cfg(test)]
mod tests {
    use crate::readers::{ParserState, parse_usage_line, source_kind};
    use serde_json::{Value, json};
    use std::path::Path;
    use tokentracky_core::{ParseResult, ToolId};

    fn read(path: &str, lines: &[Value]) -> Vec<ParseResult> {
        let mut state = ParserState::default();
        lines
            .iter()
            .map(|line| parse_usage_line(ToolId::CommandCode, &line.to_string(), Path::new(path), &mut state))
            .collect()
    }
    fn entry(id: &str, model: Value, usage: Value) -> Value {
        json!({"type": "message", "id": id, "parentId": null, "timestamp": "2026-10-20T12:00:00.000Z",
            "message": {"role": "assistant", "content": []}, "model": model, "usage": usage})
    }

    #[test]
    fn takes_both_caches_out_of_input_and_strips_the_provider() {
        let header = json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-10-20T11:00:00.000Z",
            "cwd": "/synthetic/command-code"});
        let usage = json!({"inputTokens": 1000, "outputTokens": 80, "cacheReadTokens": 600, "cacheWriteTokens": 150,
            "cacheWriteTokens1h": 150, "costUsd": 0.5});
        let results = read(
            "/p/slug/s1.jsonl",
            &[
                header,
                entry("a1b2c3d4", json!("deepseek/deepseek-v4-flash"), usage),
                entry("a1b2c3d5", Value::Null, json!({"inputTokens": 10, "outputTokens": 1})),
                entry(
                    "a1b2c3d6",
                    json!("m"),
                    json!({"inputTokens": 10, "outputTokens": 1, "cacheReadTokens": 11}),
                ),
            ],
        );
        let event = &results[1].events[0];
        let t = &event.tokens;
        assert_eq!((t.input, t.cache_read, t.cache_write, t.output), (250, 600, 150, 80));
        assert_eq!((t.reasoning, t.cache_write_1h), (None, None));
        assert_eq!(event.model, "deepseek-v4-flash");
        assert_eq!(
            (event.session_id.as_str(), event.project.as_deref()),
            ("s1", Some("/synthetic/command-code"))
        );
        assert_eq!(results[2].events[0].model, "unknown");
        assert_eq!(results[3].diagnostics, ["invalid_counters"]);
    }

    #[test]
    fn keys_copies_without_the_session_and_skips_sidecars() {
        let usage = json!({"inputTokens": 10, "outputTokens": 1});
        let original = read("/p/slug/s1.jsonl", &[entry("a1b2c3d4", json!("m"), usage.clone())]);
        let fork = read(
            "/p/slug/s2.jsonl",
            &[
                json!({"type": "session", "version": 3, "id": "s2", "cwd": "/synthetic/command-code"}),
                entry("a1b2c3d4", json!("m"), usage),
            ],
        );
        assert_eq!(original[0].events[0].session_id, "s1");
        assert_eq!(fork[1].events[0].session_id, "s2");
        assert_eq!(original[0].events[0].event_id, fork[1].events[0].event_id);
        for (name, read) in [
            ("s1.jsonl", true),
            ("s1.checkpoints.jsonl", false),
            ("s1.prompts.jsonl", false),
            ("s1.meta.json", false),
            ("s1.jsonl.123.tmp", false),
        ] {
            let kind = source_kind(ToolId::CommandCode, &Path::new("/p/slug").join(name));
            assert_eq!(kind.is_some(), read, "{name}");
        }
    }
}
