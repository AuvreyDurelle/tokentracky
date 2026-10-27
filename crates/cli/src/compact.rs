//! `new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n)` for the whole numbers
//! the totals are: 161 is "161", 12345 is "12.3K", 999950 is "1M".

/// Scales from thousands to trillions; there is nothing beyond T.
const SUFFIXES: [&str; 4] = ["K", "M", "B", "T"];

/// Rounds half up on the exact value (as ICU's half-expand does for a positive number) to one decimal, in the
/// largest scale the number reaches, and moves up a scale when rounding reaches 1000 (999950 is 1M, not 1000K).
/// Totals stay below 2^53, so the integer part of a T figure has four digits at most and never needs a group
/// separator.
pub fn compact(n: u64) -> String {
    if n < 1000 {
        return n.to_string();
    }
    let n = u128::from(n);
    let mut scale = (1..=SUFFIXES.len())
        .take_while(|&scale| n >= 1000u128.pow(scale as u32))
        .count();
    loop {
        let unit = 1000u128.pow(scale as u32);
        let tenths = (n * 10 + unit / 2) / unit;
        if tenths >= 10_000 && scale < SUFFIXES.len() {
            scale += 1;
            continue;
        }
        let (whole, tenth) = (tenths / 10, tenths % 10);
        let fraction = if tenth == 0 { String::new() } else { format!(".{tenth}") };
        return format!("{whole}{fraction}{}", SUFFIXES[scale - 1]);
    }
}

#[cfg(test)]
mod tests {
    use super::compact;

    /// Each value and its text are what Node 22.18's `Intl.NumberFormat` prints.
    #[test]
    fn matches_intl_compact_notation() {
        let cases = [
            (0, "0"),
            (1, "1"),
            (161, "161"),
            (999, "999"),
            (1000, "1K"),
            (1049, "1K"),
            (1050, "1.1K"),
            (1234, "1.2K"),
            (1250, "1.3K"),
            (9949, "9.9K"),
            (9950, "10K"),
            (9999, "10K"),
            (10_000, "10K"),
            (12_345, "12.3K"),
            (99_999, "100K"),
            (123_456, "123.5K"),
            (999_499, "999.5K"),
            (999_949, "999.9K"),
            (999_950, "1M"),
            (999_999, "1M"),
            (1_000_000, "1M"),
            (1_200_000, "1.2M"),
            (1_250_000, "1.3M"),
            (9_950_000, "10M"),
            (12_345_678, "12.3M"),
            (999_950_000, "1B"),
            (1_500_000_000, "1.5B"),
            (1_200_000_000_000, "1.2T"),
            (999_000_000_000_000, "999T"),
            (999_950_000_000_000, "1000T"),
            (1_000_000_000_000_000, "1000T"),
            (9_007_199_254_740_991, "9007.2T"),
        ];
        for (n, text) in cases {
            assert_eq!(compact(n), text, "{n}");
        }
    }
}
