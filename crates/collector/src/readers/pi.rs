//! pi, oh-my-pi, OmO, Prime Agent and MiniMax Code: pi's session JSONL, read by one line reader.
//!
//! pi (`packages/coding-agent/src/core/session-manager.ts`), oh-my-pi (`docs/session.md`), OmO's senpi (the same
//! file) and Prime Agent (`crates/pa-types/src/session.rs`) write `<sessions>/…/*.jsonl`: a `session` header with the
//! session `id` and `cwd`, then entries with an 8-character `id` and an ISO `timestamp`. Usage is on assistant `message`
//! entries, and on pi's and senpi's `usage` and oh-my-pi's `model_usage` entries, which record model calls outside the
//! transcript such as cache warming; each names its model. Subagent sessions are files of their own, nested under the
//! parent's folder by oh-my-pi, so they are separate usage. A fork, a branch or oh-my-pi's move to a sibling file
//! copies entries with their id and timestamp into a new session: the key is the entry id with its timestamp, so
//! copies count once while ids that collide across sessions do not. oh-my-pi rewrites a file to discard an entry and
//! Prime Agent may persist a fold of child usage, so usage once seen stays (a ledger).
//!
//! Not read: compaction and branch-summary usage, which records no model; oh-my-pi's `task` results and Prime Agent's
//! `child_usage_attributed` rows, which repeat a child session's usage (`crates/pa-core/src/session_engine/rlm_usage.rs`).
//!
//! MiniMax Code writes `~/.minimax/v2/sessions/YYYY/MM/DD/<time>-session_<id>/messages.jsonl`
//! (`packages/local-runtime-v2/src/service/session-system/messages/history/session-history-paths.ts`): no header, and
//! one `{message_id, turn_id, message}` envelope per line around the same pi message. A fork copies envelopes with
//! their `message_id`, a content hash, which is the key; compaction and rewinds replace the file. Mutations stage
//! copies in `.history-mutation-*` folders, which are not read. There is no working folder, so no project.
use super::adapters::{Adapter, SourceKind};
use super::parser::{
    Counted, Invalid, Object, ParserState, TEXT_LIMIT, counter, date, digest, epoch, field, file_name, is, object,
    optional, parent_name, safe_sum, text, usage_event,
};
use serde_json::Value;
use std::path::Path;
use tokentracky_core::{SourceCapabilities, TokenCounts, ToolId, UsageEvent};

const SESSIONS: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: false,
        quotas: false,
    },
    kind: |path| file_name(path).ends_with(".jsonl").then_some(SourceKind::Jsonl),
    ledger: true,
    document: None,
    sidecars: None,
    database: None,
    incremental: None,
    line: None,
    text: None,
    database_supersedes_documents: false,
};
static PI: Adapter = Adapter {
    line: Some(|record, _, state, diagnostics| session_entry(ToolId::Pi, record, state, diagnostics)),
    ..SESSIONS
};
static OMP: Adapter = Adapter {
    line: Some(|record, _, state, diagnostics| session_entry(ToolId::Omp, record, state, diagnostics)),
    ..SESSIONS
};
static OMO: Adapter = Adapter {
    line: Some(|record, _, state, diagnostics| session_entry(ToolId::Omo, record, state, diagnostics)),
    ..SESSIONS
};
static PRIME_AGENT: Adapter = Adapter {
    line: Some(|record, _, state, diagnostics| session_entry(ToolId::PrimeAgent, record, state, diagnostics)),
    ..SESSIONS
};
static MINIMAX: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        projects: false,
        ..SESSIONS.capabilities
    },
    kind: |path| {
        let folder = parent_name(path);
        (file_name(path) == "messages.jsonl" && !folder.starts_with('.') && folder.contains("-session_"))
            .then_some(SourceKind::Jsonl)
    },
    line: Some(|record, path, _, diagnostics| history_envelope(record, path, diagnostics)),
    ..SESSIONS
};

/// The tool's adapter.
pub(crate) fn adapter(tool: ToolId) -> Option<&'static Adapter> {
    match tool {
        ToolId::Pi => Some(&PI),
        ToolId::Omp => Some(&OMP),
        ToolId::Omo => Some(&OMO),
        ToolId::PrimeAgent => Some(&PRIME_AGENT),
        ToolId::MiniMax => Some(&MINIMAX),
        _ => None,
    }
}

/// pi-ai's `Usage`, the same in every tool: `input` excludes both caches, `output` includes reasoning (`reasoning`, or
/// oh-my-pi's `reasoningTokens`, a subset of it), and an absent counter is 0, as oh-my-pi's loader reads it.
/// `totalTokens` may exceed the four (Google tool-use prompt tokens, oh-my-pi orchestration tokens) but never falls
/// short; `cost` is ignored.
fn tokens(usage: &Object) -> Counted<TokenCounts> {
    let write = optional(usage.get("cacheWrite"))?;
    let reasoning = ["reasoning", "reasoningTokens"]
        .into_iter()
        .find_map(|name| usage.get(name).filter(|value| !value.is_null()));
    let tokens = TokenCounts {
        input: optional(usage.get("input"))?,
        output: optional(usage.get("output"))?,
        cache_read: optional(usage.get("cacheRead"))?,
        cache_write: write,
        reasoning: Some(optional(reasoning)?),
        cache_write_1h: usage
            .get("cacheWrite1h")
            .and_then(|value| counter(Some(value), false).ok())
            .map(|hour| hour.min(write))
            .filter(|hour| *hour > 0),
    };
    let sum = safe_sum(&[tokens.input, tokens.output, tokens.cache_read, tokens.cache_write])?;
    match usage.get("totalTokens").filter(|total| !total.is_null()) {
        Some(total) if counter(Some(total), false)? < sum => Err(Invalid),
        _ => Ok(tokens),
    }
}

/// One line of a pi-format session file.
fn session_entry(
    tool: ToolId,
    record: &Object,
    state: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    let message = object(record.get("message"));
    let (usage, model) = match record.get("type").and_then(Value::as_str) {
        Some("session") => {
            state.session_id = text(record.get("id"), 512).map(Into::into);
            state.project = text(record.get("cwd"), TEXT_LIMIT).map(Into::into);
            return Ok(None);
        }
        Some("message") if is(field(message, "role"), "assistant") => {
            (field(message, "usage"), field(message, "model"))
        }
        Some("usage" | "model_usage") => (record.get("usage"), record.get("model")),
        _ => return Ok(None),
    };
    let Some(usage) = object(usage) else {
        return Ok(None);
    };
    let id = text(record.get("id"), 512);
    let at = text(record.get("timestamp"), 64);
    let (Some(session_id), Some(id), Some(at)) = (state.session_id.as_deref(), id, at) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let mut event = usage_event(
        tool,
        &format!("{id}|{at}"),
        session_id,
        state.project.as_deref(),
        text(model, 256).unwrap_or("unknown"),
        date(record.get("timestamp")),
        tokens(usage)?,
    )?;
    // Only this route is mirrored by the Claude Agent SDK. Its responseId is the provider message id, not the
    // pi entry id. Keep the old event identity and only a digest of the shared identity, so existing ledgers upgrade.
    if tool == ToolId::Omo
        && is(field(message, "api"), "claude-sdk-oauth")
        && let Some(id) = text(field(message, "responseId"), 512)
        && id.starts_with("msg_")
        && let Some(event) = &mut event
    {
        event.claude_mirror_id = Some(format!("claude:{}", digest(id)));
    }
    Ok(event)
}

/// One envelope of a MiniMax Code `messages.jsonl`; the session is its folder's `session_<id>`.
fn history_envelope(record: &Object, path: &Path, diagnostics: &mut Vec<String>) -> Counted<Option<UsageEvent>> {
    let message = object(record.get("message"));
    if !is(field(message, "role"), "assistant") {
        return Ok(None);
    }
    let Some(usage) = object(field(message, "usage")) else {
        return Ok(None);
    };
    let folder = parent_name(path);
    let session_id = folder.find("session_").map(|at| &folder[at..]);
    let (Some(session_id), Some(id)) = (session_id, text(record.get("message_id"), 512)) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    usage_event(
        ToolId::MiniMax,
        id,
        session_id,
        None,
        text(field(message, "model"), 256).unwrap_or("unknown"),
        epoch(field(message, "timestamp")),
        tokens(usage)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::readers::parse_usage_line;
    use serde_json::json;

    fn read(tool: ToolId, path: &str, lines: &[Value]) -> (Vec<UsageEvent>, Vec<String>) {
        let mut state = ParserState::default();
        let (mut events, mut diagnostics) = (Vec::new(), Vec::new());
        for line in lines {
            let result = parse_usage_line(tool, &line.to_string(), Path::new(path), &mut state);
            events.extend(result.events);
            diagnostics.extend(result.diagnostics);
        }
        (events, diagnostics)
    }
    fn header(id: &str) -> Value {
        json!({"type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T10:00:00.000Z", "cwd": "/work/p"})
    }
    fn assistant(id: &str, at: &str, usage: Value) -> Value {
        json!({"type": "message", "id": id, "parentId": null, "timestamp": at,
            "message": {"role": "assistant", "model": "m", "usage": usage, "timestamp": 1_792_490_400_000_u64}})
    }

    #[test]
    fn converts_usage_and_checks_the_total_as_a_floor() {
        let usage = |extra: Value| {
            let mut usage = json!({"input": 10, "output": 20, "cacheRead": 30, "cacheWrite": 40,
                "cost": {"input": 1, "output": 1, "cacheRead": 1, "cacheWrite": 1, "total": 4}});
            usage
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            usage
        };
        let tokens = |usage: &Value| super::tokens(usage.as_object().unwrap()).ok();
        let read = tokens(&usage(json!({"totalTokens": 100, "reasoning": 5}))).unwrap();
        assert_eq!(
            (
                read.input,
                read.output,
                read.cache_read,
                read.cache_write,
                read.reasoning
            ),
            (10, 20, 30, 40, Some(5))
        );
        // A larger total (Google tool-use prompt tokens, oh-my-pi orchestration) is not added; a smaller one fails.
        assert!(tokens(&usage(json!({"totalTokens": 130}))).is_some_and(|t| tokentracky_core::total_tokens(&t) == 100));
        assert!(tokens(&usage(json!({"totalTokens": 99}))).is_none());
        assert!(tokens(&usage(json!({"totalTokens": "100"}))).is_none());
        assert!(tokens(&usage(json!({"totalTokens": null}))).is_some());
        // oh-my-pi's spelling, and `reasoning` first when both are written.
        assert_eq!(
            tokens(&usage(json!({"reasoningTokens": 7}))).unwrap().reasoning,
            Some(7)
        );
        assert_eq!(
            tokens(&usage(json!({"reasoning": 3, "reasoningTokens": 7})))
                .unwrap()
                .reasoning,
            Some(3)
        );
        assert_eq!(tokens(&json!({"output": 2})).unwrap().reasoning, Some(0));
        assert!(tokens(&usage(json!({"input": -1}))).is_none());
    }
    #[test]
    fn keys_entries_on_id_and_timestamp_across_sessions() {
        let usage = json!({"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 3});
        let first = [
            header("s1"),
            assistant("a1b2c3d4", "2026-10-20T10:00:01.000Z", usage.clone()),
        ];
        // The fork copies the entry; another session reuses the 8-character id at another time.
        let fork = [
            header("s2"),
            assistant("a1b2c3d4", "2026-10-20T10:00:01.000Z", usage.clone()),
        ];
        let other = [header("s3"), assistant("a1b2c3d4", "2026-10-21T09:00:00.000Z", usage)];
        let id = |lines: &[Value]| read(ToolId::Pi, "x.jsonl", lines).0[0].event_id.clone();
        assert_eq!(id(&first), id(&fork));
        assert_ne!(id(&first), id(&other));
        let (events, _) = read(ToolId::Pi, "x.jsonl", &fork);
        assert_eq!(
            (events[0].session_id.as_str(), events[0].project.as_deref()),
            ("s2", Some("/work/p"))
        );
        assert_eq!(events[0].occurred_at.as_deref(), Some("2026-10-20T10:00:01.000Z"));
    }
    #[test]
    fn only_omo_sdk_responses_identify_a_claude_mirror_and_keep_hour_writes() {
        let usage = json!({"input":1,"output":2,"cacheWrite":4,"cacheWrite1h":4});
        for (tool, api, response, mirrored) in [
            (ToolId::Omo, "claude-sdk-oauth", "msg_shared", true),
            (ToolId::Omo, "anthropic-messages", "msg_shared", false),
            (ToolId::Pi, "claude-sdk-oauth", "msg_shared", false),
            (ToolId::Omo, "claude-sdk-oauth", "resp_other", false),
        ] {
            let mut message = assistant("entry", "2026-10-20T10:00:00.000Z", usage.clone());
            message["message"]["api"] = json!(api);
            message["message"]["responseId"] = json!(response);
            let event = read(tool, "x.jsonl", &[header("session"), message]).0.remove(0);
            assert_eq!(event.claude_mirror_id.is_some(), mirrored);
            assert_eq!(event.tokens.cache_write_1h, Some(4));
        }
    }
    #[test]
    fn reads_usage_entries_and_skips_copies_of_child_usage() {
        let usage = json!({"input": 1, "output": 1, "cacheRead": 5, "cacheWrite": 0, "totalTokens": 7});
        let (events, diagnostics) = read(
            ToolId::PrimeAgent,
            "x.jsonl",
            &[
                header("s"),
                json!({"type": "usage", "id": "u1", "timestamp": "2026-10-20T10:00:02.000Z", "kind": "cache_warm",
                    "provider": "anthropic", "model": "claude-sonnet-4-6", "usage": usage}),
                json!({"type": "model_usage", "id": "u2", "timestamp": "2026-10-20T10:00:03.000Z",
                    "purpose": "title", "model": "gpt-5-mini", "usage": usage}),
                json!({"type": "child_usage_attributed", "id": "c1", "timestamp": "2026-10-20T10:00:04.000Z",
                    "targetId": "a1", "childUsage": usage, "aggregateUsage": usage}),
                json!({"type": "compaction", "id": "k1", "timestamp": "2026-10-20T10:00:05.000Z", "usage": usage}),
                json!({"type": "message", "id": "t1", "timestamp": "2026-10-20T10:00:06.000Z",
                    "message": {"role": "toolResult", "toolName": "task", "details": {"usage": usage}}}),
            ],
        );
        assert_eq!(diagnostics, Vec::<String>::new());
        let models: Vec<&str> = events.iter().map(|event| event.model.as_str()).collect();
        assert_eq!(models, ["claude-sonnet-4-6", "gpt-5-mini"]);
    }
    #[test]
    fn needs_a_header_an_id_and_a_timestamp() {
        let usage = json!({"input": 1, "output": 1});
        for lines in [
            vec![assistant("a1", "2026-10-20T10:00:01.000Z", usage.clone())],
            vec![
                header("s"),
                json!({"type": "message", "timestamp": "2026-10-20T10:00:01.000Z",
                "message": {"role": "assistant", "usage": usage}}),
            ],
            vec![
                header("s"),
                json!({"type": "message", "id": "a1", "message": {"role": "assistant", "usage": usage}}),
            ],
        ] {
            assert_eq!(
                read(ToolId::Omp, "x.jsonl", &lines),
                (Vec::new(), vec!["missing_stable_identity".to_owned()])
            );
        }
        let (events, _) = read(
            ToolId::Omo,
            "x.jsonl",
            &[
                header("s"),
                json!({"type": "message", "id": "a1", "timestamp": "2026-10-20T10:00:01.000Z",
                "message": {"role": "assistant", "usage": usage}}),
            ],
        );
        assert_eq!(events[0].model, "unknown");
    }
    #[test]
    fn reads_minimax_envelopes_from_dated_session_folders() {
        let kind = |path: &str| (MINIMAX.kind)(Path::new(path));
        let session = "v2/sessions/2026/10/20/10-00-00-000-session_czE/";
        assert_eq!(kind(&format!("{session}messages.jsonl")), Some(SourceKind::Jsonl));
        assert_eq!(
            kind(&format!("{session}.history-mutation-op-session_x/messages.jsonl")),
            None
        );
        assert_eq!(kind(&format!("{session}snapshots/compaction-1.jsonl")), None);
        assert_eq!(kind(&format!("{session}manifest.json")), None);
        let envelope = |id: Option<&str>, model: &str, usage: Value| {
            let mut line = json!({"turn_id": "t1", "message": {"role": "assistant", "model": model, "usage": usage,
                "timestamp": 1_792_490_400_000_u64}});
            if let Some(id) = id {
                line["message_id"] = json!(id);
            }
            line
        };
        let usage = json!({"input": 4, "output": 2, "cacheRead": 10, "cacheWrite": 0, "totalTokens": 16});
        let zero = json!({"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0});
        let (events, diagnostics) = read(
            ToolId::MiniMax,
            &format!("{session}messages.jsonl"),
            &[
                envelope(Some("msg-a"), "MiniMax-M3", usage.clone()),
                envelope(Some("msg-b"), "historical-transcript", zero),
                envelope(None, "MiniMax-M3", usage),
            ],
        );
        assert_eq!(diagnostics, ["missing_stable_identity"]);
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(
            (event.session_id.as_str(), event.project.as_deref()),
            ("session_czE", None)
        );
        assert_eq!(event.event_id, super::super::parser::event_id(ToolId::MiniMax, "msg-a"));
        assert_eq!(event.occurred_at.as_deref(), Some("2026-10-20T10:00:00.000Z"));
    }
}
