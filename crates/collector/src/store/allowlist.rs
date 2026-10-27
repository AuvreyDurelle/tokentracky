//! The store's metadata boundary: only allowlisted, bounded fields of events and checkpoints are persisted.
use super::{FileCheckpoint, StoreError};
use crate::limits::{LimitReading, LimitWindow, window_names};
use serde_json::{Map, Value, json};
use tokentracky_core::{MAX_SAFE_INTEGER, UsageEvent, checked_sum, is_safe_count};

/// Non-empty text of at most `limit` UTF-16 units without control characters (`isMetadataText`).
pub(super) fn is_metadata_text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= limit && !value.chars().any(|c| u32::from(c) < 32)
}

/// The first `units` UTF-16 units, as JavaScript's `slice(0, units)`, without splitting a character.
pub(super) fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, c) in value.char_indices() {
        count += c.len_utf16();
        if count > units {
            return &value[..index];
        }
    }
    value
}

/// Milliseconds since the epoch, for the ISO forms `Date.parse` accepts: `YYYY[-MM[-DD]]` or `±YYYYYY…`, then
/// optionally `T` (or `t`, or a space) `HH:mm[:ss[.s…]]` and `Z`, `±HH:mm` or `±HHmm`. As in V8, a day up to 31
/// rolls into the next month and `24:00` is the next midnight. V8's non-ISO fallback formats are not accepted, and
/// a time without an offset is read as UTC where V8 uses the local zone.
pub(super) fn timestamp_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    let mut at = 0;
    let year = match bytes.first()? {
        sign @ (b'+' | b'-') => {
            at = 1;
            let year = digits(bytes, &mut at, 6)?;
            match sign {
                b'-' if year == 0 => return None,
                b'-' => -year,
                _ => year,
            }
        }
        _ => digits(bytes, &mut at, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if skip(bytes, &mut at, b'-') {
        month = digits(bytes, &mut at, 2)?;
        if skip(bytes, &mut at, b'-') {
            day = digits(bytes, &mut at, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut time, mut offset) = (0, 0);
    if matches!(bytes.get(at), Some(b'T' | b't' | b' ')) {
        at += 1;
        let hour = digits(bytes, &mut at, 2)?;
        skip(bytes, &mut at, b':').then_some(())?;
        let minute = digits(bytes, &mut at, 2)?;
        let (mut second, mut millis) = (0, 0);
        if skip(bytes, &mut at, b':') {
            second = digits(bytes, &mut at, 2)?;
            if skip(bytes, &mut at, b'.') {
                let count = bytes[at..].iter().take_while(|c| c.is_ascii_digit()).count();
                // V8 keeps milliseconds and drops any further digits.
                let kept = count.min(3);
                millis = digits(bytes, &mut at, kept)? * 10_i64.pow(3 - kept as u32);
                at += count - kept;
                (count > 0).then_some(())?;
            }
        }
        if hour > 24 || minute > 59 || second > 59 || (hour == 24 && minute + second + millis > 0) {
            return None;
        }
        time = ((hour * 60 + minute) * 60 + second) * 1000 + millis;
        match bytes.get(at).copied() {
            Some(b'Z' | b'z') => at += 1,
            Some(sign @ (b'+' | b'-')) => {
                at += 1;
                let hours = digits(bytes, &mut at, 2)?;
                skip(bytes, &mut at, b':');
                let minutes = digits(bytes, &mut at, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                offset = if sign == b'-' { -1 } else { 1 } * (hours * 60 + minutes) * 60_000;
            }
            _ => {}
        }
    }
    if at != bytes.len() {
        return None;
    }
    let ms = (days_from_civil(year, month) + day - 1) * 86_400_000 + time - offset;
    (ms.abs() <= 8_640_000_000_000_000).then_some(ms)
}

/// `width` ASCII digits at `at` as a number, advancing past them.
fn digits(bytes: &[u8], at: &mut usize, width: usize) -> Option<i64> {
    let number = bytes
        .get(*at..*at + width)?
        .iter()
        .try_fold(0, |n, &c| c.is_ascii_digit().then(|| n * 10 + i64::from(c - b'0')))?;
    *at += width;
    Some(number)
}

/// Advances past `expected` when it is the next byte.
fn skip(bytes: &[u8], at: &mut usize, expected: u8) -> bool {
    let found = bytes.get(*at) == Some(&expected);
    *at += usize::from(found);
    found
}

/// Days from 1970-01-01 to the first of the month (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5;
    era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468
}

pub(super) fn allowlisted_event(event: &UsageEvent) -> Result<UsageEvent, StoreError> {
    let invalid = Err(StoreError::InvalidUsageEvent);
    let tokens = &event.tokens;
    let counts = [tokens.input, tokens.output, tokens.cache_read, tokens.cache_write];
    let optional = [
        tokens.reasoning.unwrap_or(0),
        tokens.cache_write_1h.unwrap_or(0),
        event.cost_microusd.unwrap_or(0),
    ];
    if counts.iter().chain(&optional).any(|&n| n > MAX_SAFE_INTEGER) {
        return invalid;
    }
    checked_sum(counts).map_err(|_| StoreError::AggregateCounterOverflow)?;
    let text = |value: &Option<String>, limit| value.as_deref().is_none_or(|value| is_metadata_text(value, limit));
    let timestamp = |value: &str| is_metadata_text(value, 4096) && timestamp_ms(value).is_some();
    let mirror = event.claude_mirror_id.as_deref().is_none_or(|id| {
        event.tool == tokentracky_core::ToolId::Omo
            && id
                .strip_prefix("claude:")
                .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()))
    });
    if tokens.reasoning.unwrap_or(0) > tokens.output
        || tokens.cache_write_1h.unwrap_or(0) > tokens.cache_write
        || !mirror
        || !is_metadata_text(&event.event_id, 4096)
        || !is_metadata_text(&event.session_id, 512)
        || !is_metadata_text(&event.model, 256)
        || !text(&event.project, 4096)
        || !text(&event.pricing_version, 4096)
        || !text(&event.service_tier, 32)
        || !event.occurred_at.as_deref().is_none_or(timestamp)
    {
        return invalid;
    }
    Ok(event.clone())
}

pub(super) fn allowlisted_checkpoint(checkpoint: &FileCheckpoint) -> Result<FileCheckpoint, StoreError> {
    let hash = &checkpoint.prefix_hash;
    let finite = |value: Option<f64>| value.is_none_or(f64::is_finite);
    if checkpoint.path.is_empty()
        || checkpoint.identity.is_empty()
        || checkpoint.offset > MAX_SAFE_INTEGER
        || checkpoint.parser_version.unsigned_abs() > MAX_SAFE_INTEGER
        || hash.len() != 64
        || !hash.bytes().all(|c| matches!(c, b'a'..=b'f' | b'0'..=b'9'))
        || checkpoint.file_size.is_some_and(|size| size > MAX_SAFE_INTEGER)
        || !finite(checkpoint.mtime_ms)
        || !finite(checkpoint.ctime_ms)
    {
        return Err(StoreError::InvalidCheckpoint);
    }
    let state = allowlisted_state(&checkpoint.state).ok_or(StoreError::InvalidCheckpoint)?;
    let code = |code: &&String| !code.is_empty() && code.bytes().all(|c| c.is_ascii_lowercase() || c == b'_');
    Ok(FileCheckpoint {
        state,
        diagnostics: checkpoint.diagnostics.iter().filter(code).cloned().collect(),
        // Times are kept only beside a size, as the TypeScript store does.
        mtime_ms: checkpoint.file_size.and(checkpoint.mtime_ms),
        ctime_ms: checkpoint.file_size.and(checkpoint.ctime_ms),
        ..checkpoint.clone()
    })
}

/// The parser state's allowlisted fields, bounded: `None` when any is missing, malformed or too large.
fn allowlisted_state(state: &Value) -> Option<Value> {
    let state = state.as_object()?;
    let text = |key: &str, limit, nullable: bool| match state.get(key)? {
        Value::Null if nullable => Some(Value::Null),
        Value::String(value) if is_metadata_text(value, limit) => Some(json!(value)),
        _ => None,
    };
    let baselines = state.get("baselines")?.as_array().filter(|items| items.len() <= 64)?;
    let seen = state
        .get("seenDeltaIds")?
        .as_array()
        .filter(|items| items.len() <= 256)?;
    let mut kept = json!({
        "sessionId": text("sessionId", 512, true)?,
        "project": text("project", 4096, true)?,
        "model": text("model", 256, false)?,
        "turnId": text("turnId", 512, true)?,
        "previous": match state.get("previous")? {
            Value::Null => Value::Null,
            value => raw_counts(value)?,
        },
        "baselines": baselines.iter().map(raw_counts).collect::<Option<Vec<_>>>()?,
        "seenDeltaIds": seen
            .iter()
            .map(|id| id.as_str().filter(|id| is_metadata_text(id, 4096)).map(Value::from))
            .collect::<Option<Vec<_>>>()?,
    });
    if let Some(tier) = state.get("serviceTier") {
        kept["serviceTier"] = Value::from(tier.as_str().filter(|tier| is_metadata_text(tier, 32))?);
    }
    if let Some(at) = state.get("forkCopyAt") {
        kept["forkCopyAt"] = Value::from(at.as_i64().filter(|at| at.unsigned_abs() <= MAX_SAFE_INTEGER)?);
    }
    if let Some(at) = state.get("countedAt") {
        kept["countedAt"] = Value::from(at.as_i64().filter(|at| at.unsigned_abs() <= MAX_SAFE_INTEGER)?);
    }
    if state.contains_key("forkParent") {
        kept["forkParent"] = text("forkParent", 512, false)?;
    }
    if let Some(limits) = state.get("rateLimits") {
        kept["rateLimits"] = rate_limits(limits)?;
    }
    Some(kept)
}

/// `TimeClip`: the largest distance from the epoch a JavaScript date can hold.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;
fn is_time(ms: i64) -> bool {
    (1..=MAX_TIME_MS).contains(&ms)
}
fn is_percent(value: f64) -> bool {
    (0.0..=100.0).contains(&value)
}
fn is_minutes(minutes: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&minutes)
}

/// A Codex rate-limit snapshot (F6): its record's time and, for each window present, exactly its three figures.
fn rate_limits(value: &Value) -> Option<Value> {
    let limits = value.as_object()?;
    let mut kept = json!({"atMs": limits.get("atMs")?.as_i64().filter(|at| is_time(*at))?});
    for key in ["primary", "secondary"] {
        if let Some(window) = limits.get(key) {
            let window = window.as_object()?;
            let used = window.get("usedPercent")?.as_f64().filter(|used| is_percent(*used))?;
            let mut figures = json!({"usedPercent": used});
            if let Some(minutes) = window.get("windowMinutes") {
                figures["windowMinutes"] = Value::from(minutes.as_u64().filter(|minutes| is_minutes(*minutes))?);
            }
            if let Some(at) = window.get("resetsAtMs") {
                figures["resetsAtMs"] = Value::from(at.as_i64().filter(|at| is_time(*at))?);
            }
            kept[key] = figures;
        }
    }
    Some(kept)
}

/// A usage-limit reading (F6): one of the tool's own window names, each once, with bounded figures.
pub(super) fn allowlisted_limits(reading: &LimitReading) -> Result<LimitReading, StoreError> {
    let names = window_names(reading.tool);
    let valid = |window: &LimitWindow| {
        names.contains(&window.name.as_str())
            && is_percent(window.used_percent)
            && window.window_minutes.is_none_or(is_minutes)
            && window.resets_at_ms.is_none_or(is_time)
    };
    let unique = reading
        .windows
        .iter()
        .enumerate()
        .all(|(at, window)| !reading.windows[..at].iter().any(|other| other.name == window.name));
    if reading.windows.is_empty() || !unique || !is_time(reading.as_of_ms) || !reading.windows.iter().all(valid) {
        return Err(StoreError::InvalidUsageLimits);
    }
    Ok(reading.clone())
}

/// One cumulative counter snapshot: exactly its five safe counts.
fn raw_counts(value: &Value) -> Option<Value> {
    let counts = value.as_object()?;
    let mut raw = Map::new();
    for key in ["input", "cached", "write", "output", "reasoning"] {
        let count = counts.get(key).filter(|count| is_safe_count(count))?;
        let count = count.as_u64().or_else(|| count.as_f64().map(|n| n as u64))?;
        raw.insert(key.to_owned(), Value::from(count));
    }
    Some(Value::Object(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps_like_date_parse() {
        // Each value and `Date.parse(value)` in Node (TZ=UTC), or `None` for NaN.
        for (value, expected) in [
            ("2026-10-20T12:00:00.000Z", Some(1_792_497_600_000)),
            ("2026-10-20T12:00:00.123456Z", Some(1_792_497_600_123)),
            ("2026-10-20T12:00:00.1Z", Some(1_792_497_600_100)),
            ("2026-10-20t12:00:00z", Some(1_792_497_600_000)),
            ("2026-10-20 12:00:00Z", Some(1_792_497_600_000)),
            ("2026-10-20T24:00:00Z", Some(1_792_540_800_000)),
            ("2026-10-20T12:00:00+0200", Some(1_792_490_400_000)),
            ("2026-10-20T12:00:00+02:00", Some(1_792_490_400_000)),
            ("2026-10-20T12:00:00+23:59", Some(1_792_411_260_000)),
            ("2026-10-20T12:00Z", Some(1_792_497_600_000)),
            ("+002026-10-20T00:00:00Z", Some(1_792_454_400_000)),
            ("-000001-01-01T00:00:00Z", Some(-62_198_755_200_000)),
            ("0000-01-01T00:00:00Z", Some(-62_167_219_200_000)),
            ("2026-02-30", Some(1_772_409_600_000)),
            ("2026", Some(1_767_225_600_000)),
            ("2026-10", Some(1_790_812_800_000)),
            ("2026-10-20T12:00:00", Some(1_792_497_600_000)),
            ("+275760-09-13T00:00:00.000Z", Some(8_640_000_000_000_000)),
            ("-271821-04-20T00:00:00.000Z", Some(-8_640_000_000_000_000)),
            ("+275760-09-13T00:00:00.001Z", None),
            ("2026-10-20T24:00:01Z", None),
            ("2026-10-20T12Z", None),
            ("-000000-01-01T00:00:00Z", None),
            ("2026-13-01", None),
            ("2026-10-20T12:00:60Z", None),
            ("2026-10-20T12:00:00.Z", None),
            ("2026-10-20T12:00:00,5Z", None),
            (" 2026-10-20T12:00:00Z", None),
            ("2026-10-20T12:00:00Z ", None),
            ("2026-10-20T1:00:00Z", None),
            ("2026-10-20T12:00:00+24:00", None),
            ("invalid", None),
            ("", None),
        ] {
            assert_eq!(timestamp_ms(value), expected, "{value:?}");
        }
    }
    #[test]
    fn slices_like_javascript_without_splitting_characters() {
        assert_eq!(utf16_prefix("2026-10-20T12:00:00.000Z", 10), "2026-10-20");
        assert_eq!(utf16_prefix("路径", 1), "路");
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_prefix("ab", 10), "ab");
    }
}
