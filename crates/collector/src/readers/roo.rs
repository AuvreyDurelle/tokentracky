//! Roo Code and Kilo Code version 5 tasks.
use super::adapters::{Sidecars, sidecar};
use super::parser::{
    PENDING, TEXT_LIMIT, embedded, epoch, field, is, is_js_space, is_metadata_text, keep, note, only, optional,
    parent_name, safe_integer, sibling, text, usage_event,
};
use serde_json::Value;
use std::path::Path;
use tokentracky_core::{ParseResult, TokenCounts, ToolId};

/// The model named by the last `<model>` tag the extension writes into `<environment_details>` (the last match of
/// `/<model>([^<\\"]{1,256})<\/model>/g` in the raw conversation text, trimmed).
fn last_model(history: Option<&str>) -> Option<&str> {
    let history = history?;
    let tag = history.match_indices("<model>").filter_map(|(at, open)| {
        let body = &history[at + open.len()..];
        let end = body.find(['<', '\\', '"']).unwrap_or(body.len());
        let name = &body[..end];
        (body[end..].starts_with("</model>") && (1..=256).contains(&name.encode_utf16().count())).then_some(name)
    });
    Some(tag.last()?.trim_matches(is_js_space)).filter(|name| is_metadata_text(name, 256))
}

/// Roo Code and Kilo Code v5 tasks (`globalStorage/<extension>/tasks/<id>/ui_messages.json`). Each `api_req_started`
/// message holds one request's usage in its JSON `text`, updated in place. Since 2025-10-31 `tokensIn` includes both
/// cache buckets; a `tokensIn` smaller than them comes from an older file, where it was already uncached.
/// `api_req_deleted` summarises requests already counted. Kilo also records fast-apply calls on `tool` asks.
pub(crate) fn parse_task_messages(tool: ToolId, path: &Path, document: &Value, sidecars: &Sidecars) -> ParseResult {
    let Ok(item) = sibling(sidecar(sidecars, "item")) else {
        return only(PENDING);
    };
    let Some(messages) = document.as_array() else {
        return only("invalid_record");
    };
    let task_id = parent_name(path);
    let model = last_model(sidecar(sidecars, "history")).unwrap_or("unknown");
    let project = text(field(item.as_ref(), "workspace"), TEXT_LIMIT);
    let (mut events, mut diagnostics) = (Vec::new(), Vec::new());
    for value in messages {
        let Some(message) = value.as_object() else { continue };
        let fast_apply = tool == ToolId::Kilo && is(message.get("type"), "ask") && is(message.get("ask"), "tool");
        let info = if fast_apply {
            embedded(message.get("text")).and_then(|mut text| match text.remove("fastApplyResult") {
                Some(Value::Object(result)) => Some(result),
                _ => None,
            })
        } else if is(message.get("type"), "say") && is(message.get("say"), "api_req_started") {
            embedded(message.get("text"))
        } else {
            None
        };
        let Some(info) = info else { continue };
        let Some(ts) = message.get("ts").and_then(safe_integer) else {
            note(&mut diagnostics, "missing_stable_identity");
            continue;
        };
        let event = (|| {
            let tokens_in = optional(info.get("tokensIn"))?;
            let cache_read = optional(info.get("cacheReads"))?;
            let cache_write = optional(info.get("cacheWrites"))?;
            let tokens = TokenCounts {
                input: if tokens_in < cache_read + cache_write {
                    tokens_in
                } else {
                    tokens_in - cache_read - cache_write
                },
                output: optional(info.get("tokensOut"))?,
                cache_read,
                cache_write,
                reasoning: None,
                cache_write_1h: None,
            };
            let key = format!("{task_id}|{ts}{}", if fast_apply { "|fastApply" } else { "" });
            let model = if fast_apply { "unknown" } else { model };
            usage_event(tool, &key, &task_id, project, model, epoch(message.get("ts")), tokens)
        })();
        keep(event, &mut events, &mut diagnostics);
    }
    ParseResult {
        events,
        diagnostics,
        withdrawn: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_last_model_tag_like_the_regular_expression() {
        assert_eq!(last_model(Some("<model>a</model> x <model> b </model>")), Some("b"));
        assert_eq!(last_model(Some("<model>a</model><model>\\nb</model>")), Some("a"));
        assert_eq!(last_model(Some("<model><model>c</model>")), Some("c"));
        assert_eq!(last_model(Some("<model>a</model><model>x\ny</model>")), None);
        assert_eq!(last_model(Some(&format!("<model>{}</model>", "m".repeat(257)))), None);
        assert_eq!(
            last_model(Some(&format!("<model>{}</model>", "\u{1f600}".repeat(128)))).map(str::len),
            Some(512)
        );
        assert_eq!(last_model(Some("<model>   </model>")), None);
        assert_eq!(last_model(None), None);
    }
}
