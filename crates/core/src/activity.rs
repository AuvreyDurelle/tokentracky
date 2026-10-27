//! Streaks, best day and averages over UTC days. Ported from `packages/core/src/activity.ts`.
use crate::ranking::parse_day;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use ts_rs::TS;

/// One UTC day's tokens (`{day, tokens}` in TypeScript).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DayTokens {
    pub day: String,
    #[ts(type = "number")]
    pub tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStats {
    pub active_days: u32,
    /// Consecutive active UTC days ending today, or yesterday while today has no tokens yet.
    pub current_streak: u32,
    pub longest_streak: u32,
    #[ts(inline)]
    pub best_day: Option<DayTokens>,
    /// Rounded mean over active days only.
    #[ts(type = "number")]
    pub average_per_active_day: u64,
}

fn day_number(day: &str) -> Option<i32> {
    parse_day(day).map(|date| date.to_julian_day())
}

/// Streaks, best day and averages from daily totals (`YYYY-MM-DD` UTC days, any order).
pub fn activity_stats(daily: &[DayTokens], today: &str) -> ActivityStats {
    let mut totals = BTreeMap::<&str, u64>::new();
    for entry in daily.iter().filter(|entry| entry.tokens > 0) {
        *totals.entry(&entry.day).or_default() += entry.tokens;
    }
    let (mut longest, mut run, mut previous, mut best_day, mut sum) = (0, 0, None, None::<DayTokens>, 0);
    for (&day, &tokens) in &totals {
        let number = day_number(day);
        run = if previous
            .zip(number)
            .is_some_and(|(previous, number)| number - previous == 1)
        {
            run + 1
        } else {
            1
        };
        longest = longest.max(run);
        previous = number;
        sum += tokens;
        if best_day.as_ref().is_none_or(|best| tokens > best.tokens) {
            best_day = Some(DayTokens {
                day: day.to_owned(),
                tokens,
            });
        }
    }
    let active: HashSet<i32> = totals.keys().filter_map(|day| day_number(day)).collect();
    let current = day_number(today).map_or(0, |end| {
        let start = if active.contains(&end) { end } else { end - 1 };
        (0..).take_while(|back| active.contains(&(start - back))).count()
    });
    let days = totals.len() as u64;
    // `Math.round(sum / days)`: half up, and 0 with no active day.
    let average = sum
        .checked_div(days)
        .map_or(0, |quotient| quotient + u64::from((sum % days) * 2 >= days));
    ActivityStats {
        active_days: days as u32,
        current_streak: current as u32,
        longest_streak: longest,
        best_day,
        average_per_active_day: average,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days(entries: &[(&str, u64)]) -> Vec<DayTokens> {
        entries
            .iter()
            .map(|&(day, tokens)| DayTokens {
                day: day.to_owned(),
                tokens,
            })
            .collect()
    }
    fn best(day: &str, tokens: u64) -> Option<DayTokens> {
        Some(DayTokens {
            day: day.to_owned(),
            tokens,
        })
    }

    #[test]
    fn counts_streaks_across_month_boundaries_and_ignores_empty_days() {
        let history = days(&[
            ("2026-09-29", 5),
            ("2026-09-30", 7),
            ("2026-10-01", 1),
            ("2026-10-03", 0),
            ("2026-10-04", 100),
            ("2026-10-05", 2),
        ]);
        let expected = ActivityStats {
            active_days: 5,
            current_streak: 2,
            longest_streak: 3,
            best_day: best("2026-10-04", 100),
            average_per_active_day: 23,
        };
        assert_eq!(activity_stats(&history, "2026-10-05"), expected);
    }
    #[test]
    fn keeps_the_current_streak_alive_until_today_ends_then_resets_it() {
        let history = days(&[("2026-10-21", 1), ("2026-10-22", 1)]);
        assert_eq!(activity_stats(&history, "2026-10-22").current_streak, 2);
        assert_eq!(activity_stats(&history, "2026-10-23").current_streak, 2);
        assert_eq!(activity_stats(&history, "2026-10-24").current_streak, 0);
    }
    #[test]
    fn merges_duplicate_days_picks_the_earliest_of_tied_best_days_and_handles_no_activity() {
        let stats = activity_stats(
            &days(&[("2026-10-02", 4), ("2026-10-01", 3), ("2026-10-01", 1)]),
            "2026-10-02",
        );
        assert_eq!(
            (stats.active_days, stats.longest_streak, stats.best_day),
            (2, 2, best("2026-10-01", 4))
        );
        let empty = ActivityStats {
            active_days: 0,
            current_streak: 0,
            longest_streak: 0,
            best_day: None,
            average_per_active_day: 0,
        };
        assert_eq!(activity_stats(&[], "2026-10-02"), empty);
    }
}
