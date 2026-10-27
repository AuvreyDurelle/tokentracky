//! Cline SDK sessions and classic extension tasks.
use super::adapters::{Sidecars, sidecar};
use super::parser::{
    PENDING, TEXT_LIMIT, date, embedded, epoch, event_id, field, file_name, is, keep, note, object, only, optional,
    parent_name, safe_integer, safe_sum, sibling, text, usage_event,
};
use serde_json::Value;
use std::cmp::Ordering;
use std::path::Path;
use tokentracky_core::{ParseResult, TokenCounts, ToolId};

/// Cline v4, its CLI and desktop app (`~/.cline/data/sessions/<id>/<stem>.messages.json`). The last assistant
/// message of a turn carries that turn's metrics. Input includes both cache buckets; since 2026-09-26 output
/// excludes reasoning, which is assumed for every file because they carry no version marker.
pub(crate) fn parse_cline_session(path: &Path, document: &Value, sidecars: &Sidecars) -> ParseResult {
    let Ok(manifest) = sibling(sidecar(sidecars, "manifest")) else {
        return only(PENDING);
    };
    let manifest = manifest.as_ref();
    let Some(messages) = field(document.as_object(), "messages").and_then(Value::as_array) else {
        return only("invalid_record");
    };
    // Sessions imported from Claude Code, Codex or OpenCode repeat usage those adapters already count.
    let imported = object(field(object(field(manifest, "metadata")), "importedFrom"));
    let imported_at =
        imported.and_then(|imported| epoch(imported.get("importedAt")).or_else(|| date(imported.get("importedAt"))));
    let name = file_name(path);
    let session_id = name.strip_suffix(".messages.json").unwrap_or_default();
    let project =
        text(field(manifest, "cwd"), TEXT_LIMIT).or_else(|| text(field(manifest, "workspace_root"), TEXT_LIMIT));
    let (mut events, mut withdrawn, mut diagnostics) = (Vec::new(), Vec::new(), Vec::new());
    for value in messages {
        let Some(message) = value.as_object() else { continue };
        let Some(metrics) = object(message.get("metrics")).filter(|_| is(message.get("role"), "assistant")) else {
            continue;
        };
        let id = text(message.get("id"), 512);
        let occurred_at = epoch(message.get("ts"));
        // Imported usage (all of it without an import time) is withdrawn, in case it was counted before the manifest
        // arrived.
        let before_import = match (&imported_at, &occurred_at) {
            (Some(imported_at), Some(occurred_at)) => occurred_at <= imported_at,
            _ => true,
        };
        if imported.is_some() && before_import {
            if let Some(id) = id {
                withdrawn.push(event_id(ToolId::Cline, &format!("{session_id}|{id}")));
            }
            continue;
        }
        let Some(id) = id else {
            note(&mut diagnostics, "missing_stable_identity");
            continue;
        };
        let event = (|| {
            let cache_read = optional(metrics.get("cacheReadTokens"))?;
            let cache_write = optional(metrics.get("cacheWriteTokens"))?;
            let reasoning = optional(metrics.get("reasoningTokenCount"))?;
            let model = text(field(object(message.get("modelInfo")), "id"), 256)
                .or_else(|| text(field(manifest, "model"), 256))
                .unwrap_or("unknown");
            let tokens = TokenCounts {
                input: optional(metrics.get("inputTokens"))?
                    .saturating_sub(cache_read)
                    .saturating_sub(cache_write),
                output: safe_sum(&[optional(metrics.get("outputTokens"))?, reasoning])?,
                cache_read,
                cache_write,
                reasoning: Some(reasoning),
                cache_write_1h: None,
            };
            usage_event(
                ToolId::Cline,
                &format!("{session_id}|{id}"),
                session_id,
                project,
                model,
                occurred_at,
                tokens,
            )
        })();
        keep(event, &mut events, &mut diagnostics);
    }
    ParseResult {
        events,
        diagnostics,
        withdrawn: (!withdrawn.is_empty()).then_some(withdrawn),
    }
}

/// Classic Cline extension tasks (`globalStorage/saoudrizwan.claude-dev/tasks/<id>/ui_messages.json`). Each
/// `api_req_started` message carries one request's usage in its JSON `text`, updated in place when the stream
/// ends; `subagent_usage` adds subagent runs. `deleted_api_reqs` repeats requests already counted.
pub(crate) fn parse_cline_task(path: &Path, document: &Value, sidecars: &Sidecars) -> ParseResult {
    let Some(messages) = document.as_array() else {
        return only("invalid_record");
    };
    let task_id = parent_name(path);
    let metadata = sibling(sidecar(sidecars, "metadata")).ok().flatten();
    let usage = field(metadata.as_ref(), "model_usage").and_then(Value::as_array);
    let mut models: Vec<(f64, &str)> = usage
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            Some((entry.get("ts")?.as_f64()?, text(entry.get("model_id"), 256)?))
        })
        .collect();
    models.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
    let (mut events, mut diagnostics) = (Vec::new(), Vec::new());
    for value in messages {
        let Some(message) = value.as_object() else { continue };
        let subagent = is(message.get("say"), "subagent_usage");
        if !is(message.get("type"), "say") || !(subagent || is(message.get("say"), "api_req_started")) {
            continue;
        }
        let Some(info) = embedded(message.get("text")) else {
            continue;
        };
        let Some(ts) = message.get("ts").and_then(safe_integer) else {
            note(&mut diagnostics, "missing_stable_identity");
            continue;
        };
        let model = text(field(object(message.get("modelInfo")), "modelId"), 256)
            .or_else(|| {
                models
                    .iter()
                    .rev()
                    .find(|(at, _)| *at <= ts as f64)
                    .map(|(_, model)| *model)
            })
            .unwrap_or("unknown");
        let event = (|| {
            let tokens = TokenCounts {
                input: optional(info.get("tokensIn"))?,
                output: optional(info.get("tokensOut"))?,
                cache_read: optional(info.get("cacheReads"))?,
                cache_write: optional(info.get("cacheWrites"))?,
                reasoning: None,
                cache_write_1h: None,
            };
            let key = format!("{task_id}|{ts}{}", if subagent { "|subagent" } else { "" });
            usage_event(
                ToolId::Cline,
                &key,
                &task_id,
                None,
                model,
                epoch(message.get("ts")),
                tokens,
            )
        })();
        keep(event, &mut events, &mut diagnostics);
    }
    ParseResult {
        events,
        diagnostics,
        withdrawn: None,
    }
}
