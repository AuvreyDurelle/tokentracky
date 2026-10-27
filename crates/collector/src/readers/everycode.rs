//! Every Code (just-every/code): a Codex fork that writes Codex rollouts to `~/.code/sessions/YYYY/MM/DD/` (or
//! `$CODE_HOME/sessions`), read by the Codex line reader under its own tool id. Its differences, from `code-rs` at
//! `41f66ca5`: token counts are `event` records (`RolloutItem::Event`) as well as `event_msg`, cache writes are
//! `cache_write_input_tokens` inside `input_tokens` (`protocol/src/protocol.rs`, `core/src/client.rs`), and the model
//! is on the token count as `latest_response_model` or `requested_model`. Older rollouts often name no model at all;
//! it stays `unknown` and is never taken from Codex sessions nearby.
use super::adapters::{Adapter, SourceKind};
use super::parser::{Counted, Object, ParserState, codex_line};
use std::path::Path;
use tokentracky_core::{SourceCapabilities, ToolId, UsageEvent};

fn line(
    record: &Object,
    _path: &Path,
    state: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    codex_line(ToolId::EveryCode, record, state, diagnostics)
}

static EVERY_CODE: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: false,
        quotas: false,
    },
    // Rollouts are appended; the `.snapshot.json` written beside a resumed one is not usage.
    kind: |path| {
        path.as_os_str()
            .as_encoded_bytes()
            .ends_with(b".jsonl")
            .then_some(SourceKind::Jsonl)
    },
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
    Some(&EVERY_CODE)
}

#[cfg(test)]
mod tests {
    use crate::readers::{ParserState, parse_usage_line};
    use serde_json::json;
    use std::path::Path;
    use tokentracky_core::ToolId;

    fn read(lines: &[serde_json::Value]) -> Vec<tokentracky_core::ParseResult> {
        let mut state = ParserState::default();
        lines
            .iter()
            .map(|line| {
                parse_usage_line(
                    ToolId::EveryCode,
                    &line.to_string(),
                    Path::new("rollout.jsonl"),
                    &mut state,
                )
            })
            .collect()
    }

    #[test]
    fn takes_cache_writes_out_of_input_and_checks_they_fit() {
        let usage = |input: u64, write: u64| {
            json!({"timestamp": "2026-10-20T12:00:00.000Z", "type": "event", "payload": {"id": "1", "event_seq": 3,
                "msg": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": input,
                "cached_input_tokens": 100, "cache_write_input_tokens": write, "output_tokens": 50,
                "reasoning_output_tokens": 20, "total_tokens": input + 50}}}}})
        };
        let meta = json!({"type": "session_meta", "payload": {"id": "s", "cwd": "/synthetic/every-code"}});
        let results = read(&[meta.clone(), usage(1000, 300)]);
        let event = &results[1].events[0];
        assert_eq!(event.event_id.split(':').next(), Some("everycode"));
        assert_eq!(event.model, "unknown");
        let t = &event.tokens;
        assert_eq!(
            (t.input, t.cache_read, t.cache_write, t.output, t.reasoning),
            (600, 100, 300, 50, Some(20))
        );
        assert_eq!(tokentracky_core::total_tokens(t), 1050);
        // Cached and written input together larger than input cannot be converted.
        let results = read(&[meta.clone(), usage(350, 300)]);
        assert_eq!(results[1].diagnostics, ["invalid_counters"]);
        let results = read(&[meta, usage(250, 300)]);
        assert_eq!(results[1].diagnostics, ["invalid_counters"]);
    }

    #[test]
    fn codex_keeps_its_own_record_types_and_cache_fields() {
        let meta = json!({"type": "session_meta", "payload": {"id": "s"}});
        let event = json!({"type": "event", "payload": {"msg": {"type": "token_count", "info": {"last_token_usage":
            {"input_tokens": 10, "output_tokens": 1}}}}});
        let mut state = ParserState::default();
        for line in [&meta, &event] {
            let result = parse_usage_line(ToolId::Codex, &line.to_string(), Path::new("rollout.jsonl"), &mut state);
            assert!(result.events.is_empty(), "{line}");
        }
        let written = json!({"timestamp": "2026-10-20T12:00:00.000Z", "type": "event_msg", "payload": {"type":
            "token_count", "info": {"last_token_usage":
            {"input_tokens": 10, "cache_write_input_tokens": 4, "output_tokens": 1}, "requested_model": "m"}}});
        let result = parse_usage_line(
            ToolId::Codex,
            &written.to_string(),
            Path::new("rollout.jsonl"),
            &mut state,
        );
        let event = &result.events[0];
        assert_eq!((event.tokens.input, event.tokens.cache_write), (6, 4));
        assert_eq!(event.model, "unknown");
        assert!(event.event_id.starts_with("codex:"));
    }
}
