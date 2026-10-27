//! `String.prototype.localeCompare` as the TypeScript store calls it: ICU root collation, compared first by
//! character (letters without case, white space without width) and then by variant, lower case before upper.
//! Exact for ASCII and for the white space and invisible characters JavaScript knows; any other character sorts
//! after every ASCII letter by code point, where ICU would place an accented letter beside its base letter.
use std::cmp::Ordering;
use std::sync::LazyLock;

/// Characters in `localeCompare` order (Node 22, ICU 77), one per primary weight.
const ORDER: &str =
    "\t\n\u{b}\u{c}\r\u{85}\u{2028}\u{2029} _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

/// The primary weight of each ASCII character in [`ORDER`].
static ASCII: LazyLock<[Option<usize>; 128]> = LazyLock::new(|| {
    let mut weights = [None; 128];
    for (weight, c) in ORDER.chars().enumerate().filter(|(_, c)| c.is_ascii()) {
        weights[c as usize] = Some(weight);
    }
    weights
});

/// The primary weight and the variant within it; `None` for characters ICU ignores.
fn weight(c: char) -> Option<(usize, u8)> {
    let (base, variant) = match c {
        '\u{0}'..='\u{8}'
        | '\u{e}'..='\u{1f}'
        | '\u{7f}'
        | '\u{ad}'
        | '\u{200b}'..='\u{200f}'
        | '\u{2060}'
        | '\u{feff}' => {
            return None;
        }
        '\u{3000}' => (' ', 1),
        '\u{1680}' | '\u{2000}'..='\u{2006}' | '\u{2008}'..='\u{200a}' | '\u{205f}' => (' ', 2),
        '\u{a0}' | '\u{2007}' | '\u{202f}' => (' ', 3),
        'A'..='Z' => (c.to_ascii_lowercase(), 1),
        _ => (c, 0),
    };
    let primary = if base.is_ascii() {
        ASCII[base as usize]
    } else {
        ORDER.chars().position(|o| o == base)
    };
    Some((primary.unwrap_or(ORDER.len() + c as usize), variant))
}

pub(super) fn locale_cmp(a: &str, b: &str) -> Ordering {
    if a == b {
        return Ordering::Equal;
    }
    primaries(a)
        .cmp(primaries(b))
        .then_with(|| variants(a).cmp(variants(b)))
}
fn primaries(s: &str) -> impl Iterator<Item = usize> + '_ {
    s.chars().filter_map(weight).map(|(primary, _)| primary)
}
fn variants(s: &str) -> impl Iterator<Item = u8> + '_ {
    s.chars().filter_map(weight).map(|(_, variant)| variant)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_like_locale_compare() {
        let mut chars: Vec<String> = (32u8..127).map(|c| char::from(c).to_string()).collect();
        chars.sort_by(|a, b| locale_cmp(a, b));
        let sorted =
            " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";
        assert_eq!(chars.concat(), sorted);
        // Each pair and its `a.localeCompare(b)` sign, read from Node.
        for (a, b, expected) in [
            ("a", "A", Ordering::Less),
            ("aB", "Ab", Ordering::Less),
            ("ab", "Aa", Ordering::Greater),
            ("a-b", "ab", Ordering::Less),
            ("x-1", "x_1", Ordering::Greater),
            ("a", "a-", Ordering::Less),
            ("A-b", "a-B", Ordering::Greater),
            ("ab-", "Ab", Ordering::Greater),
            (":claude", "2026", Ordering::Less),
            ("2026-10-23T12:00:00Z", "2026-10-23T12:00:00.000Z", Ordering::Greater),
            ("a\u{7f}", "a", Ordering::Equal),
            ("路", "a", Ordering::Greater),
            ("", "a", Ordering::Less),
            (" a", "\u{3000}a", Ordering::Less),
            ("\u{3000}a", "\u{2000}a", Ordering::Less),
            ("\u{2000}a", "\u{2002}a", Ordering::Equal),
            ("\u{2000}a", "\u{a0}a", Ordering::Less),
            ("\u{a0}b", " a", Ordering::Greater),
            ("\u{2029}", " ", Ordering::Less),
            ("\u{feff}-a", "-a", Ordering::Equal),
        ] {
            assert_eq!(locale_cmp(a, b), expected, "{a:?} {b:?}");
        }
    }
}
