//! Grok Build (xAI): `~/.grok/sessions/<project>/<session>/updates.jsonl`, each session's log of agent updates, where
//! the folder `<project>` is the working folder percent-encoded. A `turn_completed` update ends one prompt and carries
//! its usage by model in `usage.modelUsage`: `inputTokens` with the cache reads and writes inside it
//! (`cachedReadTokens`, `cacheCreationTokens`), `outputTokens` with `reasoningTokens` inside it (`totalTokens` is input
//! plus output), and `costUsdTicks`, what xAI billed in 10^-10 USD. One event per model per prompt, keyed by the
//! update's `eventId`; a prompt without usage counts nothing. Context-size watermarks are not token usage.
//! Grok's own cost is kept, including long-context rates, unless Grok marks it partial or the usage incomplete. Only these fields are read: `chat_history.jsonl`
//! and the rest of the session folder, which hold the conversation, are never opened.
use super::adapters::{Adapter, SourceKind};
use super::parser::{
    Counted, Invalid, Object, TEXT_LIMIT, counter, epoch, field, file_name, is, is_metadata_text, object, optional,
    parent_name, safe_integer, text, usage_event,
};
use serde_json::Value;
use std::path::Path;
use tokentracky_core::{SourceCapabilities, TokenCounts, ToolId, UsageEvent};

pub(super) fn adapter(_: ToolId) -> Option<&'static Adapter> {
    Some(&GROK)
}
static GROK: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: true,
        quotas: false,
    },
    kind: |path| (file_name(path) == "updates.jsonl").then_some(SourceKind::Jsonl),
    ledger: false,
    document: None,
    sidecars: None,
    database: None,
    incremental: None,
    // Read by `turn`, which gives one prompt's usage per model.
    line: None,
    text: None,
    database_supersedes_documents: false,
};

/// The working folder that names the session folder's parent, percent-decoded.
fn project(path: &Path) -> Option<String> {
    let encoded = parent_name(path.parent()?);
    let (bytes, mut decoded, mut at) = (encoded.as_bytes(), Vec::new(), 0);
    while at < bytes.len() {
        if bytes[at] == b'%' {
            decoded.push(u8::from_str_radix(encoded.get(at + 1..at + 3)?, 16).ok()?);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(decoded)
        .ok()
        .filter(|project| is_metadata_text(project, TEXT_LIMIT))
}
/// A cost in 10^-10 USD as micro-USD; none unless positive (zero means unreported).
fn ticks(value: Option<&Value>) -> Option<u64> {
    let ticks = value.and_then(safe_integer).filter(|ticks| *ticks > 0)?;
    Some((ticks as u64 + 5_000) / 10_000)
}

/// A `turn_completed` update's usage: one event per model.
pub(super) fn turn(record: &Object, path: &Path, diagnostics: &mut Vec<String>) -> Counted<Vec<UsageEvent>> {
    let params = object(record.get("params"));
    let update = object(field(params, "update"));
    let Some(usage) = object(field(update, "usage")).filter(|_| is(field(update, "sessionUpdate"), "turn_completed"))
    else {
        return Ok(Vec::new());
    };
    let meta = object(field(params, "_meta"));
    let Some(id) = text(field(meta, "eventId"), 512).or_else(|| text(field(update, "prompt_id"), 512)) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(Vec::new());
    };
    let folder = parent_name(path);
    let session = text(field(params, "sessionId"), 512).unwrap_or(&folder);
    let at = epoch(field(meta, "agentTimestampMs")).or_else(|| {
        let seconds = record.get("timestamp").and_then(safe_integer)?;
        epoch(Some(&Value::from(seconds.checked_mul(1000)?)))
    });
    let project = project(path);
    let incomplete = |usage: &Object| {
        usage.get("usageIsIncomplete") == Some(&Value::Bool(true))
            || usage.get("costIsPartial") == Some(&Value::Bool(true))
    };
    // Without a split by model, the whole prompt is Grok Build's, under the generic model id.
    let models: Vec<(&str, &Object)> = match object(usage.get("modelUsage")).filter(|models| !models.is_empty()) {
        Some(models) => models
            .iter()
            .filter_map(|(model, counts)| Some((model.as_str(), object(Some(counts))?)))
            .collect(),
        None => vec![("grok-build", usage)],
    };
    let mut events = Vec::new();
    for (model, counts) in models {
        if !is_metadata_text(model, 256) {
            diagnostics.push("invalid_record".into());
            continue;
        }
        let (cache_read, cache_write) = (
            optional(counts.get("cachedReadTokens"))?,
            optional(counts.get("cacheCreationTokens"))?,
        );
        let input = counter(counts.get("inputTokens"), false)?
            .checked_sub(cache_read)
            .and_then(|input| input.checked_sub(cache_write))
            .ok_or(Invalid)?;
        let tokens = TokenCounts {
            input,
            output: optional(counts.get("outputTokens"))?,
            cache_read,
            cache_write,
            reasoning: Some(optional(counts.get("reasoningTokens"))?),
            cache_write_1h: None,
        };
        let key = format!("{session}:{id}|{model}");
        if let Some(mut event) = usage_event(
            ToolId::Grok,
            &key,
            session,
            project.as_deref(),
            model,
            at.clone(),
            tokens,
        )? {
            event.cost_microusd = (!incomplete(usage) && !incomplete(counts))
                .then(|| ticks(counts.get("costUsdTicks")))
                .flatten();
            events.push(event);
        }
    }
    Ok(events)
}
