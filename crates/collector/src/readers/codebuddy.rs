//! CodeBuddy Code (Tencent): `~/.codebuddy/projects/**/*.jsonl` (`$CODEBUDDY_CONFIG_DIR/projects`), session
//! transcripts of `{id, type, role, timestamp (epoch ms), sessionId, providerData}` records. Each model round trip
//! leaves its provider's raw OpenAI-style usage as `providerData.rawUsage` on the records it produced, a
//! `function_call` and a `message` sharing `providerData.messageId`, so that id is the key (else the record's `uuid`,
//! else its `id`). `prompt_tokens` includes cache reads and writes, as `getCurrentContextUsage` in
//! @tencent-ai/codebuddy-code 2.176.0 `dist/codebuddy.js` subtracts them, and `completion_tokens` includes
//! `completion_tokens_details.reasoning_tokens`; `total_tokens` is their sum. `rawUsage.credit` is not read, nor are
//! the IDE extension's logs. The model is `providerData.model` (the answering model, else the requested one).
use super::adapters::{Adapter, SourceKind};
use super::parser::{
    Counted, Invalid, Object, ParserState, counter, epoch, field, file_name, is_metadata_text, object, optional,
    safe_sum, text, usage_event,
};
use serde_json::Value;
use std::path::Path;
use tokentracky_core::{SourceCapabilities, TokenCounts, ToolId, UsageEvent};

/// The first positive count, as CodeBuddy reads mirrored cache fields; a malformed one is still `invalid_counters`.
fn first_positive(values: &[Option<&Value>]) -> Counted<u64> {
    for value in values {
        let count = optional(*value)?;
        if count > 0 {
            return Ok(count);
        }
    }
    Ok(0)
}

fn line(
    record: &Object,
    path: &Path,
    _state: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    let provider = object(record.get("providerData"));
    let Some(raw) = object(field(provider, "rawUsage")) else {
        return Ok(None);
    };
    let key = text(field(provider, "messageId"), 512)
        .or_else(|| text(record.get("uuid"), 512))
        .or_else(|| text(record.get("id"), 512));
    let stem = file_name(path).strip_suffix(".jsonl").map(str::to_owned);
    let session = text(record.get("sessionId"), 512)
        .map(Into::into)
        .or(stem.filter(|stem| is_metadata_text(stem, 512)));
    let (Some(key), Some(session)) = (key, session) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let prompt = counter(raw.get("prompt_tokens"), false)?;
    let completion = counter(raw.get("completion_tokens"), false)?;
    if let Some(total) = raw.get("total_tokens").filter(|total| !total.is_null())
        && counter(Some(total), false)? != safe_sum(&[prompt, completion])?
    {
        return Err(Invalid);
    }
    let details = object(raw.get("prompt_tokens_details"));
    let cache_read = first_positive(&[
        raw.get("cache_read_input_tokens"),
        field(details, "cached_tokens"),
        raw.get("prompt_cache_hit_tokens"),
    ])?;
    let cache_write = first_positive(&[
        raw.get("cache_creation_input_tokens"),
        raw.get("prompt_cache_write_tokens"),
    ])?;
    let input = prompt
        .checked_sub(cache_read)
        .and_then(|input| input.checked_sub(cache_write))
        .ok_or(Invalid)?;
    let reasoning = optional(field(object(raw.get("completion_tokens_details")), "reasoning_tokens"))?;
    let tokens = TokenCounts {
        input,
        output: completion,
        cache_read,
        cache_write,
        reasoning: Some(reasoning),
        cache_write_1h: None,
    };
    let model = text(field(provider, "model"), 256)
        .or_else(|| text(record.get("model"), 256))
        .unwrap_or("unknown");
    usage_event(
        ToolId::CodeBuddy,
        key,
        &session,
        None,
        model,
        epoch(record.get("timestamp")),
        tokens,
    )
}

static CODEBUDDY: Adapter = Adapter {
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: false,
        costs: false,
        quotas: false,
    },
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
    Some(&CODEBUDDY)
}

#[cfg(test)]
mod tests {
    use crate::readers::{ParserState, parse_usage_line};
    use serde_json::{Value, json};
    use std::path::Path;
    use tokentracky_core::{ParseResult, ToolId};

    fn read(lines: &[Value]) -> Vec<ParseResult> {
        let mut state = ParserState::default();
        lines
            .iter()
            .map(|line| {
                parse_usage_line(
                    ToolId::CodeBuddy,
                    &line.to_string(),
                    Path::new("/p/s/s1.jsonl"),
                    &mut state,
                )
            })
            .collect()
    }
    fn record(message: Value, usage: Value) -> Value {
        json!({"id": "r", "type": "function_call", "timestamp": 1792746000000_u64, "sessionId": "s1",
            "providerData": {"model": "deepseek-v4", "messageId": message, "rawUsage": usage}})
    }

    #[test]
    fn takes_both_caches_out_of_the_prompt_and_checks_the_total() {
        let usage = json!({"prompt_tokens": 1000, "completion_tokens": 300, "total_tokens": 1300,
            "prompt_tokens_details": {"cached_tokens": 0}, "prompt_cache_hit_tokens": 700,
            "prompt_cache_write_tokens": 100, "completion_tokens_details": {"reasoning_tokens": 120}, "credit": 9});
        let results = read(&[
            record(json!("m1"), usage),
            record(
                json!("m2"),
                json!({"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 12}),
            ),
            record(
                json!("m3"),
                json!({"prompt_tokens": 10, "completion_tokens": 1, "cache_read_input_tokens": 8,
                "cache_creation_input_tokens": 3}),
            ),
            record(
                json!("m4"),
                json!({"prompt_tokens": 10, "completion_tokens": 1,
                "completion_tokens_details": {"reasoning_tokens": 2}}),
            ),
        ]);
        let event = &results[0].events[0];
        let t = &event.tokens;
        assert_eq!(
            (t.input, t.cache_read, t.cache_write, t.output, t.reasoning),
            (200, 700, 100, 300, Some(120))
        );
        assert_eq!(tokentracky_core::total_tokens(t), 1300);
        assert_eq!((event.model.as_str(), event.session_id.as_str()), ("deepseek-v4", "s1"));
        assert_eq!(event.occurred_at.as_deref(), Some("2026-10-23T09:00:00.000Z"));
        for result in &results[1..] {
            assert_eq!(result.diagnostics, ["invalid_counters"]);
        }
    }

    #[test]
    fn keys_a_round_trip_by_its_message_id_then_uuid_then_id() {
        let usage = json!({"prompt_tokens": 10, "completion_tokens": 1});
        let call = record(json!("m1"), usage.clone());
        let mut message = record(json!("m1"), usage.clone());
        message["id"] = json!("other");
        message["type"] = json!("message");
        let mut by_uuid = record(Value::Null, usage.clone());
        by_uuid["uuid"] = json!("u");
        let by_id = record(Value::Null, usage);
        let ids: Vec<_> = read(&[call, message, by_uuid, by_id])
            .into_iter()
            .map(|result| result.events[0].event_id.clone())
            .collect();
        assert_eq!(ids[0], ids[1]);
        assert_eq!(ids[2], crate::readers::parser::event_id(ToolId::CodeBuddy, "u"));
        assert_eq!(ids[3], crate::readers::parser::event_id(ToolId::CodeBuddy, "r"));
    }
}
