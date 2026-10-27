//! `Date.parse` and `Date.prototype.toISOString` as V8 runs them on the timestamps the readers accept, so dates and
//! the event ids built from them match the TypeScript collector.

const DAY_MS: i64 = 86_400_000;
/// `TimeClip`: the largest distance from the epoch a JavaScript date can hold.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

/// Milliseconds since the epoch of `YYYY-MM-DDT…` text ending in `Z` or `±HH:MM` with no line terminator in between
/// (the readers' filter), as V8's `Date.parse` reads it, or `None` where it returns `NaN`. Under that filter V8 accepts
/// only `THH:mm[:ss[.fraction]]` and the zone: `24:00` is the next midnight, a day past the month end rolls over
/// (`02-30` is 2 March), and a fraction keeps its first three significant digits of at most nine read.
pub(crate) fn parse(value: &str) -> Option<i64> {
    let s = value.as_bytes();
    let zone = if value.ends_with('Z') {
        1
    } else if s.len() >= 6 && matches!(s[s.len() - 6], b'+' | b'-') && is_offset(&s[s.len() - 5..]) {
        6
    } else {
        return None;
    };
    let shape = s.len() >= 11 + zone
        && s[..4].iter().all(u8::is_ascii_digit)
        && s[4] == b'-'
        && s[5..7].iter().all(u8::is_ascii_digit)
        && s[7] == b'-'
        && s[8..10].iter().all(u8::is_ascii_digit)
        && s[10] == b'T';
    if !shape || value[11..s.len() - zone].contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let (year, month, day) = (number(&s[..4]), number(&s[5..7]), number(&s[8..10]));
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut at = 11;
    let hour = two(s, &mut at).filter(|hour| *hour <= 24)?;
    if !symbol(s, &mut at, b':') {
        return None;
    }
    let minute = two(s, &mut at).filter(|minute| *minute <= 59)?;
    let (mut second, mut read, mut ms) = (0, 0, 0);
    if symbol(s, &mut at, b':') {
        second = two(s, &mut at).filter(|second| *second <= 59)?;
        if symbol(s, &mut at, b'.') {
            let fraction = digits(s, &mut at);
            if fraction.is_empty() {
                return None;
            }
            (read, ms) = milliseconds(fraction);
        }
    }
    if hour == 24 && (minute, second, read) != (0, 0, 0) {
        return None;
    }
    let offset = if symbol(s, &mut at, b'Z') {
        0
    } else {
        let sign = if symbol(s, &mut at, b'+') {
            1
        } else if symbol(s, &mut at, b'-') {
            -1
        } else {
            return None;
        };
        let hours = two(s, &mut at).filter(|hours| *hours <= 23)?;
        if !symbol(s, &mut at, b':') {
            return None;
        }
        sign * (hours * 60 + two(s, &mut at).filter(|minutes| *minutes <= 59)?) * 60_000
    };
    if at != s.len() {
        return None;
    }
    let time =
        (days_from_civil(year, month, 1) + day - 1) * DAY_MS + hour * 3_600_000 + minute * 60_000 + second * 1000 + ms
            - offset;
    (time.abs() <= MAX_TIME_MS).then_some(time)
}

/// `new Date(ms).toISOString()`: four-digit years, or a sign and six digits outside 0000 to 9999.
pub(crate) fn iso_string(ms: i64) -> String {
    let (days, time) = (ms.div_euclid(DAY_MS), ms.rem_euclid(DAY_MS));
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1000 % 60,
        time % 1000
    )
}

fn is_offset(s: &[u8]) -> bool {
    s[..2].iter().all(u8::is_ascii_digit) && s[2] == b':' && s[3..].iter().all(u8::is_ascii_digit)
}
/// The digits starting at `*at`, which then points past them (V8 reads a number token whole).
fn digits<'a>(s: &'a [u8], at: &mut usize) -> &'a [u8] {
    let start = *at;
    while s.get(*at).is_some_and(u8::is_ascii_digit) {
        *at += 1;
    }
    &s[start..*at]
}
/// A field of exactly two digits.
fn two(s: &[u8], at: &mut usize) -> Option<i64> {
    let field = digits(s, at);
    (field.len() == 2).then(|| number(field))
}
fn symbol(s: &[u8], at: &mut usize, symbol: u8) -> bool {
    let found = s.get(*at) == Some(&symbol);
    *at += usize::from(found);
    found
}
fn number(digits: &[u8]) -> i64 {
    digits.iter().fold(0, |n, digit| n * 10 + i64::from(digit - b'0'))
}
/// V8's `ReadMilliseconds`: the value of the first nine digits after leading zeros, scaled by the full digit count.
/// Returns that value (V8 rejects a non-zero one after `24:00`) and the milliseconds.
fn milliseconds(fraction: &[u8]) -> (i64, i64) {
    let significant = fraction
        .iter()
        .position(|digit| *digit != b'0')
        .map_or(&[][..], |at| &fraction[at..]);
    let read = number(&significant[..significant.len().min(9)]);
    let ms = match fraction.len() {
        1 => read * 100,
        2 => read * 10,
        3 => read,
        length => read / 10_i64.pow(length.min(9) as u32 - 3),
    };
    (read, ms)
}
/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let (era, of_era) = (year.div_euclid(400), year.rem_euclid(400));
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    era * 146_097 + of_era * 365 + of_era / 4 - of_era / 100 + of_year - 719_468
}
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let (era, of_era) = (days.div_euclid(146_097), days.rem_euclid(146_097));
    let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * of_year + 2) / 153;
    let day = of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 { shifted + 3 } else { shifted - 9 };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each input with what `new Date(Date.parse(input)).toISOString()` gives in Node 22 (V8), or `None` for `NaN`.
    #[test]
    fn parses_like_v8() {
        for (input, expected) in [
            ("2026-10-20T12:00:00.000Z", Some("2026-10-20T12:00:00.000Z")),
            ("2026-10-20T12:00:00Z", Some("2026-10-20T12:00:00.000Z")),
            ("2026-10-20T12:00Z", Some("2026-10-20T12:00:00.000Z")),
            ("2026-10-20T12Z", None),
            ("2026-10-20T12:00:00.123456Z", Some("2026-10-20T12:00:00.123Z")),
            ("2026-10-20T12:00:00.1Z", Some("2026-10-20T12:00:00.100Z")),
            ("2026-10-20T12:00:00.0001234567891Z", Some("2026-10-20T12:00:00.123Z")),
            ("2026-10-20T12:00:00.999999999999Z", Some("2026-10-20T12:00:00.999Z")),
            ("2026-10-20T12:00:00.5-00:00", Some("2026-10-20T12:00:00.500Z")),
            ("2026-10-20T24:00:00Z", Some("2026-10-21T00:00:00.000Z")),
            ("2026-10-20T24:00:01Z", None),
            ("2026-02-30T00:00:00Z", Some("2026-03-02T00:00:00.000Z")),
            ("2026-02-31T00:00:00+01:00", Some("2026-03-02T23:00:00.000Z")),
            ("2026-13-01T00:00:00Z", None),
            ("2026-10-32T00:00:00Z", None),
            ("2026-10-00T00:00:00Z", None),
            ("2026-10-20Tfoo Z", None),
            ("2026-10-20T12:00:00 Z", None),
            ("2026-10-20T12:00:00+01:00", Some("2026-10-20T11:00:00.000Z")),
            ("2026-10-20T12:00:00-23:59", Some("2026-10-21T11:59:00.000Z")),
            ("2026-10-20T12:00:00+24:00", None),
            ("2026-10-20T12:00:00.000+0100Z", None),
            ("0000-01-01T00:00:00+01:00", Some("-000001-12-31T23:00:00.000Z")),
            ("9999-12-31T23:59:59-01:00", Some("+010000-01-01T00:59:59.000Z")),
            ("2026-10-20t12:00:00Z", None),
            ("2026-10-20T12:00:00z", None),
            ("2026-10-20T1:00:00Z", None),
            ("2026-10-20T12:60:00Z", None),
            ("2026-10-20T12:00:60Z", None),
            ("2026-10-20T12:00:00.Z", None),
            ("2026-10-20T12:00:00GMT+01:00", None),
            ("2026-10-20T12:00:00.000ZZ", None),
            ("2026-10-20T 12:00:00Z", None),
            ("2026-10-20TZ", None),
            ("2026-10-20T12:00:00.000UTC+01:00", None),
            ("2026-10-20T00:00:00.-1Z", None),
            ("2026-10-20T12:00:00", None),
            ("2026-10-20", None),
        ] {
            assert_eq!(parse(input).map(iso_string).as_deref(), expected, "{input}");
        }
    }
    #[test]
    fn formats_epoch_milliseconds_like_to_iso_string() {
        assert_eq!(iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(1_792_746_000_000), "2026-10-23T09:00:00.000Z");
        assert_eq!(iso_string(MAX_TIME_MS), "+275760-09-13T00:00:00.000Z");
        assert_eq!(iso_string(-1), "1969-12-31T23:59:59.999Z");
    }
}
