//! Local days (F3, roadmap step 9): queries and period totals in an IANA time zone, a local day's tokens by half
//! hour, and the cache of period totals. Rust-only: the TypeScript store has no zones, and without one every query
//! keeps its UTC days (the golden cases).
use jiff::tz::TimeZone;
use serde_json::json;
use std::path::Path;
use time::OffsetDateTime;
use time::macros::datetime;
use tokentracky_collector::store::{FileCheckpoint, QueryOptions, UsageStore};
use tokentracky_core::{TokenCounts, ToolId, UsageEvent};

fn zone(name: &str) -> TimeZone {
    TimeZone::get(name).unwrap()
}
/// A Claude Code event of `tokens` input tokens at `at`.
fn event(id: &str, at: &str, tokens: u64) -> UsageEvent {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/claude/cache-categories-disjoint/expected/events.json");
    let events: Vec<UsageEvent> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    UsageEvent {
        event_id: id.to_owned(),
        occurred_at: Some(at.to_owned()),
        tokens: TokenCounts {
            input: tokens,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            reasoning: None,
            cache_write_1h: None,
        },
        ..events[0].clone()
    }
}
fn store(events: &[UsageEvent]) -> UsageStore {
    let mut store = UsageStore::open(":memory:").unwrap();
    let checkpoint = FileCheckpoint {
        path: "/authorized/session.jsonl".to_owned(),
        tool: ToolId::Claude,
        identity: "1:2".to_owned(),
        offset: 0,
        prefix_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
        parser_version: 1,
        state: json!({"sessionId": null, "project": null, "model": "unknown", "turnId": null, "previous": null, "baselines": [], "seenDeltaIds": []}),
        diagnostics: Vec::new(),
        file_size: None,
        mtime_ms: None,
        ctime_ms: None,
    };
    store.commit_file(&checkpoint, events, true).unwrap();
    store
}
/// Inclusive days `from` to `to`, in `tz` when given.
fn days(from: &str, to: &str, tz: Option<&str>) -> QueryOptions {
    QueryOptions {
        from: Some(from.to_owned()),
        to: Some(to.to_owned()),
        tz: tz.map(zone),
        ..QueryOptions::default()
    }
}
/// `summary.daily` as `[day, tokens]` pairs.
fn daily(store: &UsageStore, options: &QueryOptions) -> Vec<(String, u64)> {
    let summary = store.summary(options).unwrap();
    summary.daily.into_iter().map(|day| (day.day, day.tokens)).collect()
}
fn pairs(expected: &[(&str, u64)]) -> Vec<(String, u64)> {
    expected.iter().map(|&(day, tokens)| (day.to_owned(), tokens)).collect()
}
/// One event of one token at the top of every UTC hour from `from` for `hours` hours.
fn hourly(from: OffsetDateTime, hours: i64) -> Vec<UsageEvent> {
    (0..hours)
        .map(|hour| {
            let at = from + time::Duration::hours(hour);
            let at = at.format(&time::format_description::well_known::Rfc3339).unwrap();
            event(&format!("hour-{hour}"), &at, 1)
        })
        .collect()
}

#[test]
fn an_event_at_2330_utc_is_the_next_day_in_tokyo_and_the_same_day_in_new_york() {
    let store = store(&[event("late", "2026-10-20T23:30:00.000Z", 5)]);
    let range = |tz| days("2026-10-19", "2026-10-22", tz);
    assert_eq!(daily(&store, &range(None)), pairs(&[("2026-10-20", 5)]));
    assert_eq!(daily(&store, &range(Some("Asia/Tokyo"))), pairs(&[("2026-10-21", 5)]));
    assert_eq!(
        daily(&store, &range(Some("America/New_York"))),
        pairs(&[("2026-10-20", 5)])
    );
    // `from`/`to` name local days.
    let tokens = |from, to, tz| store.summary(&days(from, to, tz)).unwrap().tokens;
    assert_eq!(tokens("2026-10-21", "2026-10-21", Some("Asia/Tokyo")), 5);
    assert_eq!(tokens("2026-10-20", "2026-10-20", Some("Asia/Tokyo")), 0);
    assert_eq!(tokens("2026-10-20", "2026-10-20", Some("America/New_York")), 5);
    assert_eq!(tokens("2026-10-21", "2026-10-21", Some("America/New_York")), 0);
    let breakdown = store.breakdown(&range(Some("Asia/Tokyo"))).unwrap();
    assert_eq!(
        breakdown.iter().map(|row| row.day.as_str()).collect::<Vec<_>>(),
        ["2026-10-21"]
    );
    // The CSV keeps its UTC timestamps whatever the zone.
    let csv = store.export_csv(&range(Some("Asia/Tokyo"))).unwrap();
    assert!(csv.contains("\"2026-10-20T23:30:00.000Z\""), "{csv}");
}

#[test]
fn a_range_across_a_daylight_saving_change_loses_and_duplicates_no_hours() {
    // Europe/London leaves summer time at 01:00 UTC on 25 October 2026, so that local day has 25 hours: 23:00 UTC on
    // the 24th to midnight UTC on the 26th. One event every UTC hour from 20:00 on the 24th to 03:00 on the 26th.
    let autumn = store(&hourly(datetime!(2026-10-24 20:00 UTC), 32));
    let london = days("2026-10-24", "2026-10-26", Some("Europe/London"));
    assert_eq!(autumn.summary(&london).unwrap().tokens, 32);
    assert_eq!(
        daily(&autumn, &london),
        pairs(&[("2026-10-24", 3), ("2026-10-25", 25), ("2026-10-26", 4)])
    );
    let series = autumn.day_series("2026-10-25", &zone("Europe/London")).unwrap();
    assert_eq!(series.start, "2026-10-24T23:00:00.000Z");
    assert_eq!(series.half_hours.len(), 50);
    assert_eq!(series.half_hours.iter().sum::<u64>(), 25);
    // Each event opens a half hour: every even slot has one, every odd slot none.
    assert!(series.half_hours.iter().step_by(2).all(|&tokens| tokens == 1));
    assert!(series.half_hours.iter().skip(1).step_by(2).all(|&tokens| tokens == 0));

    // Summer time starts at 01:00 UTC on 29 March 2026: a 23-hour day. One event every UTC hour from midnight on the
    // 28th to 22:00 UTC (23:00 BST) on the 30th.
    let spring = store(&hourly(datetime!(2026-03-28 00:00 UTC), 71));
    let series = spring.day_series("2026-03-29", &zone("Europe/London")).unwrap();
    assert_eq!(
        (series.start.as_str(), series.half_hours.len()),
        ("2026-03-29T00:00:00.000Z", 46)
    );
    let london = days("2026-03-28", "2026-03-30", Some("Europe/London"));
    assert_eq!(spring.summary(&london).unwrap().tokens, 71);
    assert_eq!(
        daily(&spring, &london),
        pairs(&[("2026-03-28", 24), ("2026-03-29", 23), ("2026-03-30", 24)])
    );
    assert_eq!(series.half_hours.iter().sum::<u64>(), 23);
    // America/Santiago skips midnight: summer time starts at 00:00 on Sunday 6 September 2026, so that day starts at
    // 01:00 (04:00 UTC) and has 23 hours.
    let skipped = spring.day_series("2026-09-06", &zone("America/Santiago")).unwrap();
    assert_eq!(
        (skipped.start.as_str(), skipped.half_hours.len()),
        ("2026-09-06T04:00:00.000Z", 46)
    );
}

#[test]
fn a_quarter_hour_zone_starts_its_half_hours_at_its_own_midnight() {
    // Asia/Kathmandu is +05:45: 21 October starts at 18:15 UTC on the 20th.
    let store = store(&[
        event("before", "2026-10-20T18:14:59.999Z", 1),
        event("first", "2026-10-20T18:15:00.000Z", 10),
        event("still-first", "2026-10-20T18:44:59.999Z", 100),
        event("second", "2026-10-20T18:45:00.000Z", 1000),
        event("last", "2026-10-21T18:14:59.999Z", 10000),
    ]);
    let kathmandu = zone("Asia/Kathmandu");
    let series = store.day_series("2026-10-21", &kathmandu).unwrap();
    assert_eq!(series.start, "2026-10-20T18:15:00.000Z");
    assert_eq!(series.half_hours.len(), 48);
    assert_eq!(
        (series.half_hours[0], series.half_hours[1], series.half_hours[47]),
        (110, 1000, 10000)
    );
    let day = days("2026-10-21", "2026-10-21", Some("Asia/Kathmandu"));
    assert_eq!(
        series.half_hours.iter().sum::<u64>(),
        store.summary(&day).unwrap().tokens
    );
    assert_eq!(store.summary(&day).unwrap().tokens, 11110);
}

#[test]
fn todays_half_hours_sum_to_todays_total() {
    let now = datetime!(2026-10-25 15:10 UTC);
    let store = store(&[
        event("yesterday", "2026-10-24T22:59:59.000Z", 1),
        event("midnight", "2026-10-24T23:00:00.000Z", 2),
        event("repeated-hour", "2026-10-25T01:30:00.000Z", 4),
        event("afternoon", "2026-10-25T15:00:00.000Z", 8),
    ]);
    let london = zone("Europe/London");
    let today = store.period_totals(now, Some(&london)).unwrap().today;
    let series = store.day_series("2026-10-25", &london).unwrap();
    assert_eq!((today, series.half_hours.iter().sum::<u64>()), (14, 14));
    // 01:30 UTC is the second 01:30 of the morning in London, two and a half hours after midnight BST.
    assert_eq!(
        (series.half_hours[0], series.half_hours[5], series.half_hours[32]),
        (2, 4, 8)
    );
}

#[test]
fn period_totals_follow_the_zone_and_its_cache_follows_the_zone_and_the_local_day() {
    // 15:30 UTC on Sunday 25 October is 00:30 on Monday 26 October in Tokyo.
    let now = datetime!(2026-10-25 15:30 UTC);
    let store = store(&[
        event("tokyo-monday", "2026-10-25T15:10:00.000Z", 1),
        event("tokyo-sunday", "2026-10-25T14:00:00.000Z", 10),
        event("tokyo-october", "2026-09-30T16:00:00.000Z", 100),
        event("utc-monday", "2026-10-19T00:30:00.000Z", 1000),
    ]);
    let tokyo = zone("Asia/Tokyo");
    let totals = |now, tz| {
        let totals = store.period_totals(now, tz).unwrap();
        (totals.today, totals.week, totals.month, totals.all_time)
    };
    let epoch = store.usage_epoch();
    // UTC: today and this week (from Monday 19 October) hold everything in October.
    assert_eq!(totals(now, None), (11, 1011, 1011, 1111));
    // Tokyo: Monday 26 October starts a week; the month includes 1 October at 01:00.
    assert_eq!(totals(now, Some(&tokyo)), (1, 1, 1111, 1111));
    assert_eq!(totals(now, None), (11, 1011, 1011, 1111));
    // An hour earlier it is still Sunday in Tokyo, though the UTC day is the same.
    let sunday = datetime!(2026-10-25 14:30 UTC);
    assert_eq!(totals(sunday, Some(&tokyo)), (10, 1011, 1111, 1111));
    assert_eq!(totals(now, Some(&tokyo)), (1, 1, 1111, 1111));
    assert_eq!(
        store.usage_epoch(),
        epoch,
        "nothing was written, so only the zone and day keyed the cache"
    );
    let top = store.period_totals(now, Some(&tokyo)).unwrap().top_tool.unwrap();
    assert_eq!((top.tool, top.tokens), (ToolId::Claude, 1));
}

#[test]
fn summaries_count_streaks_and_today_in_the_zone() {
    // 23:30 UTC on 25 October is 08:30 on the 26th in Tokyo.
    let now = datetime!(2026-10-25 23:30 UTC);
    let store = store(&[event("saturday-night", "2026-10-24T14:00:00.000Z", 7)]);
    let activity = |tz: Option<&str>| {
        let options = QueryOptions {
            days: Some(7),
            tz: tz.map(zone),
            now: Some(now),
            ..QueryOptions::default()
        };
        json!(store.summary(&options).unwrap().activity)
    };
    // UTC: the 24th was yesterday, so the streak is alive. Tokyo: the 24th (23:00 there) was two days ago.
    assert_eq!(activity(None)["currentStreak"], 1);
    assert_eq!(activity(None)["bestDay"], json!({"day": "2026-10-24", "tokens": 7}));
    assert_eq!(activity(Some("Asia/Tokyo"))["currentStreak"], 0);
    assert_eq!(
        activity(Some("Asia/Tokyo"))["bestDay"],
        json!({"day": "2026-10-24", "tokens": 7})
    );
    // A rolling window is the same instants in any zone; the previous period of it too.
    let previous = |tz: Option<&str>| {
        let options = QueryOptions {
            days: Some(1),
            offset: Some(1),
            tz: tz.map(zone),
            now: Some(now),
            ..QueryOptions::default()
        };
        store.summary(&options).unwrap().tokens
    };
    assert_eq!((previous(None), previous(Some("Asia/Tokyo"))), (7, 7));
}

#[test]
fn a_day_series_refuses_a_day_that_is_not_a_date() {
    let store = store(&[]);
    for day in ["2026-02-30", "today", "2026-1-1"] {
        let error = store.day_series(day, &zone("Europe/London")).err().unwrap();
        assert_eq!(error.to_string(), "invalid_query_range", "{day}");
    }
    let empty = store.day_series("2026-10-21", &zone("Asia/Tokyo")).unwrap();
    assert_eq!(
        json!(empty),
        json!({"start": "2026-10-20T15:00:00.000Z", "halfHours": vec![0; 48]})
    );
}

#[test]
fn a_summary_adds_its_tokens_up_by_hour_of_day_in_utc_or_the_zone() {
    // 22:10 and 23:50 UTC on two days, and 06:00 UTC: in Kathmandu (+05:45) 03:55, 05:35 and 11:45.
    let store = store(&[
        event("late", "2026-10-20T22:10:00.000Z", 1),
        event("later", "2026-10-21T23:50:00.000Z", 10),
        event("late-again", "2026-10-21T22:59:59.999Z", 100),
        event("morning", "2026-10-21T06:00:00.000Z", 1000),
    ]);
    let utc = store.summary(&days("2026-10-20", "2026-10-21", None)).unwrap().by_hour;
    assert_eq!(utc.len(), 24);
    assert_eq!((utc[22], utc[23], utc[6]), (101, 10, 1000));
    assert_eq!(utc.iter().sum::<u64>(), 1111);
    let kathmandu = store
        .summary(&days("2026-10-20", "2026-10-22", Some("Asia/Kathmandu")))
        .unwrap()
        .by_hour;
    assert_eq!(
        (kathmandu[3], kathmandu[4], kathmandu[5], kathmandu[11]),
        (1, 100, 10, 1000)
    );
}

#[test]
fn a_session_starts_at_the_quarter_hour_of_its_first_event_in_the_query() {
    let store = store(&[
        event("first", "2026-10-20T09:07:00.000Z", 1),
        event("middle", "2026-10-20T12:30:00.000Z", 1),
        event("last", "2026-10-20T15:49:00.000Z", 1),
    ]);
    let sessions = store.sessions(&days("2026-10-20", "2026-10-20", None)).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        (sessions[0].started_at.as_deref(), sessions[0].last_used_at.as_deref()),
        (Some("2026-10-20T09:00:00.000Z"), Some("2026-10-20T15:49:00.000Z"))
    );
}
