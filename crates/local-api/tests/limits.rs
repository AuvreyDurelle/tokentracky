//! `GET /api/local/limits` (F6, Rust only) through the whole local app: Claude Code's reading from a synthetic
//! `.claude.json` and Codex's from a synthetic rollout, each window's pace, a passed reset reported as reset, no reading
//! for another account, and nothing of `.claude.json` but the window figures in any answer or in the database.
mod support;

use serde_json::{Value, json};
use std::fs;
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

const ACCOUNT: &str = "PRIVATE_ACCOUNT_UUID_0000-1111";
const HOUR: i64 = 3_600_000;

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&Rfc3339).unwrap()
}
fn ms(at: OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}
/// The epoch milliseconds of an ISO time in an answer.
fn time_ms(value: &Value) -> i64 {
    ms(OffsetDateTime::parse(value.as_str().unwrap(), &Rfc3339).unwrap())
}
fn near(value: &Value, expected: f64, within: f64) -> bool {
    value.as_f64().is_some_and(|value| (value - expected).abs() <= within)
}

/// A synthetic `.claude.json`: a reading fetched an hour before `now` for `cached`, signed in to `current`, among
/// settings and sign-in details marked `PRIVATE_`. Its five-hour window is three hours in and 30% used; its week reset a
/// minute before `now`.
fn claude_config(now: OffsetDateTime, cached: &str, current: &str) -> Value {
    json!({
        "userID": "PRIVATE_USER_ID",
        "oauthAccount": {"accountUuid": current, "emailAddress": "PRIVATE_EMAIL@example.com", "organizationName": "PRIVATE_ORGANIZATION"},
        "projects": {"/Users/PRIVATE_USER/code": {"history": [{"display": "PRIVATE_PROMPT"}]}},
        "cachedUsageUtilization": {
            "fetchedAtMs": ms(now - Duration::hours(1)),
            "accountUuid": cached,
            "utilization": {
                "five_hour": {"utilization": 30, "resets_at": rfc3339(now + Duration::hours(2))},
                "seven_day": {"utilization": 64, "resets_at": rfc3339(now - Duration::minutes(1))},
                "seven_day_opus": null,
                "limits": [{"kind": "weekly_scoped", "percent": 7, "scope": {"model": {"display_name": "PRIVATE_MODEL"}}}],
                "extra_usage": {"monthly_limit": "PRIVATE_SPEND"},
            },
        },
    })
}
/// A synthetic rollout whose last record, ten minutes before `now`, is a rate-limit notification: its five-hour window
/// three hours in and 90% used, its week unused.
fn rollout(now: OffsetDateTime) -> String {
    let at = rfc3339(now - Duration::minutes(10));
    let five_hours = (now + Duration::hours(2)).unix_timestamp();
    let week = (now + Duration::days(3)).unix_timestamp();
    [
        json!({"timestamp": at, "type": "session_meta", "payload": {"id": "limits", "cwd": "/synthetic/codex", "instructions": "PRIVATE_PROMPT"}}),
        json!({"timestamp": at, "type": "event_msg", "payload": {"type": "token_count",
            "info": {"total_token_usage": {"input_tokens": 100, "output_tokens": 10}, "last_token_usage": {"input_tokens": 100, "output_tokens": 10}},
            "rate_limits": null}}),
        json!({"timestamp": at, "type": "event_msg", "payload": {"type": "token_count", "info": null, "rate_limits": {
            "limit_id": "codex", "limit_name": "PRIVATE_LIMIT_NAME", "credits": {"balance": "PRIVATE_BALANCE"}, "plan_type": "plus",
            "primary": {"used_percent": 90.0, "window_minutes": 300, "resets_at": five_hours},
            "secondary": {"used_percent": 0.0, "window_minutes": 10080, "resets_at": week}}}}),
    ]
    .iter()
    .map(|record| format!("{record}\n"))
    .collect()
}

async fn limits(server: &Server) -> Value {
    let reply = server.get("/api/local/limits").await;
    assert_eq!(reply.status, 200, "{}", reply.text);
    reply.json()
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

#[tokio::test]
async fn answers_each_tools_reading_with_its_pace_and_a_passed_reset_as_reset() {
    let home = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(home.path()).unwrap();
    let (projects, sessions) = (home.join(".claude/projects"), home.join(".codex/sessions"));
    fs::create_dir_all(&projects).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    let config = home.join(".claude.json");
    let (server, app) = Server::local(|options| options.claude_config_file = Some(config.clone())).await;
    let empty = json!({"tools": [{"tool": "claude", "asOf": null, "windows": []}, {"tool": "codex", "asOf": null, "windows": []}]});
    assert_eq!(limits(&server).await, empty);

    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    fs::write(&config, claude_config(now, ACCOUNT, ACCOUNT).to_string()).unwrap();
    fs::write(sessions.join("rollout.jsonl"), rollout(now)).unwrap();
    for (tool, folder) in [("claude", &projects), ("codex", &sessions)] {
        let body = json!({"enabled": true, "paths": [folder]});
        let reply = server
            .request(&format!("/api/local/sources/{tool}"), Init::method("PUT").json(body))
            .await;
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    assert_eq!(
        server.request("/api/local/refresh", Init::method("POST")).await.status,
        200
    );
    let answer = limits(&server).await;
    let [claude, codex] = [&answer["tools"][0], &answer["tools"][1]];
    assert_eq!((&claude["tool"], &codex["tool"]), (&json!("claude"), &json!("codex")));
    assert_eq!(time_ms(&claude["asOf"]), ms(now) - HOUR);
    assert_eq!(time_ms(&codex["asOf"]), ms(now) - HOUR / 6);

    // Claude Code: 30% three hours into five is 10% an hour, so 50% at the reset; the week reset a minute ago.
    let (five, week) = (&claude["windows"][0], &claude["windows"][1]);
    assert_eq!(claude["windows"].as_array().unwrap().len(), 2);
    assert_eq!(
        (
            &five["name"],
            &five["usedPercent"],
            &five["windowMinutes"],
            &five["reset"]
        ),
        (&json!("five_hour"), &json!(30.0), &json!(300), &json!(false))
    );
    assert_eq!(time_ms(&five["resetsAt"]), ms(now) + 2 * HOUR);
    // The answer is computed a moment after `now`.
    assert!(
        near(&five["evenPercent"], 60.0, 0.1) && near(&five["projectedPercent"], 50.0, 0.1),
        "{five}"
    );
    assert_eq!(five["runsOutInMs"], Value::Null);
    assert_eq!(
        (
            &week["name"],
            &week["usedPercent"],
            &week["reset"],
            &week["evenPercent"],
            &week["projectedPercent"],
            &week["runsOutInMs"]
        ),
        (
            &json!("seven_day"),
            &json!(0.0),
            &json!(true),
            &Value::Null,
            &Value::Null,
            &Value::Null
        )
    );
    assert_eq!(time_ms(&week["resetsAt"]), ms(now) - 60_000);

    // Codex: 90% three hours in runs out in twenty minutes; an unused week projects 0% and never runs out.
    let (primary, secondary) = (&codex["windows"][0], &codex["windows"][1]);
    assert_eq!(
        (&primary["name"], &primary["usedPercent"], &primary["reset"]),
        (&json!("primary"), &json!(90.0), &json!(false))
    );
    assert!(near(&primary["projectedPercent"], 100.0, 1e-9), "{primary}");
    assert!(near(&primary["runsOutInMs"], 20.0 * 60_000.0, 2_000.0), "{primary}");
    assert_eq!(
        (
            &secondary["name"],
            &secondary["windowMinutes"],
            &secondary["projectedPercent"],
            &secondary["runsOutInMs"]
        ),
        (&json!("secondary"), &json!(10_080), &json!(0.0), &Value::Null)
    );
    assert!(near(&secondary["evenPercent"], 400.0 / 7.0, 0.1), "{secondary}");

    // Signed in to another account: Claude Code has no reading; Codex keeps its own.
    fs::write(
        &config,
        claude_config(now, ACCOUNT, "PRIVATE_OTHER_ACCOUNT").to_string(),
    )
    .unwrap();
    assert_eq!(
        server.request("/api/local/refresh", Init::method("POST")).await.status,
        200
    );
    let answer = limits(&server).await;
    assert_eq!(answer["tools"][0], empty["tools"][0]);
    // The same reading; its pace has moved on with the clock.
    let reading = |tool: &Value| {
        let windows = tool["windows"].as_array().unwrap().iter();
        let figures = |window: &Value| {
            ["name", "usedPercent", "windowMinutes", "resetsAt", "reset"].map(|key| window[key].clone())
        };
        (tool["asOf"].clone(), windows.map(figures).collect::<Vec<_>>())
    };
    assert_eq!(reading(&answer["tools"][1]), reading(codex));
    expect_error(
        &server.get("/api/local/limits?tool=claude").await,
        400,
        "INVALID_REQUEST",
    );

    // Nothing of `.claude.json` but its figures, and nothing of the snapshots but theirs, in any answer.
    fs::write(&config, claude_config(now, ACCOUNT, ACCOUNT).to_string()).unwrap();
    assert_eq!(
        server.request("/api/local/refresh", Init::method("POST")).await.status,
        200
    );
    for path in [
        "/api/local/limits",
        "/api/local/status",
        "/api/local/summary?days=7",
        "/api/local/sessions?days=7",
        "/api/local/breakdown?days=7",
        "/api/local/projects?days=7",
        "/api/local/export?days=7",
    ] {
        let reply = server.get(path).await;
        assert_eq!(reply.status, 200, "{path}: {}", reply.text);
        for private in ["PRIVATE_", "example.com", "weekly_scoped", "plus"] {
            assert!(!reply.text.contains(private), "{path} {private}: {}", reply.text);
        }
    }
    // Nor in the database, once closed.
    let Server { web_root, .. } = server;
    assert_eq!(app.state().store.lock().unwrap().limits().unwrap().len(), 2);
    app.close().await.unwrap();
    let database = fs::read(web_root.path().join("data").join("usage.sqlite")).unwrap();
    for private in ["PRIVATE_", "example.com", "weekly_scoped", "codex_"] {
        assert!(!contains(&database, private), "{private}");
    }
}
