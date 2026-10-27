//! LM Studio: the local server's text logs, `~/.lmstudio/server-logs/**/*.log`. Each entry starts with a line stamped
//! `[YYYY-MM-DD HH:MM:SS]` (newer versions drop the brackets) in the computer's time zone, and a non-streamed
//! completion is logged as `Generated prediction: {` followed by the pretty-printed OpenAI-compatible response. Only the
//! response's `id`, `model`, `created` time and `usage` are kept; the rest of the log, prompts and replies included, is
//! dropped. Every model runs locally, so its usage is priced at $0.
use super::adapters::{Adapter, Sidecars, SourceKind};
use super::iso;
use super::parser::{
    Counted, EventMap, Invalid, Object, counter, field, file_name, keep, note, object, optional, parse_json,
    safe_integer, safe_sum, text, usage_event,
};
use serde_json::Value;
use std::path::Path;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};
use tokentracky_core::{ParseResult, SourceCapabilities, TokenCounts, ToolId, UsageEvent};

static LMSTUDIO: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: false,
        costs: false,
        quotas: false,
    },
    kind: |path| file_name(path).ends_with(".log").then_some(SourceKind::Json),
    ledger: true,
    document: None,
    sidecars: None,
    database: None,
    incremental: None,
    line: None,
    text: Some(read_log),
    database_supersedes_documents: false,
};

/// The tool's adapter.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&LMSTUDIO)
}

fn read_log(path: &Path, content: &str, _: &Sidecars) -> ParseResult {
    parse_log(path, content, |at| UtcOffset::local_offset_at(at).ok())
}

/// The ids of a Chat Completions, legacy Completions or Responses API response.
const RESPONSE_IDS: [&str; 3] = ["chatcmpl-", "cmpl-", "resp_"];

/// Reads each entry's response; `offset_at` is the computer's UTC offset at an instant. A response id logged twice
/// (here or in another file) is one event; the session is the log file.
fn parse_log(path: &Path, content: &str, offset_at: impl Fn(OffsetDateTime) -> Option<UtcOffset>) -> ParseResult {
    let name = file_name(path);
    let session = name.strip_suffix(".log").unwrap_or(&name);
    let mut entries: Vec<(PrimitiveDateTime, usize)> = Vec::new();
    let mut at = 0;
    for line in content.split_inclusive('\n') {
        entries.extend(stamp(line).map(|logged| (logged, at)));
        at += line.len();
    }
    let ends = entries.iter().skip(1).map(|(_, start)| *start).chain([content.len()]);
    let (mut found, mut diagnostics) = (Vec::new(), Vec::new());
    for ((logged, start), end) in entries.iter().zip(ends) {
        let logged = || utc_from_local(*logged, &offset_at).map(|at| iso::iso_string(milliseconds(at)));
        let event = entry(&content[*start..end], session, logged, &mut diagnostics);
        keep(event, &mut found, &mut diagnostics);
    }
    let mut events = EventMap::default();
    found.into_iter().for_each(|event| events.insert(event));
    ParseResult {
        events: events.into_events(),
        diagnostics,
        withdrawn: None,
    }
}

/// The response logged in one entry, if any: the first balanced JSON object of the entry, with a `usage` object.
fn entry(
    body: &str,
    session: &str,
    logged: impl Fn() -> Option<String>,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    let Some(start) = body.find('{') else { return Ok(None) };
    let Some(Value::Object(response)) = balanced(&body[start..]).and_then(parse_json) else {
        return Ok(None);
    };
    let Some(usage) = object(response.get("usage")) else {
        return Ok(None);
    };
    let id = text(response.get("id"), 512).filter(|id| RESPONSE_IDS.iter().any(|prefix| id.starts_with(prefix)));
    let Some(id) = id else {
        note(diagnostics, "missing_stable_identity");
        return Ok(None);
    };
    // The response's own creation time (UTC epoch seconds) needs no zone; the entry's local time is the fallback.
    let created = ["created", "created_at"]
        .iter()
        .find_map(|key| response.get(*key).and_then(safe_integer))
        .filter(|seconds| *seconds > 0 && *seconds <= 8_640_000_000_000)
        .map(|seconds| iso::iso_string(seconds * 1000));
    usage_event(
        ToolId::LmStudio,
        id,
        session,
        None,
        text(response.get("model"), 256).unwrap_or("unknown"),
        created.or_else(logged),
        tokens(usage)?,
    )
}

/// OpenAI usage, where the prompt includes its cached part and the completion its reasoning. Chat Completions write
/// `prompt_tokens` and `completion_tokens`, the Responses API `input_tokens` and `output_tokens` (LM Studio's own example:
/// 1,276 of 1,293 input tokens cached, 42 output, total 1,335). There is no cache write. `total_tokens` must match.
fn tokens(usage: &Object) -> Counted<TokenCounts> {
    let (prompt, completion, prompt_details, completion_details) = if usage.contains_key("prompt_tokens") {
        (
            "prompt_tokens",
            "completion_tokens",
            "prompt_tokens_details",
            "completion_tokens_details",
        )
    } else {
        (
            "input_tokens",
            "output_tokens",
            "input_tokens_details",
            "output_tokens_details",
        )
    };
    let prompt = counter(usage.get(prompt), false)?;
    let output = counter(usage.get(completion), false)?;
    let cached = optional(field(object(usage.get(prompt_details)), "cached_tokens"))?;
    let reasoning = optional(field(object(usage.get(completion_details)), "reasoning_tokens"))?;
    if let Some(total) = usage.get("total_tokens").filter(|total| !total.is_null())
        && counter(Some(total), false)? != safe_sum(&[prompt, output])?
    {
        return Err(Invalid);
    }
    Ok(TokenCounts {
        input: prompt.checked_sub(cached).ok_or(Invalid)?,
        output,
        cache_read: cached,
        cache_write: 0,
        reasoning: Some(reasoning),
        cache_write_1h: None,
    })
}

/// The JSON object at the start of `text`, up to its matching brace, or `None` when the entry ends first.
fn balanced(text: &str) -> Option<&str> {
    let (mut depth, mut string, mut escaped) = (0usize, false, false);
    for (at, byte) in text.bytes().enumerate() {
        match byte {
            _ if escaped => escaped = false,
            b'\\' if string => escaped = true,
            b'"' => string = !string,
            _ if string => {}
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&text[..=at]);
                }
            }
            _ => {}
        }
    }
    None
}

/// The local time an entry's first line starts with: `[2026-10-20 14:00:00]` or `2026-10-20 14:00:00`, any fraction of a
/// second ignored.
fn stamp(line: &str) -> Option<PrimitiveDateTime> {
    let bracket = usize::from(line.starts_with('['));
    let digits = line.get(bracket..bracket + 19)?.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<u16> {
        let part = digits.get(range)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0, |n, d| n * 10 + u16::from(d - b'0')))
    };
    let shape = [(4, b'-'), (7, b'-'), (10, b' '), (13, b':'), (16, b':')];
    if !shape.iter().all(|(at, separator)| digits[*at] == *separator) {
        return None;
    }
    let date = Date::from_calendar_date(
        i32::from(number(0..4)?),
        Month::try_from(u8::try_from(number(5..7)?).ok()?).ok()?,
        u8::try_from(number(8..10)?).ok()?,
    )
    .ok()?;
    let [hour, minute, second] = [number(11..13)?, number(14..16)?, number(17..19)?].map(|n| n as u8);
    let time = Time::from_hms(hour, minute, second).ok()?;
    Some(PrimitiveDateTime::new(date, time))
}

/// A wall-clock time read in the computer's zone, through its offset at that instant. A time that a daylight saving
/// change skips or repeats is read with one of the two offsets around it.
fn utc_from_local(
    local: PrimitiveDateTime,
    offset_at: impl Fn(OffsetDateTime) -> Option<UtcOffset>,
) -> Option<OffsetDateTime> {
    let first = offset_at(local.assume_utc())?;
    let second = offset_at(local.assume_offset(first))?;
    Some(local.assume_offset(second))
}

fn milliseconds(at: OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use time::macros::{datetime, offset};

    fn counts(usage: Value) -> Result<(u64, u64, u64, Option<u64>), ()> {
        let read = tokens(usage.as_object().unwrap()).map_err(|_| ())?;
        assert_eq!(read.cache_write, 0);
        Ok((read.input, read.output, read.cache_read, read.reasoning))
    }

    #[test]
    fn reads_both_usage_shapes_with_cache_inside_the_prompt_and_reasoning_inside_the_completion() {
        // lmstudio.ai/blog/openresponses: 1,276 of 1,293 input tokens cached, 42 output, total 1,335.
        let responses = json!({"input_tokens": 1293, "output_tokens": 42, "total_tokens": 1335,
            "input_tokens_details": {"cached_tokens": 1276}, "output_tokens_details": {"reasoning_tokens": 0}});
        assert_eq!(counts(responses), Ok((17, 42, 1276, Some(0))));
        let chat = json!({"prompt_tokens": 72064, "completion_tokens": 73, "total_tokens": 72137,
            "prompt_tokens_details": {"cached_tokens": 64}, "completion_tokens_details": {"reasoning_tokens": 20}});
        assert_eq!(counts(chat), Ok((72000, 73, 64, Some(20))));
        assert_eq!(
            counts(json!({"prompt_tokens": 5, "completion_tokens": 2})),
            Ok((5, 2, 0, Some(0)))
        );
        for invalid in [
            json!({"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 8}),
            json!({"prompt_tokens": 5, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": 6}}),
            json!({"prompt_tokens": 5}),
            json!({"input_tokens": 5, "output_tokens": -2}),
            json!({}),
        ] {
            assert_eq!(counts(invalid.clone()), Err(()), "{invalid}");
        }
    }

    #[test]
    fn reads_local_times_through_the_offset_of_their_instant() {
        let fixed = |offset: UtcOffset| move |_: OffsetDateTime| Some(offset);
        assert_eq!(
            utc_from_local(datetime!(2026-07-09 10:00:00), fixed(offset!(+2))),
            Some(datetime!(2026-07-09 08:00:00 UTC))
        );
        assert_eq!(
            utc_from_local(datetime!(2026-07-09 10:00:00), fixed(offset!(-7))),
            Some(datetime!(2026-07-09 17:00:00 UTC))
        );
        // A zone that moves from +1 to +2 at 01:00 UTC (02:00 local) on 29 March 2026.
        let europe = |at: OffsetDateTime| {
            Some(if at < datetime!(2026-03-29 01:00:00 UTC) {
                offset!(+1)
            } else {
                offset!(+2)
            })
        };
        assert_eq!(
            utc_from_local(datetime!(2026-03-29 01:30:00), europe),
            Some(datetime!(2026-03-29 00:30:00 UTC))
        );
        assert_eq!(
            utc_from_local(datetime!(2026-03-29 03:30:00), europe),
            Some(datetime!(2026-03-29 01:30:00 UTC))
        );
        // And back from +2 to +1 at 01:00 UTC (03:00 local) on 25 October 2026: 02:30 local happens twice.
        let autumn = |at: OffsetDateTime| {
            Some(if at < datetime!(2026-10-25 01:00:00 UTC) {
                offset!(+2)
            } else {
                offset!(+1)
            })
        };
        assert_eq!(
            utc_from_local(datetime!(2026-10-25 02:30:00), autumn),
            Some(datetime!(2026-10-25 01:30:00 UTC))
        );
        assert_eq!(utc_from_local(datetime!(2026-07-09 10:00:00), |_| None), None);
    }

    #[test]
    fn reads_every_logged_response_once_and_nothing_but_its_metadata() {
        let log = [
            "[2026-07-09 10:00:00][INFO][LM STUDIO SERVER] Running chat completion on conversation with 2 messages.",
            "[2026-07-09 10:00:05][INFO][qwen2.5-7b-instruct] Generated prediction:  {",
            r#"  "id": "chatcmpl-a","#,
            r#"  "object": "chat.completion","#,
            r#"  "model": "qwen2.5-7b-instruct","#,
            r#"  "choices": [{"message": {"content": "PRIVATE_reply \"usage\": {\"prompt_tokens\": 999} }"}}],"#,
            r#"  "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}"#,
            "}",
            "2026-07-09 10:01:00  [INFO]",
            r#" [qwen2.5-7b-instruct] Generated prediction:  {"id": "chatcmpl-a", "model": "qwen2.5-7b-instruct","#,
            r#"  "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}"#,
            "2026-07-09 10:02:00 [INFO] [m] Generated prediction:  {\"usage\": {\"prompt_tokens\": 1, \"completion_tokens\": 1}}",
            "[2026-07-09 10:03:00][INFO][m] Generated prediction:  {\"id\": \"resp_b\",",
        ]
        .join("\r\n");
        let result = parse_log(Path::new("/l/2026-07/2026-07-09.1.log"), &log, |_| Some(offset!(+2)));
        assert_eq!(result.diagnostics, ["missing_stable_identity"]);
        assert_eq!(result.events.len(), 1);
        let event = &result.events[0];
        assert_eq!(
            (
                event.session_id.as_str(),
                event.model.as_str(),
                event.occurred_at.as_deref()
            ),
            ("2026-07-09.1", "qwen2.5-7b-instruct", Some("2026-07-09T08:01:00.000Z"))
        );
        assert_eq!(tokentracky_core::total_tokens(&event.tokens), 14);
        assert!(!serde_json::to_string(&result).unwrap().contains("PRIVATE_"));
    }
}
