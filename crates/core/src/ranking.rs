//! UTC day keys, ranking windows and safe counters. Ported from `packages/core/src/ranking.ts`.
use crate::Period;
use serde_json::Value;
use time::{Date, Duration, Month, OffsetDateTime, UtcOffset};

/// `Number.MAX_SAFE_INTEGER`: JSON counters stay at or below it so JavaScript reads them exactly.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Counter exceeds safe integer range")]
pub struct CounterOverflow;

/// Start of the leaderboard window as an ISO timestamp: this UTC week's Monday or month's first day; `None` for all time.
pub fn ranking_window(period: Period, now: OffsetDateTime) -> Option<String> {
    let today = now.to_offset(UtcOffset::UTC).date();
    let back = match period {
        Period::All => return None,
        Period::Month => today.day() - 1,
        Period::Week => today.weekday().number_days_from_monday(),
    };
    Some(format!("{}T00:00:00.000Z", today - Duration::days(back.into())))
}

/// `YYYY-MM-DD` as a calendar date, rejecting rollover such as `2026-02-29`.
pub(crate) fn parse_day(value: &str) -> Option<Date> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| {
        bytes[range]
            .iter()
            .try_fold(0u16, |n, &c| c.is_ascii_digit().then(|| n * 10 + u16::from(c - b'0')))
    };
    let month = Month::try_from(u8::try_from(number(5..7)?).ok()?).ok()?;
    Date::from_calendar_date(number(0..4)?.into(), month, u8::try_from(number(8..10)?).ok()?).ok()
}

/// Reject date rollover and timestamps invented from import time.
pub fn is_utc_day(value: &str) -> bool {
    parse_day(value).is_some()
}

/// A non-negative JSON integer JavaScript can hold exactly (`Number.isSafeInteger(value) && value >= 0`).
pub fn is_safe_count(value: &Value) -> bool {
    match value.as_u64() {
        Some(n) => n <= MAX_SAFE_INTEGER,
        None => value
            .as_f64()
            .is_some_and(|n| n >= 0.0 && n.fract() == 0.0 && n <= MAX_SAFE_INTEGER as f64),
    }
}

/// Sum of safe counts that stays safe; any negative or unsafe value or total is an overflow.
pub fn checked_sum<T: Into<i128>>(values: impl IntoIterator<Item = T>) -> Result<u64, CounterOverflow> {
    let safe = |n: i128| {
        u64::try_from(n)
            .ok()
            .filter(|&n| n <= MAX_SAFE_INTEGER)
            .ok_or(CounterOverflow)
    };
    values
        .into_iter()
        .try_fold(0, |sum, value| safe(i128::from(sum + safe(value.into())?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use time::macros::datetime;

    #[test]
    fn uses_the_prior_monday_across_year_and_month_boundaries_independent_of_local_timezone() {
        let window = |period, now| ranking_window(period, now).unwrap();
        assert_eq!(
            window(Period::Week, datetime!(2026-01-01 00:01 UTC)),
            "2025-12-29T00:00:00.000Z"
        );
        assert_eq!(
            window(Period::Week, datetime!(2026-01-04 23:59:59 UTC)),
            "2025-12-29T00:00:00.000Z"
        );
        assert_eq!(
            window(Period::Week, datetime!(2026-01-05 00:00 UTC)),
            "2026-01-05T00:00:00.000Z"
        );
        assert_eq!(
            window(Period::Month, datetime!(2026-01-01 00:01 UTC)),
            "2026-01-01T00:00:00.000Z"
        );
        assert_eq!(ranking_window(Period::All, OffsetDateTime::now_utc()), None);
        assert_eq!(
            window(Period::Week, datetime!(2026-01-05 01:00 +02:00)),
            "2025-12-29T00:00:00.000Z"
        );
    }
    #[test]
    fn rejects_rollover_dates_and_unsafe_aggregate_totals() {
        assert!(!is_utc_day("2026-02-29"));
        assert!(is_utc_day("2024-02-29"));
        assert!(!is_utc_day("2026-02-01T00:00:00Z"));
        assert_eq!(checked_sum([MAX_SAFE_INTEGER, 1]), Err(CounterOverflow));
        assert_eq!(checked_sum([1, -1]), Err(CounterOverflow));
    }
    #[test]
    fn reads_json_counters_like_number_is_safe_integer() {
        for value in [json!(0), json!(1.0), json!(MAX_SAFE_INTEGER)] {
            assert!(is_safe_count(&value), "{value}");
        }
        for value in [
            json!(-1),
            json!(1.5),
            json!(MAX_SAFE_INTEGER + 1),
            json!("1"),
            json!(null),
        ] {
            assert!(!is_safe_count(&value), "{value}");
        }
        assert_eq!(checked_sum([1u64, 2, 3]), Ok(6));
    }
}
