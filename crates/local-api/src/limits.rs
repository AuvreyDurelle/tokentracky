//! What `GET /api/local/limits` answers (F6, Rust only): Claude Code's and Codex's latest usage-limit readings as the
//! store keeps them, each window with its pace. Local only: the hosted site has no limits and uploads never carry them.
use crate::link::iso;
use serde::Serialize;
use time::OffsetDateTime;
use tokentracky_collector::limits::{LimitReading, LimitWindow};
use tokentracky_core::ToolId;

/// The tools with usage limits, in the order they are listed.
const TOOLS: [ToolId; 2] = [ToolId::Claude, ToolId::Codex];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Limits {
    pub tools: Vec<ToolLimits>,
}

/// One tool's latest reading; with none yet, no time and no windows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLimits {
    pub tool: ToolId,
    /// When the tool took the reading (`toISOString`); it changes only when the tool is used.
    pub as_of: Option<String>,
    pub windows: Vec<WindowLimits>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLimits {
    /// `five_hour`, `seven_day` or `seven_day_opus` for Claude Code; `primary` or `secondary` for Codex.
    pub name: String,
    /// The reading's % used; 0 once the window has reset.
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<String>,
    /// The reset time has passed since the reading, so the window has started again.
    pub reset: bool,
    #[serde(flatten)]
    pub pace: Pace,
}

/// Where a window stands at the pace it has been used so far; `None` where that cannot be told.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pace {
    /// The share of the window gone by: what an even pace would have used by now.
    pub even_percent: Option<f64>,
    /// % used at the reset if use goes on at the same rate, at most 100.
    pub projected_percent: Option<f64>,
    /// Milliseconds until 100% at the same rate, when that comes before the reset; 0 once it is reached.
    pub runs_out_in_ms: Option<u64>,
}

/// The pace of a window `window_ms` long that resets at `resets_at_ms`, `used_percent` used, at `now_ms`: its use so far
/// spread evenly over the time gone by since it started. Nothing once it has reset, and no rate before any time has
/// gone by; unused, it projects 0% and never runs out; at 100% it has run out.
pub fn pace(used_percent: f64, window_ms: i64, resets_at_ms: i64, now_ms: i64) -> Pace {
    let left = resets_at_ms.saturating_sub(now_ms);
    if window_ms <= 0 || left <= 0 {
        return Pace::default();
    }
    // A reset further off than the window is long has not started yet.
    let gone = window_ms.saturating_sub(left).max(0);
    let even = Some(gone as f64 / window_ms as f64 * 100.0);
    let used = used_percent.clamp(0.0, 100.0);
    let (projected, runs_out) = if used >= 100.0 {
        (Some(100.0), Some(0))
    } else if used == 0.0 {
        (Some(0.0), None)
    } else if gone == 0 {
        (None, None)
    } else {
        // At `used / gone` a millisecond, written to round once.
        let (gone, left) = (gone as f64, left as f64);
        let to_full = (100.0 - used) * gone / used;
        let projected = (used * (gone + left) / gone).min(100.0);
        (Some(projected), (to_full < left).then(|| to_full.round() as u64))
    };
    Pace {
        even_percent: even,
        projected_percent: projected,
        runs_out_in_ms: runs_out,
    }
}

/// `toISOString` of epoch milliseconds, for the years the clock reads; `None` beyond them.
fn iso_ms(ms: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .map(iso)
}

fn window(window: &LimitWindow, now_ms: i64) -> WindowLimits {
    let reset = window.resets_at_ms.is_some_and(|at| at <= now_ms);
    let pace = match (window.window_minutes, window.resets_at_ms) {
        (Some(minutes), Some(at)) if !reset => pace(
            window.used_percent,
            i64::try_from(minutes).unwrap_or(i64::MAX).saturating_mul(60_000),
            at,
            now_ms,
        ),
        _ => Pace::default(),
    };
    WindowLimits {
        name: window.name.clone(),
        used_percent: if reset { 0.0 } else { window.used_percent },
        window_minutes: window.window_minutes,
        resets_at: window.resets_at_ms.and_then(iso_ms),
        reset,
        pace,
    }
}

/// Each tool's limits at `now_ms` from the stored readings.
pub fn limits(readings: &[LimitReading], now_ms: i64) -> Limits {
    let tool = |tool: ToolId| {
        let reading = readings.iter().find(|reading| reading.tool == tool);
        ToolLimits {
            tool,
            as_of: reading.and_then(|reading| iso_ms(reading.as_of_ms)),
            windows: reading.map_or_else(Vec::new, |reading| {
                reading.windows.iter().map(|found| window(found, now_ms)).collect()
            }),
        }
    };
    Limits {
        tools: TOOLS.into_iter().map(tool).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3_600_000;
    /// 2026-10-25T12:00:00Z.
    const NOW: i64 = 1_792_929_600_000;
    /// A five-hour window three hours in: it resets in two hours.
    fn five_hours(used_percent: f64) -> Pace {
        pace(used_percent, 5 * HOUR, NOW + 2 * HOUR, NOW)
    }
    fn close(actual: Option<f64>, expected: f64) -> bool {
        actual.is_some_and(|actual| (actual - expected).abs() < 1e-9)
    }

    #[test]
    fn projects_the_use_so_far_to_the_reset() {
        // 30% in three hours is 10% an hour: 50% at the reset, and 100% would take seven more hours.
        let pace = five_hours(30.0);
        assert!(
            close(pace.even_percent, 60.0) && close(pace.projected_percent, 50.0),
            "{pace:?}"
        );
        assert_eq!(pace.runs_out_in_ms, None);
        // 90% in three hours is 30% an hour: the last 10% goes in 20 minutes, before the reset.
        let pace = five_hours(90.0);
        assert!(close(pace.projected_percent, 100.0), "{pace:?}");
        assert_eq!(pace.runs_out_in_ms, Some(20 * 60_000));
        // 60% in three hours runs out exactly at the reset: not before it.
        let pace = five_hours(60.0);
        assert!(close(pace.projected_percent, 100.0), "{pace:?}");
        assert_eq!(pace.runs_out_in_ms, None);
    }
    #[test]
    fn handles_an_unused_a_used_up_and_an_unstarted_window() {
        let even = Some(60.0);
        assert_eq!(
            five_hours(0.0),
            Pace {
                even_percent: even,
                projected_percent: Some(0.0),
                runs_out_in_ms: None
            }
        );
        let used_up = Pace {
            even_percent: even,
            projected_percent: Some(100.0),
            runs_out_in_ms: Some(0),
        };
        assert_eq!(five_hours(100.0), used_up);
        assert_eq!(five_hours(130.0), used_up);
        assert_eq!(five_hours(-5.0), five_hours(0.0));
        // No time has gone by, so the use has no rate yet.
        let fresh = Pace {
            even_percent: Some(0.0),
            ..Pace::default()
        };
        assert_eq!(pace(5.0, 5 * HOUR, NOW + 5 * HOUR, NOW), fresh);
        assert_eq!(pace(5.0, 5 * HOUR, NOW + 6 * HOUR, NOW), fresh);
    }
    #[test]
    fn has_no_pace_once_the_window_resets_or_without_a_length() {
        assert_eq!(pace(50.0, 5 * HOUR, NOW, NOW), Pace::default());
        assert_eq!(pace(50.0, 5 * HOUR, NOW - 1, NOW), Pace::default());
        assert_eq!(pace(50.0, 0, NOW + HOUR, NOW), Pace::default());
        assert_eq!(pace(50.0, 5 * HOUR, i64::MIN, i64::MAX), Pace::default());
    }
    #[test]
    fn reports_a_passed_reset_as_reset_and_a_tool_without_a_reading_as_empty() {
        let window = |name: &str, resets_at_ms: Option<i64>, window_minutes: Option<u64>| LimitWindow {
            name: name.to_owned(),
            used_percent: 30.0,
            window_minutes,
            resets_at_ms,
        };
        let reading = LimitReading {
            tool: ToolId::Codex,
            as_of_ms: NOW - HOUR,
            windows: vec![
                window("primary", Some(NOW + 2 * HOUR), Some(300)),
                window("secondary", Some(NOW - 1), Some(10_080)),
            ],
        };
        let limits = limits(&[reading], NOW);
        assert_eq!(
            limits.tools[0],
            ToolLimits {
                tool: ToolId::Claude,
                as_of: None,
                windows: Vec::new()
            }
        );
        let codex = &limits.tools[1];
        assert_eq!(codex.as_of.as_deref(), Some("2026-10-25T11:00:00.000Z"));
        assert_eq!(codex.windows[0].pace, five_hours(30.0));
        assert_eq!((codex.windows[0].used_percent, codex.windows[0].reset), (30.0, false));
        assert_eq!(
            codex.windows[1],
            WindowLimits {
                name: "secondary".to_owned(),
                used_percent: 0.0,
                window_minutes: Some(10_080),
                resets_at: Some("2026-10-25T11:59:59.999Z".to_owned()),
                reset: true,
                pace: Pace::default(),
            }
        );
        // Without a reset time or a length the window is shown as read, with no pace.
        let unknown = LimitReading {
            tool: ToolId::Claude,
            as_of_ms: NOW,
            windows: vec![
                window("five_hour", None, Some(300)),
                window("seven_day", Some(NOW + HOUR), None),
            ],
        };
        for window in &super::limits(&[unknown], NOW).tools[0].windows {
            assert_eq!(
                (window.used_percent, window.reset, window.pace),
                (30.0, false, Pace::default())
            );
        }
        let json = serde_json::to_value(&limits.tools[1].windows[0]).unwrap();
        let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "evenPercent",
                "name",
                "projectedPercent",
                "reset",
                "resetsAt",
                "runsOutInMs",
                "usedPercent",
                "windowMinutes"
            ]
        );
    }
}
