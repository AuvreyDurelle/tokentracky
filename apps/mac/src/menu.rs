//! The menu-bar title and dropdown. Pure functions let tests run without a menu bar.
use tokentracky_local_api::{LocalOverview, MenuBarPeriod, MenuBarShows};

pub const REFRESH: &str = "refresh";
pub const OPEN: &str = "open";
pub const PAUSE: &str = "pause";
pub const LOGIN: &str = "login";
pub const CHECK_FOR_UPDATES: &str = "check-for-updates";
pub const DOWNLOAD_UPDATE: &str = "download-update";
pub const RESTART_TO_UPDATE: &str = "restart-to-update";
pub const ABOUT: &str = "about";
pub const SETTINGS: &str = "settings";
pub const QUIT: &str = "quit";

/// The updater state exposed in the menu. Release builds also check automatically; downloading
/// and restarting always require a user action.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(not(tokentracky_release_updater), allow(dead_code))]
pub enum UpdateState {
    /// An unsigned or developer build has no updater configuration at all.
    #[default]
    Disabled,
    Idle,
    Checking,
    Available(String),
    Downloading(String),
    Ready(String),
}

/// `Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1})` for whole numbers: `161`, `12.3K`,
/// `1.2M`. Halves round up, a value that rounds to 1000 of a unit moves to the next (`999,950` is `1M`), and past
/// `T` the integer part grows, grouped from five digits (`10,000T`), as ICU does.
pub fn compact_tokens(tokens: u64) -> String {
    const SUFFIXES: [&str; 5] = ["", "K", "M", "B", "T"];
    if tokens < 1000 {
        return tokens.to_string();
    }
    let mut unit = (tokens.ilog10() / 3).min(4) as usize;
    let tenths = |unit: usize| {
        let divisor = 1000u128.pow(unit as u32);
        (u128::from(tokens) * 10 + divisor / 2) / divisor
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

/// Read-only dropdown lines. `time` formats an ISO timestamp for the user's locale.
pub fn summary_lines(overview: Option<&LocalOverview>, time: impl Fn(&str) -> String) -> Vec<String> {
    let Some(overview) = overview else {
        return vec!["Starting…".into()];
    };
    let totals = &overview.totals;
    let mut lines = vec![
        format!("Today: {} tokens", compact_tokens(totals.today)),
        format!("This week: {}", compact_tokens(totals.week)),
        format!("This month: {}", compact_tokens(totals.month)),
        format!("All time: {}", compact_tokens(totals.all_time)),
    ];
    if let Some(top) = &totals.top_tool {
        lines.push(format!("Top tool this week: {}", top.tool.name()));
    }
    if let Some(rank) = overview.rank {
        let alias = overview.alias.as_deref().filter(|alias| !alias.is_empty());
        lines.push(format!(
            "Rank #{rank} this week{}",
            alias.map(|alias| format!(" as {alias}")).unwrap_or_default()
        ));
    }
    let refresh = &overview.refresh;
    lines.push(if overview.paused {
        "Collection paused".into()
    } else if refresh.refreshing {
        "Refreshing…".into()
    } else if let Some(last) = refresh.last_refresh_at.as_deref() {
        let next = refresh.next_refresh_at.as_deref();
        format!(
            "Refreshed {}{}",
            time(last),
            next.map(|next| format!(" · next {}", time(next))).unwrap_or_default()
        )
    } else {
        "Not refreshed yet".into()
    });
    lines
}

/// The menu-bar title: the chosen period's tokens or cost (Settings › Menu bar), or nothing beside the icon; empty
/// until the first overview. A period with an unpriced model shows its tokens rather than a made-up amount.
pub fn title(overview: Option<&LocalOverview>) -> String {
    let Some(overview) = overview else {
        return String::new();
    };
    let (totals, costs) = (&overview.totals, &overview.totals.costs);
    let (tokens, cost) = match overview.settings.menu_bar_period {
        MenuBarPeriod::Today => (totals.today, costs.today),
        MenuBarPeriod::Week => (totals.week, costs.week),
        MenuBarPeriod::Month => (totals.month, costs.month),
        MenuBarPeriod::All => (totals.all_time, costs.all_time),
    };
    match overview.settings.menu_bar {
        MenuBarShows::Tokens => compact_tokens(tokens),
        MenuBarShows::Cost => cost.map_or_else(|| compact_tokens(tokens), compact_cost),
        MenuBarShows::Icon => String::new(),
    }
}

/// A cost in micro-USD for the menu bar: cents below $1,000, then K, M, B and T as for tokens.
pub fn compact_cost(micro: u64) -> String {
    let cents = (u128::from(micro) + 5_000) / 10_000;
    if cents < 100_000 {
        return format!("${}.{:02}", cents / 100, cents % 100);
    }
    format!(
        "${}",
        compact_tokens(u64::try_from((u128::from(micro) + 500_000) / 1_000_000).unwrap_or(u64::MAX))
    )
}

pub fn tooltip(overview: Option<&LocalOverview>) -> String {
    match overview {
        Some(overview) => format!("Tokentracky: {} tokens today", compact_tokens(overview.totals.today)),
        None => "Tokentracky".into(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// A disabled summary line.
    Line(String),
    Separator,
    Action {
        id: &'static str,
        label: String,
        enabled: bool,
    },
    Check {
        id: &'static str,
        label: &'static str,
        checked: bool,
    },
}

fn action(id: &'static str, label: &str, enabled: bool) -> Entry {
    Entry::Action {
        id,
        label: label.into(),
        enabled,
    }
}

/// "Pause collection", or "Resume collection" while the overview shows collection paused.
fn pause(overview: Option<&LocalOverview>) -> Entry {
    let paused = overview.is_some_and(|overview| overview.paused);
    action(
        PAUSE,
        if paused {
            "Resume collection"
        } else {
            "Pause collection"
        },
        true,
    )
}

fn login(checked: bool) -> Entry {
    Entry::Check {
        id: LOGIN,
        label: "Launch at login",
        checked,
    }
}

/// The signed-update action for `update`; none in a build without the updater.
fn update_action(update: &UpdateState) -> Option<Entry> {
    Some(match update {
        UpdateState::Disabled => return None,
        UpdateState::Idle => action(CHECK_FOR_UPDATES, "Check for updates", true),
        UpdateState::Checking => action(CHECK_FOR_UPDATES, "Checking for updates…", false),
        UpdateState::Available(version) => Entry::Action {
            id: DOWNLOAD_UPDATE,
            label: format!("Download v{version}"),
            enabled: true,
        },
        UpdateState::Downloading(version) => Entry::Action {
            id: DOWNLOAD_UPDATE,
            label: format!("Downloading v{version}…"),
            enabled: false,
        },
        UpdateState::Ready(version) => Entry::Action {
            id: RESTART_TO_UPDATE,
            label: format!("Restart to install v{version}"),
            enabled: true,
        },
    })
}

/// The dropdown: the summary, collection actions, optional signed-update actions, About and Quit.
pub fn entries(
    overview: Option<&LocalOverview>,
    launch_at_login: bool,
    update: &UpdateState,
    time: impl Fn(&str) -> String,
) -> Vec<Entry> {
    let paused = overview.is_some_and(|overview| overview.paused);
    let mut entries: Vec<_> = summary_lines(overview, time).into_iter().map(Entry::Line).collect();
    entries.extend([
        Entry::Separator,
        action(REFRESH, "Refresh now", !paused),
        action(OPEN, "Open dashboard", true),
        pause(overview),
        login(launch_at_login),
    ]);
    if let Some(update) = update_action(update) {
        entries.extend([Entry::Separator, update]);
    }
    entries.extend([
        Entry::Separator,
        action(ABOUT, "About Tokentracky", true),
        action(QUIT, "Quit", true),
    ]);
    entries
}

/// The popover's gear menu: collection, launch at login and the update action, then Settings, About and Quit. The
/// ids are the dropdown's, so one handler serves both; Settings opens the dashboard at `/settings`.
pub fn gear_entries(overview: Option<&LocalOverview>, launch_at_login: bool, update: &UpdateState) -> Vec<Entry> {
    let mut entries = vec![pause(overview), login(launch_at_login)];
    entries.extend(update_action(update));
    entries.extend([
        Entry::Separator,
        action(SETTINGS, "Settings…", true),
        action(ABOUT, "About Tokentracky", true),
        action(QUIT, "Quit Tokentracky", true),
    ]);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokentracky_collector::RefreshStatus;
    use tokentracky_collector::store::{PeriodTotals, TopTool};
    use tokentracky_core::{PeriodCosts, ToolId};
    use tokentracky_local_api::LocalSettings;

    fn overview() -> LocalOverview {
        LocalOverview {
            totals: PeriodTotals {
                today: 1_234_567,
                week: 8_400_000,
                month: 20_149_999,
                all_time: 120_000_000_000,
                top_tool: Some(TopTool {
                    tool: ToolId::Claude,
                    tokens: 8_400_000,
                }),
                costs: PeriodCosts {
                    today: Some(64_800_000),
                    week: Some(729_000_000),
                    month: Some(2_394_000_000),
                    all_time: None,
                },
            },
            rank: Some(10),
            alias: Some("ada".into()),
            paused: false,
            refresh: RefreshStatus {
                last_refresh_at: Some("2026-10-23T14:05:00.000Z".into()),
                next_refresh_at: Some("2026-10-23T15:05:00.000Z".into()),
                refreshing: false,
            },
            settings: LocalSettings::default(),
        }
    }
    fn time(iso: &str) -> String {
        iso[11..16].to_owned()
    }
    fn quiet() -> LocalOverview {
        LocalOverview {
            totals: PeriodTotals {
                top_tool: None,
                ..overview().totals
            },
            rank: None,
            alias: None,
            ..overview()
        }
    }

    #[test]
    fn titles_the_chosen_period_with_its_tokens_or_cost_or_just_the_icon() {
        let shows = |menu_bar, menu_bar_period| {
            title(Some(&LocalOverview {
                settings: LocalSettings {
                    menu_bar,
                    menu_bar_period,
                    ..LocalSettings::default()
                },
                ..overview()
            }))
        };
        assert_eq!(shows(MenuBarShows::Tokens, MenuBarPeriod::Today), "1.2M");
        assert_eq!(shows(MenuBarShows::Tokens, MenuBarPeriod::Week), "8.4M");
        assert_eq!(shows(MenuBarShows::Tokens, MenuBarPeriod::All), "120B");
        assert_eq!(shows(MenuBarShows::Cost, MenuBarPeriod::Today), "$64.80");
        assert_eq!(shows(MenuBarShows::Cost, MenuBarPeriod::Month), "$2.4K");
        assert_eq!(shows(MenuBarShows::Icon, MenuBarPeriod::Today), "");
        // A period with an unpriced model shows its tokens rather than a made-up amount.
        assert_eq!(shows(MenuBarShows::Cost, MenuBarPeriod::All), "120B");
        let cases = [0, 9_994_999, 999_994_999, 999_995_000, 1_250_000_000].map(compact_cost);
        assert_eq!(cases, ["$0.00", "$9.99", "$999.99", "$1K", "$1.3K"]);
    }

    #[test]
    fn formats_compact_token_counts_for_the_menu_bar_title() {
        let cases = [0, 999, 1_234, 12_345, 1_234_567, 2_500_000_000].map(compact_tokens);
        assert_eq!(cases, ["0", "999", "1.2K", "12.3K", "1.2M", "2.5B"]);
    }

    /// Each expected value is what `Intl.NumberFormat` gives in Node 22.
    #[test]
    fn rounds_and_changes_unit_as_intl_does() {
        let cases = [
            (161, "161"),
            (1_000, "1K"),
            (1_049, "1K"),
            (1_050, "1.1K"),
            (1_250, "1.3K"),
            (9_949, "9.9K"),
            (9_950, "10K"),
            (99_950, "100K"),
            (999_499, "999.5K"),
            (999_949, "999.9K"),
            (999_950, "1M"),
            (1_049_999, "1M"),
            (1_200_000, "1.2M"),
            (20_149_999, "20.1M"),
            (999_949_999, "999.9M"),
            (999_950_000, "1B"),
            (120_000_000_000, "120B"),
            (999_950_000_000, "1T"),
            (1_250_000_000_000, "1.3T"),
            (1_000_000_000_000_000, "1000T"),
            (9_007_199_254_740_991, "9007.2T"),
            (10_000_000_000_000_000, "10,000T"),
        ];
        for (tokens, expected) in cases {
            assert_eq!(compact_tokens(tokens), expected, "{tokens}");
        }
    }

    #[test]
    fn lists_totals_top_tool_rank_and_refresh_times() {
        assert_eq!(
            summary_lines(Some(&overview()), time),
            [
                "Today: 1.2M tokens",
                "This week: 8.4M",
                "This month: 20.1M",
                "All time: 120B",
                "Top tool this week: Claude Code",
                "Rank #10 this week as ada",
                "Refreshed 14:05 · next 15:05",
            ]
        );
    }

    #[test]
    fn omits_unpublished_rank_and_an_empty_week_and_reports_pause_refresh_and_first_run() {
        let last = |overview: LocalOverview| summary_lines(Some(&overview), time).pop().unwrap();
        let lines = summary_lines(Some(&quiet()), time);
        assert!(
            !lines
                .iter()
                .any(|line| line.contains("Rank") || line.contains("Top tool"))
        );
        assert_eq!(
            last(LocalOverview {
                paused: true,
                ..quiet()
            }),
            "Collection paused"
        );
        let refreshing = RefreshStatus {
            refreshing: true,
            ..quiet().refresh
        };
        assert_eq!(
            last(LocalOverview {
                refresh: refreshing,
                ..quiet()
            }),
            "Refreshing…"
        );
        let first = RefreshStatus {
            last_refresh_at: None,
            ..quiet().refresh
        };
        assert_eq!(
            last(LocalOverview {
                refresh: first,
                ..quiet()
            }),
            "Not refreshed yet"
        );
        let unnamed = LocalOverview {
            rank: Some(3),
            alias: Some(String::new()),
            ..quiet()
        };
        assert!(summary_lines(Some(&unnamed), time).contains(&"Rank #3 this week".to_owned()));
        assert_eq!(summary_lines(None, time), ["Starting…"]);
    }

    /// `apps/desktop/src/tray.test.ts` and `startup-pause.test.ts`, for the menu's content.
    #[test]
    fn shows_today_in_the_title_and_the_summary_and_actions_in_the_dropdown() {
        let codex = LocalOverview {
            totals: PeriodTotals {
                all_time: 50_000_000,
                top_tool: Some(TopTool {
                    tool: ToolId::Codex,
                    tokens: 8_400_000,
                }),
                ..overview().totals
            },
            rank: Some(3),
            ..overview()
        };
        assert_eq!(title(Some(&codex)), "1.2M");
        assert_eq!(tooltip(Some(&codex)), "Tokentracky: 1.2M tokens today");
        assert_eq!((title(None), tooltip(None)), (String::new(), "Tokentracky".to_owned()));
        let entries = entries(Some(&codex), false, &UpdateState::Disabled, time);
        let label = |entry: &Entry| match entry {
            Entry::Line(text) => text.clone(),
            Entry::Action { label, .. } => label.clone(),
            Entry::Check { label, .. } => (*label).to_owned(),
            Entry::Separator => "-".into(),
        };
        let labels: Vec<_> = entries.iter().map(label).collect();
        for expected in [
            "Today: 1.2M tokens",
            "This week: 8.4M",
            "All time: 50M",
            "Top tool this week: Codex",
            "Rank #3 this week as ada",
            "Refresh now",
            "Open dashboard",
            "Pause collection",
            "Launch at login",
            "About Tokentracky",
            "Quit",
        ] {
            assert!(labels.contains(&expected.to_owned()), "{expected} in {labels:?}");
        }
        assert_eq!(entries[0], Entry::Line("Today: 1.2M tokens".into()));
        assert!(entries.contains(&Entry::Check {
            id: LOGIN,
            label: "Launch at login",
            checked: false
        }));
    }

    #[test]
    fn pausing_disables_refresh_and_offers_resume() {
        let paused = LocalOverview {
            paused: true,
            ..overview()
        };
        let entries = entries(Some(&paused), true, &UpdateState::Disabled, time);
        let action = |id| {
            entries
                .iter()
                .find(|entry| matches!(entry, Entry::Action { id: found, .. } if *found == id))
        };
        assert_eq!(
            action(REFRESH),
            Some(&Entry::Action {
                id: REFRESH,
                label: "Refresh now".into(),
                enabled: false
            })
        );
        assert_eq!(
            action(PAUSE),
            Some(&Entry::Action {
                id: PAUSE,
                label: "Resume collection".into(),
                enabled: true
            })
        );
        // Before the first overview the actions are there, as in Electron, with refresh enabled.
        let starting = super::entries(None, false, &UpdateState::Disabled, time);
        assert_eq!(starting[0], Entry::Line("Starting…".into()));
        assert!(starting.contains(&Entry::Action {
            id: REFRESH,
            label: "Refresh now".into(),
            enabled: true
        }));
    }

    #[test]
    fn release_candidates_keep_native_update_actions_and_development_builds_offer_none() {
        let labels = |state| {
            entries(Some(&overview()), false, &state, time)
                .into_iter()
                .filter_map(|entry| match entry {
                    Entry::Action { label, .. } => Some(label),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert!(
            !labels(UpdateState::Disabled)
                .iter()
                .any(|label| label.contains("update"))
        );
        assert!(labels(UpdateState::Idle).contains(&"Check for updates".into()));
        assert!(labels(UpdateState::Available("0.2.0".into())).contains(&"Download v0.2.0".into()));
        assert!(labels(UpdateState::Ready("0.2.0".into())).contains(&"Restart to install v0.2.0".into()));
    }

    #[test]
    fn the_gear_menu_offers_collection_login_the_update_and_the_app() {
        let action = |id, label: &str| Entry::Action {
            id,
            label: label.into(),
            enabled: true,
        };
        assert_eq!(
            gear_entries(Some(&overview()), true, &UpdateState::Idle),
            [
                action(PAUSE, "Pause collection"),
                Entry::Check {
                    id: LOGIN,
                    label: "Launch at login",
                    checked: true
                },
                action(CHECK_FOR_UPDATES, "Check for updates"),
                Entry::Separator,
                action(SETTINGS, "Settings…"),
                action(ABOUT, "About Tokentracky"),
                action(QUIT, "Quit Tokentracky"),
            ]
        );
        let paused = LocalOverview {
            paused: true,
            ..overview()
        };
        let gear = gear_entries(Some(&paused), false, &UpdateState::Disabled);
        assert_eq!(gear[0], action(PAUSE, "Resume collection"));
        assert_eq!(
            gear[1],
            Entry::Check {
                id: LOGIN,
                label: "Launch at login",
                checked: false
            }
        );
        // No update entry in a build without the updater, as in the tray menu.
        assert_eq!(gear[2], Entry::Separator);
        assert_eq!(gear.len(), 6);
        assert_eq!(
            gear_entries(None, false, &UpdateState::Ready("0.2.0".into()))[2],
            action(RESTART_TO_UPDATE, "Restart to install v0.2.0")
        );
    }
}
