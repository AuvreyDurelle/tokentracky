//! The line readers (Claude Code, Codex, Gemini CLI) and the helpers every reader shares.
//! JSON values stand in for JavaScript's: `Option<&Value>` is `unknown`, with `None` for an absent field (`undefined`).
use super::iso;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use tokentracky_core::{
    MAX_SAFE_INTEGER, ParseResult, TokenCounts, ToolId, UsageEvent, checked_sum, is_js_space, is_safe_count,
};

/// Re-read accounting, OmO mirror identities, the combined parser state, and Codex fork copies told by their parent's
/// totals.
pub const PARSER_VERSION: u32 = 11;
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// A document that does not parse may be mid-write; it is retried on the next scan.
pub const PENDING: &str = "partial_document_pending";
/// Tools whose records are appended lines: [`parse_usage_line`] and [`parse_usage_file`] read them.
const LINE_TOOLS: [ToolId; 4] = [ToolId::Claude, ToolId::Codex, ToolId::Gemini, ToolId::Grok];
/// Length limit of free metadata text such as a working folder, in UTF-16 units as JavaScript counts.
pub(crate) const TEXT_LIMIT: usize = 4096;

/// Gemini CLI writes each whole message, tool results included, on one line, and DeepSeek Harness each assistant
/// message with its whole stream of deltas, so their usage needs room.
pub fn line_limit(tool: ToolId) -> usize {
    if matches!(tool, ToolId::Gemini | ToolId::DeepSeek) {
        16 * MAX_LINE_BYTES
    } else {
        MAX_LINE_BYTES
    }
}

/// What every line holding a tool's usage contains, its usage key (escaped inside text, it cannot match): a longer
/// line without it is skipped without a diagnostic. `None` reports every long line.
fn usage_marker(tool: ToolId) -> Option<&'static [u8]> {
    match tool {
        ToolId::Claude => Some(br#""usage""#),
        ToolId::Codex | ToolId::EveryCode => Some(br#""token_count""#),
        ToolId::Grok => Some(br#""turn_completed""#),
        _ => None,
    }
}
/// Whether a line too long to read, fed in pieces, may have held usage: it holds the tool's usage marker.
pub(crate) struct MayHoldUsage {
    marker: Option<&'static [u8]>,
    /// The end of what was fed, short of a whole marker.
    carry: Vec<u8>,
    found: bool,
}
impl MayHoldUsage {
    pub fn new(tool: ToolId) -> Self {
        Self {
            marker: usage_marker(tool),
            carry: Vec::new(),
            found: false,
        }
    }
    pub fn feed(&mut self, bytes: &[u8]) {
        let Some(marker) = self.marker.filter(|_| !self.found) else {
            return;
        };
        self.carry.extend_from_slice(bytes);
        self.found = self.carry.windows(marker.len()).any(|window| window == marker);
        let keep = self.carry.len().saturating_sub(marker.len() - 1);
        self.carry.drain(..keep);
    }
    /// The answer for the line fed so far; the next line starts afresh.
    pub fn take(&mut self) -> bool {
        let may = self.marker.is_none() || self.found;
        self.carry.clear();
        self.found = false;
        may
    }
}

pub(crate) type Object = Map<String, Value>;
/// A counter that is not a safe non-negative integer, or counts that cannot be: `invalid_counters`.
pub(crate) struct Invalid;
pub(crate) type Counted<T> = Result<T, Invalid>;

/// Codex counters as logged: input includes cache reads and writes, output includes reasoning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct RawCounts {
    pub input: u64,
    pub cached: u64,
    pub write: u64,
    pub output: u64,
    pub reasoning: u64,
}
impl RawCounts {
    fn minus(self, other: Self) -> Option<Self> {
        let (a, b) = (self.values(), other.values());
        a.iter().zip(b).all(|(a, b)| *a >= b).then(|| Self {
            input: self.input - other.input,
            cached: self.cached - other.cached,
            write: self.write - other.write,
            output: self.output - other.output,
            reasoning: self.reasoning - other.reasoning,
        })
    }
    fn values(self) -> [u64; 5] {
        [self.input, self.cached, self.write, self.output, self.reasoning]
    }
    fn is_zero(self) -> bool {
        self == Self::default()
    }
}

/// One window of a Codex rate-limit snapshot (F6), bounded as the store's allowlist requires.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    /// From 0 to 100; a reading above 100 is kept as 100.
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at_ms: Option<i64>,
}
/// A rollout's latest rate-limit snapshot of the plan's own limit, and the time of its record.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    pub at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<RateWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<RateWindow>,
}

/// What a line log's reader carries from one line to the next, persisted as JSON inside the file checkpoint.
/// Only allowlisted usage metadata, never raw records. `ParserState::default()` is TypeScript's `newParserState()`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParserState {
    pub session_id: Option<String>,
    pub project: Option<String>,
    pub model: String,
    pub turn_id: Option<String>,
    /// The last Codex cumulative total.
    pub previous: Option<RawCounts>,
    /// Recent Codex cumulative totals (at most 64): a repeated one is a replay, a known one a lineage.
    pub baselines: Vec<RawCounts>,
    /// Recent Codex delta-only event ids (at most 256), so their replay is not counted again.
    pub seen_delta_ids: Vec<String>,
    /// While a forked or spawned rollout replays its parent's counters: the epoch milliseconds of the last copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_copy_at: Option<i64>,
    /// The parent thread of a forked or spawned rollout, while its copies may still follow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_parent: Option<String>,
    /// The epoch milliseconds of the last Codex token count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counted_at: Option<i64>,
    /// Where the scan finds a parent's running totals. Not saved.
    #[serde(skip)]
    pub parents: Parents,
    /// The Codex service tier set by the last `thread_settings_applied` record, while one has said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    /// The rollout's latest Codex rate-limit snapshot, for the local Limits page; never part of usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<RateLimits>,
}
impl Default for ParserState {
    fn default() -> Self {
        Self {
            session_id: None,
            project: None,
            model: "unknown".into(),
            turn_id: None,
            previous: None,
            baselines: Vec::new(),
            seen_delta_ids: Vec::new(),
            fork_copy_at: None,
            fork_parent: None,
            counted_at: None,
            parents: Parents::default(),
            service_tier: None,
            rate_limits: None,
        }
    }
}

/// Every running total a Codex parent rollout wrote, by its thread id, as the scan finds it: `None` when it is not on
/// disk. A fork's copies of its parent's counters repeat those totals.
#[derive(Clone, Default)]
pub struct Parents(Option<Arc<ParentTotals>>);
type ParentTotals = dyn Fn(&str) -> Option<Arc<HashSet<RawCounts>>> + Send + Sync;
impl Parents {
    pub fn new(totals: impl Fn(&str) -> Option<Arc<HashSet<RawCounts>>> + Send + Sync + 'static) -> Self {
        Self(Some(Arc::new(totals)))
    }
    fn totals(&self, thread: &str) -> Option<Arc<HashSet<RawCounts>>> {
        self.0.as_ref().and_then(|totals| totals(thread))
    }
}
impl std::fmt::Debug for Parents {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Parents")
    }
}
/// Where parents are found is not part of what a reader has read.
impl PartialEq for Parents {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

/// SHA-256 as lowercase hex, of event-id keys and checkpoint prefixes.
pub fn digest(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}
/// Short single-line metadata: non-empty, at most `limit` UTF-16 units, no control character.
pub fn is_metadata_text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= limit && !value.chars().any(|c| c < ' ')
}
pub(crate) fn object(value: Option<&Value>) -> Option<&Object> {
    value?.as_object()
}
/// `object?.key`.
pub(crate) fn field<'a>(object: Option<&'a Object>, key: &str) -> Option<&'a Value> {
    object?.get(key)
}
pub(crate) fn is(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}
pub(crate) fn text(value: Option<&Value>, limit: usize) -> Option<&str> {
    value?.as_str().filter(|value| is_metadata_text(value, limit))
}
pub(crate) fn counter(value: Option<&Value>, optional: bool) -> Counted<u64> {
    match value {
        None if optional => Ok(0),
        Some(value) if is_safe_count(value) => {
            Ok(value.as_u64().unwrap_or_else(|| value.as_f64().unwrap_or(0.0) as u64))
        }
        _ => Err(Invalid),
    }
}
/// A counter that may be absent or null in the source format.
pub(crate) fn optional(value: Option<&Value>) -> Counted<u64> {
    if value.is_some_and(Value::is_null) {
        Ok(0)
    } else {
        counter(value, true)
    }
}
pub(crate) fn safe_sum(values: &[u64]) -> Counted<u64> {
    checked_sum(values.iter().copied()).map_err(|_| Invalid)
}
/// `Number.isSafeInteger`, of either sign.
pub(crate) fn safe_integer(value: &Value) -> Option<i64> {
    let limit = MAX_SAFE_INTEGER as i64;
    match value.as_i64() {
        Some(n) => (-limit..=limit).contains(&n).then_some(n),
        None => value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && n.abs() <= limit as f64)
            .map(|n| n as i64),
    }
}
/// An ISO timestamp with a zone, normalised. Numbers, local dates and arbitrary strings are never read as UTC.
pub(crate) fn date(value: Option<&Value>) -> Option<String> {
    iso::parse(value?.as_str()?).map(iso::iso_string)
}
/// Epoch milliseconds, for formats that document them.
pub(crate) fn epoch(value: Option<&Value>) -> Option<String> {
    safe_integer(value?)
        .filter(|ms| *ms > 0 && *ms <= 8_640_000_000_000_000)
        .map(iso::iso_string)
}
/// A sibling JSON document: `Err` while it is being rewritten, `Ok(None)` when absent or not an object.
pub(crate) fn sibling(content: Option<&str>) -> Result<Option<Object>, ()> {
    match content.map(parse_json) {
        None => Ok(None),
        Some(None) => Err(()),
        Some(Some(value)) => Ok(into_object(value)),
    }
}
/// An object encoded as JSON inside a string field.
pub(crate) fn embedded(value: Option<&Value>) -> Option<Object> {
    into_object(parse_json(value?.as_str()?)?)
}
fn into_object(value: Value) -> Option<Object> {
    match value {
        Value::Object(object) => Some(object),
        _ => None,
    }
}
/// `JSON.parse`. JavaScript keeps a lone surrogate escape, which serde_json rejects; it becomes U+FFFD, the character
/// JavaScript writes for it in UTF-8, so a record that names one is still read and its ids digest the same.
pub(crate) fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok().or_else(|| {
        let repaired = replace_lone_surrogates(text)?;
        serde_json::from_str(&repaired).ok()
    })
}
fn replace_lone_surrogates(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let unit = |at: usize| {
        let hex = text
            .get(at + 2..at + 6)
            .filter(|_| bytes.get(at + 1) == Some(&b'u') && bytes[at] == b'\\')?;
        hex.bytes()
            .all(|b| b.is_ascii_hexdigit())
            .then(|| u16::from_str_radix(hex, 16).ok())
            .flatten()
    };
    let (mut repaired, mut copied, mut at, mut inside) = (String::new(), 0, 0, false);
    while at < bytes.len() {
        match bytes[at] {
            b'"' => inside = !inside,
            b'\\' if inside => match unit(at) {
                Some(0xD800..=0xDBFF) if matches!(unit(at + 6), Some(0xDC00..=0xDFFF)) => at += 11,
                Some(0xD800..=0xDFFF) => {
                    repaired.push_str(&text[copied..at]);
                    repaired.push_str("\\ufffd");
                    copied = at + 6;
                    at += 5;
                }
                _ => at += 1,
            },
            _ => {}
        }
        at += 1;
    }
    (copied > 0).then(|| repaired + &text[copied..])
}
/// `basename(path)`.
pub(crate) fn file_name(path: &Path) -> Cow<'_, str> {
    path.file_name()
        .map_or(Cow::Borrowed(""), |name| name.to_string_lossy())
}
/// `basename(dirname(path))`.
pub(crate) fn parent_name(path: &Path) -> Cow<'_, str> {
    path.parent().map_or(Cow::Borrowed(""), file_name)
}
/// A result with no events and one diagnostic.
pub(crate) fn only(code: &str) -> ParseResult {
    ParseResult {
        events: Vec::new(),
        diagnostics: vec![code.into()],
        withdrawn: None,
    }
}
/// Adds a diagnostic once, in first-seen order (a JavaScript `Set`).
pub(crate) fn note(diagnostics: &mut Vec<String>, code: &str) {
    if !diagnostics.iter().any(|seen| seen == code) {
        diagnostics.push(code.into());
    }
}
/// Keeps a record's event, or notes `invalid_counters` (the `try`/`catch` around each record).
pub(crate) fn keep(event: Counted<Option<UsageEvent>>, events: &mut Vec<UsageEvent>, diagnostics: &mut Vec<String>) {
    match event {
        Ok(event) => events.extend(event),
        Err(Invalid) => note(diagnostics, "invalid_counters"),
    }
}
/// Events by id in first-seen order, each holding its latest value (a JavaScript `Map`).
#[derive(Default)]
pub(crate) struct EventMap {
    events: Vec<UsageEvent>,
    index: HashMap<String, usize>,
}
impl EventMap {
    pub(crate) fn insert(&mut self, event: UsageEvent) {
        match self.index.get(&event.event_id) {
            Some(&at) => self.events[at] = event,
            None => {
                self.index.insert(event.event_id.clone(), self.events.len());
                self.events.push(event);
            }
        }
    }
    pub(crate) fn into_events(self) -> Vec<UsageEvent> {
        self.events
    }
}

/// `eventId`: the id of the event a tool records under `key`.
pub(crate) fn event_id(tool: ToolId, key: &str) -> String {
    format!("{}:{}", tool.id(), digest(key))
}
/// One event from disjoint counts (reasoning inside output), or `None` when nothing was used.
pub(crate) fn usage_event(
    tool: ToolId,
    key: &str,
    session_id: &str,
    project: Option<&str>,
    model: &str,
    occurred_at: Option<String>,
    tokens: TokenCounts,
) -> Counted<Option<UsageEvent>> {
    let event = usage_record(tool, key, session_id, project, model, occurred_at, tokens)?;
    Ok((tokentracky_core::total_tokens(&event.tokens) != 0).then_some(event))
}
/// A validated usage record, retaining zero as an authoritative correction for a mutable database row.
pub(crate) fn usage_record(
    tool: ToolId,
    key: &str,
    session_id: &str,
    project: Option<&str>,
    model: &str,
    occurred_at: Option<String>,
    tokens: TokenCounts,
) -> Counted<UsageEvent> {
    let TokenCounts {
        input,
        output,
        cache_read,
        cache_write,
        reasoning,
        cache_write_1h,
    } = tokens;
    let reasoning = reasoning.unwrap_or(0);
    if [input, output, cache_read, cache_write, reasoning]
        .iter()
        .any(|value| *value > MAX_SAFE_INTEGER)
        || reasoning > output
        || cache_write_1h.unwrap_or(0) > cache_write
    {
        return Err(Invalid);
    }
    safe_sum(&[input, output, cache_read, cache_write])?;
    Ok(UsageEvent {
        event_id: event_id(tool, key),
        claude_mirror_id: None,
        tool,
        model: model.into(),
        occurred_at,
        project: project.map(Into::into),
        session_id: session_id.into(),
        tokens,
        service_tier: None,
        cost_microusd: None,
        pricing_version: None,
    })
}
/// Gemini CLI stores one API request's usage on a `gemini` message. Prompt tokens include the cached part;
/// tool-use prompt tokens are input; thoughts are generated output. `total` is a check and never added.
pub(crate) fn gemini_event(message: &Object, session_id: &str) -> Counted<Option<UsageEvent>> {
    let (Some(tokens), Some(id)) = (object(message.get("tokens")), text(message.get("id"), 512)) else {
        return Ok(None);
    };
    if !is(message.get("type"), "gemini") {
        return Ok(None);
    }
    let cached = optional(tokens.get("cached"))?;
    let thoughts = optional(tokens.get("thoughts"))?;
    let input = safe_sum(&[
        counter(tokens.get("input"), false)?.saturating_sub(cached),
        optional(tokens.get("tool"))?,
    ])?;
    let output = safe_sum(&[counter(tokens.get("output"), false)?, thoughts])?;
    let model = text(message.get("model"), 256).unwrap_or("unknown");
    let tokens = TokenCounts {
        input,
        output,
        cache_read: cached,
        cache_write: 0,
        reasoning: Some(thoughts),
        cache_write_1h: None,
    };
    usage_event(
        ToolId::Gemini,
        &format!("{session_id}|{id}"),
        session_id,
        None,
        model,
        date(message.get("timestamp")),
        tokens,
    )
}
/// A legacy Gemini CLI `session-*.json` conversation, rewritten whole by older releases.
pub fn parse_gemini_session(document: &Value) -> ParseResult {
    let session = document.as_object();
    let messages = field(session, "messages").and_then(Value::as_array);
    let (Some(session_id), Some(messages)) = (text(field(session, "sessionId"), 512), messages) else {
        return only("missing_stable_identity");
    };
    let (mut events, mut diagnostics) = (Vec::new(), Vec::new());
    for message in messages {
        keep(
            message
                .as_object()
                .map_or(Ok(None), |message| gemini_event(message, session_id)),
            &mut events,
            &mut diagnostics,
        );
    }
    ParseResult {
        events,
        diagnostics,
        withdrawn: None,
    }
}

fn normalize(raw: RawCounts, inclusive: bool) -> Counted<TokenCounts> {
    // Codex input includes its cache reads and writes; Claude Code's does not.
    let cache = if inclusive {
        safe_sum(&[raw.cached, raw.write])?
    } else {
        0
    };
    if cache > raw.input || raw.reasoning > raw.output {
        return Err(Invalid);
    }
    let input = raw.input - cache;
    safe_sum(&[input, raw.output, raw.cached, raw.write])?;
    Ok(TokenCounts {
        input,
        output: raw.output,
        cache_read: raw.cached,
        cache_write: raw.write,
        reasoning: Some(raw.reasoning),
        cache_write_1h: None,
    })
}
fn codex_counts(_tool: ToolId, value: Option<&Value>) -> Counted<Option<RawCounts>> {
    let Some(usage) = object(value) else { return Ok(None) };
    let input = counter(usage.get("input_tokens"), false)?;
    let counts = RawCounts {
        input,
        cached: counter(usage.get("cached_input_tokens"), true)?,
        write: counter(
            usage
                .get("cache_creation_input_tokens")
                .or_else(|| usage.get("cache_write_input_tokens")),
            true,
        )?,
        output: counter(usage.get("output_tokens"), false)?,
        reasoning: counter(usage.get("reasoning_output_tokens"), true)?,
    };
    if let Some(total) = usage.get("total_tokens") {
        counter(Some(total), false)?;
    }
    normalize(counts, true)?;
    Ok(Some(counts))
}
/// Length limit of a Codex service tier such as `priority`.
pub(crate) const SERVICE_TIER_LIMIT: usize = 32;
/// Copies of a parent's counters arrive 0–40 ms apart; a child's own first request comes seconds later (t3code).
const FORK_COPY_GAP_MS: i64 = 1000;

/// The plan's own limit; Codex gives each metered model's limit another id (`codex_<model>`).
const PLAN_LIMIT: &str = "codex";
/// `TimeClip`: the largest distance from the epoch a JavaScript date can hold.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

/// The snapshot a `token_count` record carries, as openai/codex 970111f writes it (`codex-rs/protocol/src/protocol.rs`:
/// `TokenCountEvent.rate_limits` at line 2497, `RateLimitSnapshot` at 2501, `RateLimitWindow` at 2544): `limit_id`
/// (absent before multi-limit releases), and `primary` and `secondary` windows of `used_percent` (0–100),
/// `window_minutes` and `resets_at` in epoch seconds. Some releases before 0.50 (0.45 among them) wrote
/// `resets_in_seconds` from the record's time instead; 0.40's flat percentages have no window object and no reset, so
/// they are not read. Credits, plan type and limit names are never kept. `None` without the record's time, for another
/// limit, or with no usable window.
fn rate_limits(snapshot: Option<&Value>, at_ms: Option<i64>) -> Option<RateLimits> {
    let (snapshot, at_ms) = (object(snapshot)?, at_ms.filter(|at| *at > 0)?);
    if !snapshot
        .get("limit_id")
        .is_none_or(|id| id.is_null() || id.as_str() == Some(PLAN_LIMIT))
    {
        return None;
    }
    let window = |key: &str| {
        let window = object(snapshot.get(key))?;
        let used = window.get("used_percent")?.as_f64().filter(|used| *used >= 0.0)?;
        let minutes = window.get("window_minutes").and_then(safe_integer);
        let resets_at_ms = match window.get("resets_at").and_then(safe_integer) {
            Some(seconds) => seconds.checked_mul(1000),
            None => window
                .get("resets_in_seconds")
                .and_then(safe_integer)
                .filter(|seconds| *seconds >= 0)
                .and_then(|seconds| at_ms.checked_add(seconds.checked_mul(1000)?)),
        };
        Some(RateWindow {
            used_percent: used.min(100.0),
            window_minutes: minutes.filter(|minutes| *minutes > 0).map(|minutes| minutes as u64),
            resets_at_ms: resets_at_ms.filter(|at| (1..=MAX_TIME_MS).contains(at)),
        })
    };
    let (primary, secondary) = (window("primary"), window("secondary"));
    (primary.is_some() || secondary.is_some()).then_some(RateLimits {
        at_ms,
        primary,
        secondary,
    })
}

/// The parent thread of a subagent spawned by it, or of a rollout forked from it (`forked_from_id`).
fn fork_parent(payload: Option<&Object>) -> Option<&str> {
    let spawn = ["source", "subagent", "thread_spawn"]
        .into_iter()
        .fold(payload, |at, key| object(field(at, key)));
    text(field(spawn, "parent_thread_id"), 512).or_else(|| text(field(payload, "forked_from_id"), 512))
}
fn push_bounded<T>(list: &mut Vec<T>, value: T, limit: usize) {
    list.push(value);
    if list.len() > limit {
        list.remove(0);
    }
}

/// Parses one complete line (without its newline). State contains only allowlisted usage metadata, never raw records.
pub fn parse_usage_line(tool: ToolId, line: &str, source_path: &Path, state: &mut ParserState) -> ParseResult {
    let reader = super::adapter(tool).and_then(|adapter| adapter.line);
    if !LINE_TOOLS.contains(&tool) && reader.is_none() {
        return only("unsupported_source");
    }
    if line.chars().all(is_js_space) {
        return ParseResult::default();
    }
    if line.len() > line_limit(tool) {
        let mut usage = MayHoldUsage::new(tool);
        usage.feed(line.as_bytes());
        return if usage.take() {
            only("record_too_large")
        } else {
            ParseResult::default()
        };
    }
    let Some(record) = parse_json(line) else {
        return only("malformed_json");
    };
    let Value::Object(record) = record else {
        return only("invalid_record");
    };
    let mut diagnostics = Vec::new();
    let events = match (tool, reader) {
        (_, Some(read)) => read(&record, source_path, state, &mut diagnostics).map(Vec::from_iter),
        (ToolId::Grok, _) => super::grok::turn(&record, source_path, &mut diagnostics),
        (ToolId::Gemini, _) => gemini_line(&record, state, &mut diagnostics).map(Vec::from_iter),
        (ToolId::Claude, _) => claude_line(&record, source_path, state, &mut diagnostics).map(Vec::from_iter),
        _ => codex_line(tool, &record, state, &mut diagnostics).map(Vec::from_iter),
    };
    match events {
        Ok(events) => ParseResult {
            events,
            diagnostics,
            withdrawn: None,
        },
        Err(Invalid) => only("invalid_counters"),
    }
}
/// Metadata comes first; a message is re-appended whole whenever it changes. `$set`, `$rewindTo` and `$patch` lines
/// are ignored, so usage once recorded stays counted.
fn gemini_line(record: &Object, state: &mut ParserState, diagnostics: &mut Vec<String>) -> Counted<Option<UsageEvent>> {
    if !record.contains_key("id") && !record.contains_key("type") {
        if state.session_id.is_none() {
            state.session_id = text(record.get("sessionId"), 512).map(Into::into);
        }
        return Ok(None);
    }
    if !is(record.get("type"), "gemini") || object(record.get("tokens")).is_none() {
        return Ok(None);
    }
    match state.session_id.as_deref() {
        Some(session_id) if text(record.get("id"), 512).is_some() => gemini_event(record, session_id),
        _ => {
            diagnostics.push("missing_stable_identity".into());
            Ok(None)
        }
    }
}
fn claude_line(
    record: &Object,
    source_path: &Path,
    state: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    let session = text(record.get("sessionId"), 512);
    if let Some(session) = session {
        state.session_id = Some(session.into());
    }
    if let Some(project) = text(record.get("cwd"), TEXT_LIMIT) {
        state.project = Some(project.into());
    }
    if !is(record.get("type"), "assistant") {
        return Ok(None);
    }
    let message = object(record.get("message"));
    let Some(usage) = object(field(message, "usage")) else {
        return Ok(None);
    };
    // UUID file names are a format fallback, never the directory-derived project encoding.
    let session_id = session
        .map(Into::into)
        .or_else(|| state.session_id.clone())
        .or_else(|| file_session(source_path));
    let request = text(field(message, "id"), 512).or_else(|| text(record.get("requestId"), 512));
    let (Some(session_id), Some(request)) = (session_id, request) else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let cache = object(usage.get("cache_creation"));
    let write = match (usage.get("cache_creation_input_tokens"), cache) {
        (None, Some(cache)) => safe_sum(&[
            counter(cache.get("ephemeral_5m_input_tokens"), true)?,
            counter(cache.get("ephemeral_1h_input_tokens"), true)?,
        ])?,
        (total, _) => counter(total, true)?,
    };
    // The one-hour part of the writes, priced at its own rate. Informational: a bad value never rejects the record.
    let one_hour = object(usage.get("cache_creation"))
        .and_then(|cache| counter(cache.get("ephemeral_1h_input_tokens"), false).ok())
        .map(|hours| hours.min(write))
        .filter(|hours| *hours > 0);
    let output = counter(usage.get("output_tokens"), false)?;
    // Reasoning is informational and already inside output: `thinking_tokens` wins over `reasoning_tokens`, the count
    // is capped at output, and a bad value is read as none rather than dropping the record's usage.
    let details = object(usage.get("output_tokens_details"));
    let reasoning = ["thinking_tokens", "reasoning_tokens"]
        .into_iter()
        .find_map(|name| field(details, name).filter(|value| !value.is_null()))
        .and_then(|value| counter(Some(value), false).ok())
        .map_or(0, |reasoning| reasoning.min(output));
    let raw = RawCounts {
        input: counter(usage.get("input_tokens"), false)?,
        output,
        cached: counter(usage.get("cache_read_input_tokens"), true)?,
        write,
        reasoning,
    };
    Ok(Some(UsageEvent {
        event_id: format!("claude:{}", digest(request)),
        claude_mirror_id: None,
        tool: ToolId::Claude,
        model: text(field(message, "model"), 256).unwrap_or("unknown").into(),
        occurred_at: date(record.get("timestamp")),
        project: state.project.clone(),
        session_id,
        tokens: TokenCounts {
            cache_write_1h: one_hour,
            ..normalize(raw, false)?
        },
        service_tier: None,
        cost_microusd: None,
        pricing_version: None,
    }))
}
/// The session a UUID file name gives: `<8 hex>-<27 or more hex or dashes>.jsonl`, in any case.
fn file_session(path: &Path) -> Option<String> {
    let path = path.to_string_lossy();
    let name = path.rsplit(['/', '\\']).next()?;
    let stem = name.get(..name.len().checked_sub(".jsonl".len())?)?;
    let id = stem.as_bytes();
    let matches = name[stem.len()..].eq_ignore_ascii_case(".jsonl")
        && id.len() >= 36
        && id[..8].iter().all(u8::is_ascii_hexdigit)
        && id[8] == b'-'
        && id[9..].iter().all(|b| b.is_ascii_hexdigit() || *b == b'-');
    matches.then(|| stem.into())
}
/// The running total a Codex token count records, for a fork's parent; `None` for any other line.
pub(crate) fn codex_total(tool: ToolId, line: &str) -> Option<RawCounts> {
    let record: Value = serde_json::from_str(line).ok()?;
    let record = record.as_object()?;
    let fork_event = tool == ToolId::EveryCode && is(record.get("type"), "event");
    if !is(record.get("type"), "event_msg") && !fork_event {
        return None;
    }
    let payload = object(record.get("payload"));
    let body = if is(field(payload, "type"), "token_count") {
        payload
    } else {
        object(field(payload, "msg"))
    };
    if !is(field(body, "type"), "token_count") {
        return None;
    }
    codex_counts(tool, object(field(body, "info"))?.get("total_token_usage"))
        .ok()
        .flatten()
}
/// A Codex rollout record, also of Every Code (`tool`), a Codex fork whose event ids take its own prefix.
pub(crate) fn codex_line(
    tool: ToolId,
    record: &Object,
    state: &mut ParserState,
    diagnostics: &mut Vec<String>,
) -> Counted<Option<UsageEvent>> {
    let payload = object(record.get("payload"));
    if is(record.get("type"), "session_meta") {
        // Later replayed metadata must not replace the rollout's own session identity.
        if state.session_id.is_none() {
            state.session_id = text(field(payload, "id"), 512).map(Into::into);
            if let Some(parent) = fork_parent(payload) {
                state.fork_copy_at = record.get("timestamp").and_then(Value::as_str).and_then(iso::parse);
                state.fork_parent = Some(parent.into());
            }
        }
        if state.project.is_none() {
            state.project = text(field(payload, "cwd"), TEXT_LIMIT).map(Into::into);
        }
        if let Some(model) = text(field(payload, "model"), 256) {
            state.model = model.into();
        }
        return Ok(None);
    }
    if is(record.get("type"), "turn_context") {
        if let Some(model) = text(field(payload, "model"), 256) {
            state.model = model.into();
        }
        if let Some(project) = text(field(payload, "cwd"), TEXT_LIMIT) {
            state.project = Some(project.into());
        }
        if let Some(turn) = text(field(payload, "turn_id"), 512) {
            state.turn_id = Some(turn.into());
        }
        return Ok(None);
    }
    // Every Code records its events with their sequence numbers as `event`, `msg` holding the token count.
    let fork_event = tool == ToolId::EveryCode && is(record.get("type"), "event");
    if !is(record.get("type"), "event_msg") && !fork_event {
        return Ok(None);
    }
    // The tier applies to the token counts that follow, until the next settings record. Only Fast is priced apart;
    // any other or missing tier is unknown and charged Standard.
    if is(field(payload, "type"), "thread_settings_applied") {
        let tier = field(object(field(payload, "thread_settings")), "service_tier");
        state.service_tier = (is(tier, "priority") || is(tier, "fast")).then(|| "priority".into());
        return Ok(None);
    }
    // Codex writes the tier before the turn it applies to; requests before any such record stay unknown.
    if is(field(payload, "type"), "thread_settings_applied") {
        let settings = object(field(payload, "thread_settings"));
        state.service_tier = text(field(settings, "service_tier"), SERVICE_TIER_LIMIT)
            .map(|tier| tier.trim().to_lowercase())
            .filter(|tier| !tier.is_empty());
        return Ok(None);
    }
    let body = if is(field(payload, "type"), "token_count") {
        payload
    } else {
        object(field(payload, "msg"))
    };
    if !is(field(body, "type"), "token_count") {
        return Ok(None);
    }
    let at = record.get("timestamp").and_then(Value::as_str).and_then(iso::parse);
    if let Some(limits) = rate_limits(field(body, "rate_limits"), at) {
        state.rate_limits = Some(limits);
    }
    // Rate limit notifications have null info.
    let Some(info) = object(field(body, "info")) else {
        return Ok(None);
    };
    let Some(session_id) = state.session_id.clone() else {
        diagnostics.push("missing_stable_identity".into());
        return Ok(None);
    };
    let total = codex_counts(tool, info.get("total_token_usage"))?;
    let last = codex_counts(tool, info.get("last_token_usage"))?;
    if total.is_none() && last.is_none() {
        diagnostics.push("missing_usage".into());
        return Ok(None);
    }
    // Requests stamped at the same instant (a subagent can stamp every one with the instant it was spawned) are told
    // apart by their running totals.
    let same_instant = at.is_some() && at == state.counted_at;
    state.counted_at = at;
    // Copied parent counters: already counted in the parent, but this rollout's baseline. A copy repeats a running
    // total the parent's rollout wrote; without the parent on disk, copies come within a second of each other.
    if let Some(copied_at) = state.fork_copy_at {
        let parent = state
            .fork_parent
            .as_deref()
            .and_then(|parent| state.parents.totals(parent));
        let copied = match parent {
            Some(parent) => total.is_some_and(|total| parent.contains(&total)),
            None => at.is_some_and(|at| at - copied_at < FORK_COPY_GAP_MS),
        };
        if copied {
            state.fork_copy_at = Some(at.unwrap_or(copied_at));
            if let Some(total) = total {
                state.previous = Some(total);
                push_bounded(&mut state.baselines, total, 64);
            }
            return Ok(None);
        }
        state.fork_copy_at = None;
        state.fork_parent = None;
    }
    let occurred_at = date(record.get("timestamp"));
    let explicit = text(field(body, "request_id"), 512).or_else(|| text(info.get("request_id"), 512));
    // `JSON.stringify(total)`.
    let running = |t: RawCounts| {
        format!(
            r#"{{"input":{},"cached":{},"write":{},"output":{},"reasoning":{}}}"#,
            t.input, t.cached, t.write, t.output, t.reasoning
        )
    };
    let turn = state.turn_id.as_deref().unwrap_or("");
    let identity = match (explicit, &occurred_at, total) {
        (Some(id), _, _) => id.to_owned(),
        (None, Some(at), Some(t)) if same_instant => format!("{turn}:{at}:{}", running(t)),
        (None, Some(at), _) => format!("{turn}:{at}"),
        (None, None, Some(t)) => running(t),
        (None, None, None) => {
            diagnostics.push("missing_stable_identity".into());
            return Ok(None);
        }
    };
    let event_id = event_id(tool, &format!("{session_id}:{identity}"));
    if total.is_none() && state.seen_delta_ids.contains(&event_id) {
        return Ok(None);
    }
    let mut delta = last.or(total).unwrap_or_default();
    if let Some(total) = total {
        if state.baselines.contains(&total) {
            return Ok(None);
        }
        // A previous cumulative baseline provides history, even when last_token_usage
        // contains only the final request since the last notification.
        let mut reset = false;
        delta = match state.previous {
            Some(previous) => total.minus(previous).unwrap_or_else(|| {
                reset = true;
                last.unwrap_or(total)
            }),
            // A continuation inherits its parent's total without a copied snapshot: count the latest request.
            None => match last {
                Some(last) if total.minus(last).is_some() => last,
                _ => total,
            },
        };
        // Prefer a matching known lineage over an unrelated interleaved baseline. A restart or a context-size marker
        // has a zero parent.
        let mut known = false;
        if let Some(last) = last
            && let Some(parent) = total.minus(last)
            && (state.baselines.contains(&parent) || parent.is_zero())
        {
            delta = last;
            known = true;
        }
        if reset && !known {
            diagnostics.push("cumulative_reset_or_branch".into());
        }
        normalize(delta, true)?;
        state.previous = Some(total);
        push_bounded(&mut state.baselines, total, 64);
    } else if let Some(last) = last {
        let previous = match state.previous {
            Some(previous) => RawCounts {
                input: safe_sum(&[previous.input, last.input])?,
                cached: safe_sum(&[previous.cached, last.cached])?,
                write: safe_sum(&[previous.write, last.write])?,
                output: safe_sum(&[previous.output, last.output])?,
                reasoning: safe_sum(&[previous.reasoning, last.reasoning])?,
            },
            None => last,
        };
        state.previous = Some(previous);
        push_bounded(&mut state.baselines, previous, 64);
        push_bounded(&mut state.seen_delta_ids, event_id.clone(), 256);
    }
    if delta.is_zero() {
        return Ok(None);
    }
    // Every Code names the model that answered and the one requested on the token count itself.
    let model = text(info.get("model"), 256).or_else(|| {
        let fork = (tool == ToolId::EveryCode).then_some(info);
        text(field(fork, "latest_response_model"), 256).or_else(|| text(field(fork, "requested_model"), 256))
    });
    Ok(Some(UsageEvent {
        event_id,
        claude_mirror_id: None,
        tool,
        model: model.map_or_else(|| state.model.clone(), Into::into),
        occurred_at,
        project: state.project.clone(),
        session_id,
        tokens: normalize(delta, true)?,
        service_tier: state.service_tier.clone(),
        cost_microusd: None,
        pricing_version: None,
    }))
}

/// Pure parser. Unlike the streaming importer, a valid final line needs no newline.
pub fn parse_usage_file(tool: ToolId, content: &str, source_path: &Path) -> ParseResult {
    if !LINE_TOOLS.contains(&tool) && super::adapter(tool).and_then(|adapter| adapter.line).is_none() {
        return only("unsupported_source");
    }
    let (mut state, mut events, mut diagnostics) = (ParserState::default(), EventMap::default(), Vec::new());
    for line in content.split('\n') {
        let result = parse_usage_line(tool, line, source_path, &mut state);
        result.events.into_iter().for_each(|event| events.insert(event));
        result.diagnostics.iter().for_each(|code| note(&mut diagnostics, code));
    }
    ParseResult {
        events: events.into_events(),
        diagnostics,
        withdrawn: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_a_usage_key_split_between_the_pieces_of_a_long_line() {
        let mut usage = MayHoldUsage::new(ToolId::Codex);
        for piece in [
            &b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"token"[..],
            b"_co",
            b"unt\"}}",
        ] {
            usage.feed(piece);
        }
        assert!(usage.take());
        // Escaped inside text, the key cannot match; and each line starts afresh.
        usage.feed(br#"{"type":"event_msg","payload":{"text":"\"token_count\""}}"#);
        assert!(!usage.take());
        let mut any = MayHoldUsage::new(ToolId::Gemini);
        assert!(any.take(), "a tool without a usage key reports every long line");
    }

    #[test]
    fn reads_lone_surrogates_as_javascript_does() {
        let line = r#"{"type":"assistant","sessionId":"s\ud800","message":{"id":"m\udc00\\ud800","usage":{"input_tokens":1,"output_tokens":2}}}"#;
        let result = parse_usage_line(ToolId::Claude, line, Path::new("x.jsonl"), &mut ParserState::default());
        assert_eq!(result.diagnostics, Vec::<String>::new());
        assert_eq!(result.events[0].session_id, "s\u{fffd}");
        assert_eq!(
            result.events[0].event_id,
            format!("claude:{}", digest("m\u{fffd}\\ud800"))
        );
        assert_eq!(parse_json(r#""😀""#), Some(json!("\u{1f600}")));
        assert_eq!(parse_json(r#"{"a":"\ud800"#), None);
    }
    #[test]
    fn reads_claude_reasoning_as_informational_and_never_drops_the_usage() {
        // Reasoning counter precedence: `thinking_tokens` wins even at zero, the count is capped at output, and a
        // bad value is read as none. Usage and totals are the same in every case.
        for (details, reasoning) in [
            (json!({"thinking_tokens": 163}), 163),
            (json!({"reasoning_tokens": 163}), 163),
            (json!({"thinking_tokens": 0, "reasoning_tokens": 163}), 0),
            (json!({"thinking_tokens": null, "reasoning_tokens": 163}), 163),
            (json!({"thinking_tokens": 0}), 0),
            (Value::Null, 0),
            (json!({}), 0),
            (json!({"thinking_tokens": -1}), 0),
            (json!({"thinking_tokens": "invalid"}), 0),
            (json!({"thinking_tokens": 9999}), 518),
        ] {
            let line = json!({"type": "assistant", "sessionId": "s", "timestamp": "2026-09-07T03:00:00Z",
                "message": {"id": "m", "model": "claude-sonnet-4-6", "usage": {"input_tokens": 420,
                "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20, "output_tokens": 518,
                "output_tokens_details": details}}});
            let result = parse_usage_line(
                ToolId::Claude,
                &line.to_string(),
                Path::new("x.jsonl"),
                &mut ParserState::default(),
            );
            assert_eq!(result.diagnostics, Vec::<String>::new(), "{details}");
            let tokens = &result.events[0].tokens;
            assert_eq!((tokens.reasoning, tokens.output), (Some(reasoning), 518), "{details}");
            assert_eq!(tokentracky_core::total_tokens(tokens), 1058, "{details}");
        }
    }
    #[test]
    fn trims_and_measures_text_as_javascript_does() {
        let mut state = ParserState::default();
        assert_eq!(
            parse_usage_line(ToolId::Codex, "\u{feff} \u{2028}", Path::new(""), &mut state),
            ParseResult::default()
        );
        assert_eq!(
            parse_usage_line(ToolId::Codex, "\u{85}", Path::new(""), &mut state).diagnostics,
            ["malformed_json"]
        );
        assert!(is_metadata_text(&"\u{1f600}".repeat(2), 4) && !is_metadata_text(&"\u{1f600}".repeat(3), 5));
        assert!(!is_metadata_text("a\u{1f}", 10) && is_metadata_text("a\u{7f}", 10));
    }
    #[test]
    fn reads_counters_and_epochs_like_number_is_safe_integer() {
        let value = |text: &str| serde_json::from_str::<Value>(text).unwrap();
        assert!(matches!(counter(Some(&value("1.0")), false), Ok(1)));
        for text in ["-1", "1.5", "9007199254740992", "\"1\"", "null"] {
            assert!(counter(Some(&value(text)), true).is_err(), "{text}");
        }
        assert!(matches!(optional(Some(&Value::Null)), Ok(0)) && matches!(optional(None), Ok(0)));
        assert!(counter(None, false).is_err());
        assert_eq!(
            epoch(Some(&value("1792746000000.0"))).as_deref(),
            Some("2026-10-23T09:00:00.000Z")
        );
        assert_eq!(epoch(Some(&value("0"))), None);
        assert_eq!(epoch(Some(&value("8640000000000001"))), None);
    }
    #[test]
    fn keeps_the_diagnostic_only_for_an_unresolved_codex_branch() {
        let count = |last: u64, total: u64| {
            format!(
                r#"{{"timestamp":"2026-10-20T12:00:0{}.000Z","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":{last},"output_tokens":0}},"total_token_usage":{{"input_tokens":{total},"output_tokens":0}}}}}}}}"#,
                total % 10
            )
        };
        let mut state = ParserState::default();
        let path = Path::new("rollout.jsonl");
        parse_usage_line(
            ToolId::Codex,
            r#"{"type":"session_meta","payload":{"id":"s"}}"#,
            path,
            &mut state,
        );
        assert!(
            parse_usage_line(ToolId::Codex, &count(100, 100), path, &mut state)
                .diagnostics
                .is_empty()
        );
        // Restart: the total restarts at this request.
        assert!(
            parse_usage_line(ToolId::Codex, &count(31, 31), path, &mut state)
                .diagnostics
                .is_empty()
        );
        // Branch from nothing known: the total fell from 31 to 22, and 22 − 20 = 2 was never a total.
        let branch = parse_usage_line(ToolId::Codex, &count(20, 22), path, &mut state);
        assert_eq!(branch.diagnostics, ["cumulative_reset_or_branch"]);
    }
    /// A `token_count` record with the given `info` and `rate_limits` JSON.
    fn token_count(minute: u8, info: &str, limits: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-10-20T10:0{minute}:00.000Z","type":"event_msg","payload":{{"type":"token_count","info":{info},"rate_limits":{limits}}}}}"#
        )
    }
    /// Usage with output a tenth of input, as cumulative Codex records log it.
    fn usage(last: u64, total: u64) -> String {
        format!(
            r#"{{"last_token_usage":{{"input_tokens":{last},"output_tokens":{}}},"total_token_usage":{{"input_tokens":{total},"output_tokens":{}}}}}"#,
            last / 10,
            total / 10
        )
    }
    fn windows(primary: f64, secondary: f64) -> String {
        format!(
            r#"{{"used_percent":{primary},"window_minutes":300,"resets_at":1792504800}},"secondary":{{"used_percent":{secondary},"window_minutes":10080,"resets_at":1792972800}}"#
        )
    }
    fn window(used_percent: f64, window_minutes: u64, resets_at_ms: i64) -> Option<RateWindow> {
        Some(RateWindow {
            used_percent,
            window_minutes: Some(window_minutes),
            resets_at_ms: Some(resets_at_ms),
        })
    }
    /// Runs `lines` after a session's metadata: the events, diagnostics and final state.
    fn codex(lines: &[String]) -> (Vec<UsageEvent>, Vec<String>, ParserState) {
        let mut state = ParserState::default();
        let path = Path::new("rollout.jsonl");
        let meta = r#"{"type":"session_meta","payload":{"id":"s"}}"#;
        let (mut events, mut diagnostics) = (Vec::new(), Vec::new());
        for line in std::iter::once(meta).chain(lines.iter().map(String::as_str)) {
            let result = parse_usage_line(ToolId::Codex, line, path, &mut state);
            events.extend(result.events);
            diagnostics.extend(result.diagnostics);
        }
        (events, diagnostics, state)
    }
    #[test]
    fn keeps_the_plans_latest_codex_rate_limit_snapshot_without_changing_usage() {
        let other =
            r#"{"limit_id":"codex_other","primary":{"used_percent":90,"window_minutes":300,"resets_at":1792504800}}"#;
        let lines = [
            token_count(
                1,
                &usage(100, 100),
                &format!(
                    r#"{{"limit_id":"codex","limit_name":"PRIVATE_NAME","primary":{},"credits":{{"balance":"PRIVATE_BALANCE"}},"plan_type":"plus"}}"#,
                    windows(10.0, 2.0)
                ),
            ),
            // A rate-limit notification: null info.
            token_count(
                2,
                "null",
                &format!(r#"{{"limit_id":"codex","primary":{}}}"#, windows(12.5, 2.5)),
            ),
            // Another limit family (a metered model's own) is not the plan's windows.
            token_count(3, &usage(200, 300), other),
            // Older Codex writes no limit id; the snapshot may also sit under `msg`.
            format!(
                r#"{{"timestamp":"2026-10-20T10:04:00.000Z","type":"event_msg","payload":{{"msg":{{"type":"token_count","info":null,"rate_limits":{{"primary":{}}}}}}}}}"#,
                windows(20.0, 3.5)
            ),
        ];
        let (events, diagnostics, state) = codex(&lines);
        let expected = RateLimits {
            at_ms: 1_792_490_640_000,
            primary: window(20.0, 300, 1_792_504_800_000),
            secondary: window(3.5, 10_080, 1_792_972_800_000),
        };
        assert_eq!(state.rate_limits, Some(expected));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        // The same records without their snapshots give the same usage.
        let bare: Vec<String> = [(1, usage(100, 100)), (2, "null".to_owned()), (3, usage(200, 300))]
            .iter()
            .map(|(minute, info)| token_count(*minute, info, "null"))
            .collect();
        let (bare_events, ..) = codex(&bare);
        assert_eq!(events, bare_events);
        assert_eq!(
            events
                .iter()
                .map(|e| tokentracky_core::total_tokens(&e.tokens))
                .sum::<u64>(),
            330
        );
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("PRIVATE_") && !json.contains("plus"), "{json}");
    }
    #[test]
    fn reads_codex_reset_times_and_bounds_each_window() {
        let snapshot = |limits: &str| codex(&[token_count(1, "null", limits)]).2.rate_limits;
        // Codex 0.45 wrote `resets_in_seconds`, from the record's time.
        assert_eq!(
            snapshot(
                r#"{"primary":{"used_percent":100.5,"window_minutes":300,"resets_in_seconds":3600},"secondary":{"used_percent":-1,"window_minutes":10080}}"#
            ),
            Some(RateLimits {
                at_ms: 1_792_490_460_000,
                primary: window(100.0, 300, 1_792_494_060_000),
                secondary: None,
            })
        );
        assert_eq!(
            snapshot(r#"{"primary":{"used_percent":0,"window_minutes":0,"resets_at":null}}"#),
            Some(RateLimits {
                at_ms: 1_792_490_460_000,
                primary: Some(RateWindow {
                    used_percent: 0.0,
                    window_minutes: None,
                    resets_at_ms: None
                }),
                secondary: None,
            })
        );
        // Times outside a JavaScript date's range are dropped.
        assert_eq!(
            snapshot(r#"{"primary":{"used_percent":1,"resets_at":8640000000001}}"#).and_then(|limits| limits.primary),
            Some(RateWindow {
                used_percent: 1.0,
                window_minutes: None,
                resets_at_ms: None
            })
        );
        // Codex 0.40's flat percentages carry no window object; nothing else is a snapshot either.
        for limits in [
            r#"{"primary_used_percent":10,"secondary_used_percent":2,"primary_window_minutes":300}"#,
            r#"{"primary":{"used_percent":"10"},"secondary":null}"#,
            r#"{"primary":{"window_minutes":300}}"#,
            r#"{"limit_id":"codex_other","primary":{"used_percent":1}}"#,
            "[]",
            "null",
        ] {
            assert_eq!(snapshot(limits), None, "{limits}");
        }
        // A snapshot needs its record's time.
        let undated = r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":1}}}}"#;
        assert_eq!(codex(&[undated.to_owned()]).2.rate_limits, None);
    }
    #[test]
    fn keeps_parser_state_json_in_the_typescript_shape() {
        let mut state = ParserState::default();
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({"sessionId": null, "project": null, "model": "unknown", "turnId": null, "previous": null, "baselines": [], "seenDeltaIds": []})
        );
        state.previous = Some(RawCounts {
            input: 5,
            cached: 1,
            write: 0,
            output: 2,
            reasoning: 1,
        });
        state.baselines.push(RawCounts::default());
        state.seen_delta_ids.push("codex:x".into());
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains(r#""previous":{"input":5,"cached":1,"write":0,"output":2,"reasoning":1}"#));
        assert_eq!(serde_json::from_str::<ParserState>(&json).unwrap(), state);
        state.rate_limits = Some(RateLimits {
            at_ms: 1,
            primary: window(12.5, 300, 2),
            secondary: None,
        });
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(
            json["rateLimits"],
            json!({"atMs": 1, "primary": {"usedPercent": 12.5, "windowMinutes": 300, "resetsAtMs": 2}})
        );
        assert_eq!(serde_json::from_value::<ParserState>(json).unwrap(), state);
    }
}
