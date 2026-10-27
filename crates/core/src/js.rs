//! JavaScript behaviour the crates reproduce: white space, `Date.prototype.toISOString` and compact notation.
use time::{OffsetDateTime, UtcOffset};

/// White space as JavaScript's `\s` and `trim` see it: Unicode white space and U+FEFF, but not U+0085.
pub fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// `Date.prototype.toISOString` for the years a clock gives.
pub fn iso_timestamp(time: OffsetDateTime) -> String {
    let t = time.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

/// `Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1})` for whole numbers: `161`, `12.3K`,
/// `1.2M`. Halves round up, a value that rounds to 1000 of a unit moves to the next (`999,950` is `1M`), and past
/// `T` the integer part grows, grouped from five digits (`10,000T`), as ICU does.
pub fn compact_count(n: u64) -> String {
    const SUFFIXES: [&str; 5] = ["", "K", "M", "B", "T"];
    if n < 1000 {
        return n.to_string();
    }
    let mut unit = (n.ilog10() / 3).min(4) as usize;
    let tenths = |unit: usize| {
        let divisor = 1000u128.pow(unit as u32);
        (u128::from(n) * 10 + divisor / 2) / divisor
    };
    let mut rounded = tenths(unit);
    if rounded >= 10_000 && unit < 4 {
        unit += 1;
        rounded = tenths(unit);
    }
    let (whole, fraction) = (rounded / 10, rounded % 10);
    let mut digits = whole.to_string();
    let length = digits.len();
    if length >= 5 {
        for at in (1..length).rev().filter(|at| (length - at) % 3 == 0) {
            digits.insert(at, ',');
        }
    }
    match fraction {
        0 => format!("{digits}{}", SUFFIXES[unit]),
        _ => format!("{digits}.{fraction}{}", SUFFIXES[unit]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_javascript_white_space_for_every_char() {
        let listed = |c: char| {
            matches!(
                c,
                '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                    ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
            )
        };
        for c in char::MIN..=char::MAX {
            assert_eq!(is_js_space(c), listed(c), "U+{:04X}", u32::from(c));
        }
    }

    /// Each value and its text are what Node 22.18's `Intl.NumberFormat` prints.
    #[test]
    fn matches_intl_compact_notation() {
        let cases = [
            (0, "0"),
            (1, "1"),
            (161, "161"),
            (999, "999"),
            (1_000, "1K"),
            (1_049, "1K"),
            (1_050, "1.1K"),
            (1_234, "1.2K"),
            (1_250, "1.3K"),
            (9_949, "9.9K"),
            (9_950, "10K"),
            (9_999, "10K"),
            (10_000, "10K"),
            (12_345, "12.3K"),
            (99_950, "100K"),
            (99_999, "100K"),
            (123_456, "123.5K"),
            (999_499, "999.5K"),
            (999_949, "999.9K"),
            (999_950, "1M"),
            (999_999, "1M"),
            (1_000_000, "1M"),
            (1_049_999, "1M"),
            (1_200_000, "1.2M"),
            (1_234_567, "1.2M"),
            (1_250_000, "1.3M"),
            (9_950_000, "10M"),
            (12_345_678, "12.3M"),
            (20_149_999, "20.1M"),
            (999_949_999, "999.9M"),
            (999_950_000, "1B"),
            (1_500_000_000, "1.5B"),
            (2_500_000_000, "2.5B"),
            (120_000_000_000, "120B"),
            (999_950_000_000, "1T"),
            (1_200_000_000_000, "1.2T"),
            (1_250_000_000_000, "1.3T"),
            (999_000_000_000_000, "999T"),
            (999_950_000_000_000, "1000T"),
            (1_000_000_000_000_000, "1000T"),
            (9_007_199_254_740_991, "9007.2T"),
            (10_000_000_000_000_000, "10,000T"),
        ];
        for (n, text) in cases {
            assert_eq!(compact_count(n), text, "{n}");
        }
    }
}
