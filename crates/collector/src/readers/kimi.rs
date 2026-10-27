//! Kimi Code (Moonshot AI) in its two layouts, both `wire.jsonl` line logs:
//! - The legacy Python kimi-cli, `~/.kimi/sessions/<md5 of cwd>/<session>/wire.jsonl` (`$KIMI_SHARE_DIR`), with each
//!   subagent's own log in `<session>/subagents/<agent>/`. Usage is a `StatusUpdate` message per step, keyed by its
//!   `message_id` (the provider's response id), with kosong's `token_usage{input_other, output, input_cache_read,
//!   input_cache_creation}`. A subagent's updates are also forwarded into its parent's log inside a `SubagentEvent`; the
//!   id counts them once. No per-request model is recorded, so the model is `unknown`.
//! - The official Kimi Code, `~/.kimi-code/sessions/<workdir key>/<session>/agents/<agent>/wire.jsonl`. Usage is a
//!   `step.end` loop event keyed by its `uuid`, inside `context.append_loop_event` or on its own, with camelCase
//!   `usage{inputOther, output, inputCacheRead, inputCacheCreation}`. `usage.record` repeats each step's usage and is
//!   not read. The model is the latest `llm.request` `model` (else its `modelAlias`) or `profile.bind` /
//!   `config.update` `modelAlias` before the step; the project is their `environmentDisclosure.cwd`.
//!
//! Both usage shapes are disjoint (kosong `chat_provider/__init__.py` in kimi-cli, `packages/kosong/src/usage.ts` in
//! kimi-code): other input, cache reads, cache writes and output, reasoning included, map 1:1. With a Gemini backend
//! Kimi Code itself loses the thinking tokens, so its output there excludes them. A fork copies a log's records into
//! a new session; keys hold no session, so the copies count once.
use super::adapters::{Adapter, SourceKind};
use super::parser::{
    Counted, Object, ParserState, TEXT_LIMIT, counter, epoch, field, file_name, is, is_metadata_text, object, optional,
    text, usage_event,
};
use serde_json::Value;
use std::path::Path;
use tokentracky_core::{SourceCapabilities, TokenCounts, ToolId, UsageEvent};

fn line(
    record: &Object,
    path: &Path,
    state: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    if let Some(message) = object(record.get("message")) {
        return status_update(message, record.get("timestamp"), path, diagnostics);
    }
    match record.get("type").and_then(Value::as_str) {
        Some("llm.request") => {
            if let Some(model) = text(record.get("model"), 256).or_else(|| text(record.get("modelAlias"), 256)) {
                state.model = model.into();
            }
            Ok(None)
        }
        Some("profile.bind" | "config.update") => {
            if let Some(model) = text(record.get("modelAlias"), 256) {
                state.model = model.into();
            }
            if let Some(cwd) = text(field(object(record.get("environmentDisclosure")), "cwd"), TEXT_LIMIT) {
                state.project = Some(cwd.into());
            }
            Ok(None)
        }
        Some("context.append_loop_event") => match object(record.get("event")) {
            Some(event) => step_end(event, record, path, state, diagnostics),
            None => Ok(None),
        },
        Some("step.end") => step_end(record, record, path, state, diagnostics),
        _ => Ok(None),
    }
}

/// A legacy `StatusUpdate`, or one a subagent forwarded inside a `SubagentEvent`. A null `token_usage` means no
/// change.
fn status_update(
    message: &Object,
    timestamp: Option<&Value>,
    path: &Path,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    let message = if is(message.get("type"), "SubagentEvent") {
        match object(field(object(message.get("payload")), "event")) {
            Some(event) => event,
            None => return Ok(None),
        }
    } else {
        message
    };
    if !is(message.get("type"), "StatusUpdate") {
        return Ok(None);
    }
    let payload = object(message.get("payload"));
    let Some(usage) = object(field(payload, "token_usage")) else {
        return Ok(None);
    };
    let (Some(id), Some(session)) = (text(field(payload, "message_id"), 512), session(path)) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let tokens = TokenCounts {
        input: counter(usage.get("input_other"), false)?,
        output: counter(usage.get("output"), false)?,
        cache_read: optional(usage.get("input_cache_read"))?,
        cache_write: optional(usage.get("input_cache_creation"))?,
        reasoning: None,
        cache_write_1h: None,
    };
    usage_event(ToolId::Kimi, id, &session, None, "unknown", seconds(timestamp), tokens)
}

/// An official `step.end` event; `record` is the line holding it, which carries the time.
fn step_end(
    event: &Object,
    record: &Object,
    path: &Path,
    state: &ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    if !is(event.get("type"), "step.end") {
        return Ok(None);
    }
    let Some(usage) = object(event.get("usage")) else {
        return Ok(None);
    };
    let (Some(id), Some(session)) = (text(event.get("uuid"), 512), session(path)) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let tokens = TokenCounts {
        input: counter(usage.get("inputOther"), false)?,
        output: counter(usage.get("output"), false)?,
        cache_read: optional(usage.get("inputCacheRead"))?,
        cache_write: optional(usage.get("inputCacheCreation"))?,
        reasoning: None,
        cache_write_1h: None,
    };
    let time = epoch(record.get("time")).or_else(|| epoch(event.get("time")));
    usage_event(
        ToolId::Kimi,
        id,
        &session,
        state.project.as_deref(),
        &state.model,
        time,
        tokens,
    )
}

/// The session folder: the log's own, or the one above `agents/` or `subagents/` for an agent's log.
fn session(path: &Path) -> Option<String> {
    let folder = path.parent()?;
    let above = folder.parent()?;
    let session = if matches!(&*file_name(above), "agents" | "subagents") {
        above.parent()?
    } else {
        folder
    };
    let name = file_name(session);
    is_metadata_text(&name, 512).then(|| name.into_owned())
}

/// kimi-cli writes Python's `time.time()`: epoch seconds with a fraction.
fn seconds(value: Option<&Value>) -> Option<String> {
    let ms = value?.as_f64().filter(|seconds| seconds.is_finite())? * 1000.0;
    epoch(Some(&Value::from(ms.trunc() as i64)))
}

static KIMI: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: false,
        quotas: false,
    },
    // `context.jsonl` beside it holds the conversation and a running context size, not usage.
    kind: |path| (file_name(path) == "wire.jsonl").then_some(SourceKind::Jsonl),
    ledger: false,
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
    Some(&KIMI)
}

#[cfg(test)]
mod tests {
    use crate::readers::{ParserState, parse_usage_line};
    use serde_json::{Value, json};
    use std::path::Path;
    use tokentracky_core::{ParseResult, TokenCounts, ToolId};

    fn read(path: &str, lines: &[Value]) -> Vec<ParseResult> {
        let mut state = ParserState::default();
        lines
            .iter()
            .map(|line| parse_usage_line(ToolId::Kimi, &line.to_string(), Path::new(path), &mut state))
            .collect()
    }
    fn counts(input: u64, output: u64, cache_read: u64, cache_write: u64) -> TokenCounts {
        TokenCounts {
            input,
            output,
            cache_read,
            cache_write,
            reasoning: None,
            cache_write_1h: None,
        }
    }

    #[test]
    fn reads_legacy_status_updates_with_an_unknown_model() {
        let update = |id: Value, usage: Value| {
            json!({"timestamp": 1792746000.123456, "message": {"type": "StatusUpdate", "payload": {"context_usage": 0.1,
                "token_usage": usage, "message_id": id}}})
        };
        let usage = json!({"input_other": 100, "output": 20, "input_cache_read": 300, "input_cache_creation": 5});
        let results = read(
            "/s/abc/session-1/wire.jsonl",
            &[
                update(json!("chatcmpl-1"), usage.clone()),
                update(json!("chatcmpl-2"), Value::Null),
                update(Value::Null, usage),
                update(json!("chatcmpl-3"), json!({"input_other": 1, "output": -1})),
            ],
        );
        let event = &results[0].events[0];
        assert_eq!(event.tokens, counts(100, 20, 300, 5));
        assert_eq!(
            (event.model.as_str(), event.session_id.as_str()),
            ("unknown", "session-1")
        );
        assert_eq!(event.occurred_at.as_deref(), Some("2026-10-23T09:00:00.123Z"));
        assert_eq!(event.project, None);
        assert_eq!(results[1], ParseResult::default());
        assert_eq!(results[2].diagnostics, ["missing_stable_identity"]);
        assert_eq!(results[3].diagnostics, ["invalid_counters"]);
    }

    #[test]
    fn counts_a_forwarded_subagent_update_under_the_same_id() {
        let usage = json!({"input_other": 7, "output": 3});
        let own = json!({"timestamp": 1792746000, "message": {"type": "StatusUpdate", "payload": {"token_usage": usage,
            "message_id": "m"}}});
        let forwarded = json!({"timestamp": 1792746000, "message": {"type": "SubagentEvent", "payload": {"agent_id": "a",
            "event": {"type": "StatusUpdate", "payload": {"token_usage": usage, "message_id": "m"}}}}});
        let own = read("/s/abc/session-1/subagents/a/wire.jsonl", &[own]);
        let forwarded = read("/s/abc/session-1/wire.jsonl", &[forwarded]);
        assert_eq!(own[0].events, forwarded[0].events);
        assert_eq!(own[0].events[0].tokens, counts(7, 3, 0, 0));
    }

    #[test]
    fn reads_official_steps_with_the_model_and_project_declared_before_them() {
        let step = |uuid: &str, wrapped: bool| {
            let usage = json!({"inputOther": 10, "output": 4, "inputCacheRead": 90, "inputCacheCreation": 2});
            if wrapped {
                json!({"type": "context.append_loop_event", "agentId": "main", "time": 1792746000000_u64,
                    "event": {"type": "step.end", "uuid": uuid, "step": 1, "usage": usage}})
            } else {
                json!({"type": "step.end", "uuid": uuid, "step": 1, "usage": usage, "time": 1792746000000_u64})
            }
        };
        let path = "/s/wd_x/session-2/agents/main/wire.jsonl";
        let results = read(
            path,
            &[
                step("u0", true),
                json!({"type": "profile.bind", "agentId": "main", "modelAlias": "kimi-code/k3",
                    "environmentDisclosure": {"cwd": "/synthetic/kimi"}}),
                step("u1", true),
                json!({"type": "llm.request", "agentId": "main", "kind": "loop", "provider": "kimi", "model": "k3"}),
                step("u2", false),
                json!({"type": "usage.record", "agentId": "main", "model": "kimi-code/k3",
                    "usage": {"inputOther": 10, "output": 4, "inputCacheRead": 90, "inputCacheCreation": 2}}),
                json!({"type": "config.update", "agentId": "main", "thinkingEffort": "high"}),
                step("u3", true),
            ],
        );
        let events: Vec<_> = results.iter().flat_map(|result| &result.events).collect();
        let seen: Vec<_> = events
            .iter()
            .map(|event| (event.model.as_str(), event.project.as_deref()))
            .collect();
        assert_eq!(
            seen,
            [
                ("unknown", None),
                ("kimi-code/k3", Some("/synthetic/kimi")),
                ("k3", Some("/synthetic/kimi")),
                ("k3", Some("/synthetic/kimi")),
            ]
        );
        assert!(events.iter().all(|event| event.session_id == "session-2"
            && event.tokens == counts(10, 4, 90, 2)
            && event.occurred_at.as_deref() == Some("2026-10-23T09:00:00.000Z")));
        assert!(results.iter().all(|result| result.diagnostics.is_empty()));
    }
}
