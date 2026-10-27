//! The assertions of `tests/contract/health.test.ts` (`GET /api/health`), `cloud-unconfigured.test.ts` and
//! `cloud-stub.test.ts` for the routes this crate owns, against the assembled router and a recording stand-in for the
//! hosted API. Where the contract scans synthetic logs, these tests commit the same events to the store; status
//! fields come from `CloudSync` as `/api/local/status` reports them. Each test runs its steps in order on one server.
mod support;

use serde_json::{Map, Value, json};
use support::*;
use tokentracky_core::CostParts;

/// A link body with no hosted service that could answer.
fn link_body(change: Value) -> Value {
    let mut body = json!({"url": "https://hosted.example", "deviceToken": "t".repeat(32), "historyStart": null, "shareTools": false, "shareCost": false});
    merge(&mut body, change);
    body
}

/// `{...base, ...change}`, where a `null` in `change` stands for `undefined` and removes the key.
fn merge(base: &mut Value, change: Value) {
    let base = base.as_object_mut().unwrap();
    for (key, value) in change.as_object().unwrap() {
        if value.is_null() {
            base.remove(key);
        } else {
            base.insert(key.clone(), value.clone());
        }
    }
}

fn put(json: Value) -> Init {
    Init::method("PUT").json(json)
}

#[tokio::test]
async fn health_describes_a_local_server_with_no_hosted_service_and_no_sign_in() {
    let server = Server::start(None, true).await;
    let reply = server.get("/api/health").await;
    assert_eq!(reply.status, 200);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    let body = reply.json();
    let version = body["version"].as_str().unwrap();
    let mut parts = version.splitn(3, '.');
    assert!((0..3).all(|_| {
        parts
            .next()
            .is_some_and(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()))
    }));
    assert_eq!(
        body,
        json!({"mode": "local", "authConfigured": false, "version": version, "cloudUrl": null, "supabaseUrl": null, "supabaseAnonKey": null, "authProviders": []})
    );
}

#[tokio::test]
async fn with_no_hosted_service_configured() {
    let server = Server::start(None, true).await;

    // The proxies answer 503 CLOUD_UNAVAILABLE, before they look at the query.
    for path in [
        "/api/leaderboard",
        "/api/leaderboard?period=all",
        "/api/leaderboard?period=month&tool=claude&page=2",
        "/api/profiles/someone",
        "/api/profiles/someone?period=all",
        "/api/profiles/a%2Fb",
        "/api/profiles/%E2%9C%93",
        "/api/profiles/someone/stats",
        "/api/profiles/a%2Fb/stats",
        "/api/leaderboard?period=nonsense&extra=1",
    ] {
        expect_error(&server.get(path).await, 503, "CLOUD_UNAVAILABLE");
    }
    // Nothing else of the hosted API is proxied (but `/api/community`, which only the Rust server proxies).
    for path in ["/api/account", "/api/device-policy", "/badge/someone.svg"] {
        expect_error(&server.get(path).await, 404, "NOT_FOUND");
    }

    // Device connection: 503 to start, 409 CONNECT_NOT_STARTED to poll.
    expect_error(
        &server.request("/api/local/connect", Init::method("POST")).await,
        503,
        "CLOUD_UNAVAILABLE",
    );
    let empty = Init::method("POST").json(json!({}));
    expect_error(
        &server.request("/api/local/connect", empty).await,
        503,
        "CLOUD_UNAVAILABLE",
    );
    let poll = Init::method("POST");
    expect_error(
        &server.request("/api/local/connect/poll", poll).await,
        409,
        "CONNECT_NOT_STARTED",
    );

    // Sync and unlink with nothing linked.
    expect_error(
        &server.request("/api/local/sync", Init::method("POST")).await,
        409,
        "CLOUD_NOT_LINKED",
    );
    for _ in 0..2 {
        let reply = server.request("/api/local/cloud", Init::method("DELETE")).await;
        assert_eq!((reply.status, reply.text.as_str()), (204, ""));
    }
    let status = server.status().await;
    assert_eq!(
        (
            &status["cloudLinked"],
            &status["alias"],
            &status["lastSyncAt"],
            &status["syncError"]
        ),
        (&json!(false), &Value::Null, &Value::Null, &Value::Null)
    );
    let health = server.get("/api/health").await.json();
    assert_eq!((&health["mode"], &health["cloudUrl"]), (&json!("local"), &Value::Null));

    // PUT /api/local/cloud: 400 INVALID_REQUEST for a body that is not an object, or has a field it does not know.
    for body in [
        json!([]),
        json!("link"),
        json!(7),
        Value::Null,
        link_body(json!({"extra": true})),
        link_body(json!({"generation": "x"})),
    ] {
        expect_error(
            &server.request("/api/local/cloud", put(body)).await,
            400,
            "INVALID_REQUEST",
        );
    }
    expect_error(
        &server.request("/api/local/cloud", Init::method("PUT")).await,
        400,
        "INVALID_REQUEST",
    );

    // 400 INVALID_LINK unless the token is 20 to 256 characters without whitespace and the choices are booleans,
    // checked before the URL and the history.
    let token = "t".repeat(20);
    let invalid_links = [
        json!({"deviceToken": null}),
        json!({"deviceToken": "t".repeat(19)}),
        json!({"deviceToken": "t".repeat(257)}),
        json!({"deviceToken": format!("{token} {token}")}),
        json!({"deviceToken": format!("{token}\n")}),
        json!({"deviceToken": 1_234_567_890}),
        json!({"shareTools": null}),
        json!({"shareTools": "yes"}),
        json!({"shareTools": 1}),
        json!({"shareCost": null}),
        json!({"shareModels": "yes"}),
        json!({"shareModels": 1}),
        json!({"deviceToken": "short", "url": "not a url", "historyStart": "never"}),
    ];
    for change in invalid_links {
        expect_error(
            &server.request("/api/local/cloud", put(link_body(change))).await,
            400,
            "INVALID_LINK",
        );
    }
    // A `null` above stands for `undefined`; the contract's `shareCost: null` is a JSON null.
    let mut null_cost = link_body(json!({}));
    null_cost["shareCost"] = Value::Null;
    expect_error(
        &server.request("/api/local/cloud", put(null_cost)).await,
        400,
        "INVALID_LINK",
    );

    // 400 INVALID_CLOUD_URL unless the URL is the HTTPS origin of the service (loopback HTTP is allowed).
    let urls = [
        Value::Null,
        json!(7),
        json!(""),
        json!("not a url"),
        json!("hosted.example"),
        json!("http://hosted.example"),
        json!("ftp://hosted.example"),
        json!("https://user@hosted.example"),
        json!("https://user:secret@hosted.example"),
        json!("https://hosted.example/path"),
        json!("https://hosted.example/api"),
        json!("https://hosted.example/?a=1"),
        json!("https://hosted.example/#section"),
        json!("javascript:alert(1)"),
        json!("http://127.0.0.1.hosted.example"),
    ];
    let mut missing = link_body(json!({}));
    missing.as_object_mut().unwrap().remove("url");
    expect_error(
        &server.request("/api/local/cloud", put(missing)).await,
        400,
        "INVALID_CLOUD_URL",
    );
    for url in urls {
        let mut body = link_body(json!({}));
        body["url"] = url;
        expect_error(
            &server.request("/api/local/cloud", put(body)).await,
            400,
            "INVALID_CLOUD_URL",
        );
    }

    // 400 INVALID_HISTORY unless the history start is null or a UTC day no later than today.
    let days = [
        json!(""),
        json!("yesterday"),
        json!("2026-02-30"),
        json!("2026-13-01"),
        json!("2026-1-1"),
        json!("2999-01-01"),
        json!("2999-01-01T00:00:00.000Z"),
        json!(20_261_020),
        json!(true),
        json!("2026-10-20T12:00:00.000Z"),
        json!("2026-10-20T00:00:00+02:00"),
        json!({"day": "2026-10-20"}),
    ];
    let mut missing = link_body(json!({}));
    missing.as_object_mut().unwrap().remove("historyStart");
    expect_error(
        &server.request("/api/local/cloud", put(missing)).await,
        400,
        "INVALID_HISTORY",
    );
    for day in days {
        let mut body = link_body(json!({}));
        body["historyStart"] = day;
        expect_error(
            &server.request("/api/local/cloud", put(body)).await,
            400,
            "INVALID_HISTORY",
        );
    }

    // 413 INVALID_REQUEST for a body over 4 KiB.
    let large = put(link_body(json!({"deviceToken": "t".repeat(5000)})));
    expect_error(&server.request("/api/local/cloud", large).await, 413, "INVALID_REQUEST");

    // The device stays unlinked after every refused request.
    assert_eq!(server.status().await["cloudLinked"], json!(false));
    expect_error(
        &server.request("/api/local/sync", Init::method("POST")).await,
        409,
        "CLOUD_NOT_LINKED",
    );
    // Nothing linked records no sync error (the third quirk of tests/contract/README.md).
    assert_eq!(server.status().await["syncError"], Value::Null);
}

const NOT_FOUND: &str = r#"{"error":{"code":"NOT_FOUND","message":"Not found."}}"#;

#[tokio::test]
async fn leaderboard_profile_and_profile_stats_proxies() {
    let stub = Stub::start().await;
    let server = Server::start(Some(&stub.url), true).await;

    // Reports the configured hosted service in the health.
    let health = server.get("/api/health").await.json();
    assert_eq!(
        health,
        json!({"mode": "local", "authConfigured": false, "version": health["version"], "cloudUrl": stub.url, "supabaseUrl": null, "supabaseAnonKey": null, "authProviders": []})
    );

    // Relays the hosted answer unchanged, sending only the query and no credentials of the local session.
    let board = json!({"items": [{"alias": "someone", "rank": 1, "tokens": 12, "daily": [0, 12]}], "total": 1, "page": 2, "pageSize": 20,
        "totalTokens": 9007199254740991_u64, "exactAggregates": {"totalTokens": "1208925819614629174706176", "toolTotals": {"claude": "1208925819614629174706176"}}});
    stub.answer("GET /api/leaderboard", Answer::json(board.clone()));
    let reply = server
        .get("/api/leaderboard?period=all&tool=claude&page=2&q=some%20one")
        .await;
    assert_eq!(reply.status, 200);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    assert_eq!(reply.json(), board);
    let call = &stub.to("GET /api/leaderboard")[0];
    let query: Map<String, Value> = call
        .query
        .iter()
        .map(|(key, value)| (key.clone(), json!(value)))
        .collect();
    assert_eq!(
        Value::Object(query),
        json!({"period": "all", "tool": "claude", "page": "2", "q": "some one"})
    );
    assert_eq!(call.header("accept"), Some("application/json"));
    assert_eq!((call.header("cookie"), call.header("authorization")), (None, None));

    // Relays a profile by alias, with the alias escaped in the path.
    let profile = json!({"alias": "builder_1", "rank": 3, "tokens": 99, "daily": []});
    stub.answer("GET /api/profiles/builder_1", Answer::json(profile.clone()));
    assert_eq!(server.get("/api/profiles/builder_1?period=week").await.json(), profile);
    let query = &stub.to("GET /api/profiles/builder_1")[0].query;
    assert_eq!(
        (query.len(), query.get("period").map(String::as_str)),
        (1, Some("week"))
    );
    stub.answer("GET /api/profiles/x%20y", Answer::json(profile.clone()));
    assert_eq!(server.get("/api/profiles/x%20y").await.json(), profile);

    // Relays profile stats by alias, with the alias escaped, forwarding only single-valued query parameters.
    let stats = json!({"alias": "builder_1", "periods": {"week": {"rank": 3, "tokens": 99}, "month": {"rank": 2, "tokens": 120}, "all": {"rank": 1, "tokens": 400}}});
    stub.answer("GET /api/profiles/builder_1/stats", Answer::json(stats.clone()));
    let reply = server.get("/api/profiles/builder_1/stats").await;
    assert_eq!(reply.status, 200);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    assert_eq!(reply.json(), stats);
    let call = &stub.to("GET /api/profiles/builder_1/stats")[0];
    assert!(call.query.is_empty());
    assert_eq!(call.header("accept"), Some("application/json"));
    assert_eq!((call.header("cookie"), call.header("authorization")), (None, None));
    let reply = server
        .get("/api/profiles/builder_1/stats?period=week&tool=a&tool=b")
        .await;
    assert_eq!(reply.json(), stats);
    let query = &stub.to("GET /api/profiles/builder_1/stats")[1].query;
    assert_eq!(
        (query.len(), query.get("period").map(String::as_str)),
        (1, Some("week"))
    );
    stub.answer("GET /api/profiles/x%20y/stats", Answer::json(stats.clone()));
    assert_eq!(server.get("/api/profiles/x%20y/stats").await.json(), stats);

    // 404 CLOUD_UNAVAILABLE when the hosted service has no such page.
    stub.answer("GET /api/profiles/nobody", Answer::text(NOT_FOUND).with_status(404));
    expect_error(&server.get("/api/profiles/nobody").await, 404, "CLOUD_UNAVAILABLE");
    stub.answer(
        "GET /api/profiles/nobody/stats",
        Answer::text(NOT_FOUND).with_status(404),
    );
    expect_error(
        &server.get("/api/profiles/nobody/stats").await,
        404,
        "CLOUD_UNAVAILABLE",
    );

    // 502 CLOUD_UNAVAILABLE for any other failure.
    for status in [500, 503, 429, 403, 400] {
        let failure = Answer::json(json!({"error": {"code": "X", "message": "x"}})).with_status(status);
        stub.answer("GET /api/leaderboard", failure.clone());
        expect_error(&server.get("/api/leaderboard").await, 502, "CLOUD_UNAVAILABLE");
        stub.answer("GET /api/profiles/builder_1/stats", failure);
        expect_error(
            &server.get("/api/profiles/builder_1/stats").await,
            502,
            "CLOUD_UNAVAILABLE",
        );
    }

    // 502 for a redirect, which is never followed, and for a body that is not JSON.
    let elsewhere = format!("{}/api/elsewhere", stub.url);
    stub.answer(
        "GET /api/leaderboard",
        Answer::status(302).with_header("location", &elsewhere),
    );
    expect_error(&server.get("/api/leaderboard").await, 502, "CLOUD_UNAVAILABLE");
    assert!(stub.to("GET /api/elsewhere").is_empty());
    stub.answer("GET /api/leaderboard", Answer::text("<html>not json</html>"));
    expect_error(&server.get("/api/leaderboard").await, 502, "CLOUD_UNAVAILABLE");
    stub.close().await;
}

/// Rust only, for the Mac app's pages (the TypeScript server is frozen): the community, leaderboard neighbour and
/// achievement rarity proxies, which relay and refuse as the profile proxies do.
#[tokio::test]
async fn community_leaderboard_neighbour_and_achievement_rarity_proxies() {
    let unconfigured = Server::start(None, true).await;
    for path in [
        "/api/community",
        "/api/community?extra=1",
        "/api/leaderboard/around/someone",
        "/api/leaderboard/around/someone?period=all",
        "/api/leaderboard/around/a%2Fb",
        "/api/achievements/rarity",
        "/api/achievements/rarity?extra=1",
    ] {
        expect_error(&unconfigured.get(path).await, 503, "CLOUD_UNAVAILABLE");
    }

    let stub = Stub::start().await;
    let server = Server::start(Some(&stub.url), true).await;
    let around = json!({"items": [{"alias": "ahead", "rank": 2, "tokens": 120, "daily": []}, {"alias": "builder_1", "rank": 3, "tokens": 99, "daily": []}]});
    stub.answer("GET /api/leaderboard/around/builder_1", Answer::json(around.clone()));
    let reply = server
        .get("/api/leaderboard/around/builder_1?period=month&tool=a&tool=b")
        .await;
    assert_eq!(reply.status, 200);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    assert_eq!(reply.json(), around);
    let call = &stub.to("GET /api/leaderboard/around/builder_1")[0];
    assert_eq!(call.query, [("period".to_owned(), "month".to_owned())].into());
    assert_eq!(call.header("accept"), Some("application/json"));
    assert_eq!((call.header("cookie"), call.header("authorization")), (None, None));
    stub.answer("GET /api/leaderboard/around/x%20y", Answer::json(around.clone()));
    assert_eq!(server.get("/api/leaderboard/around/x%20y").await.json(), around);

    let community = json!({"builders": 12, "newBuilders": 2, "totalTokens": 9007199254740991_u64, "totalCostMicrousd": null, "toolTotals": {"claude": 9007199254740991_u64}, "trend": [], "updatedAt": "2026-10-25T12:00:00.000Z",
        "exactAggregates": {"totalTokens": "1208925819614629174706176", "toolTotals": {"claude": "1208925819614629174706176"}, "breakdown": {"input": "1208925819614629174706176", "output": "0", "cacheRead": "0", "cacheWrite": "0", "reasoning": "0"}}});
    stub.answer("GET /api/community", Answer::json(community.clone()));
    let reply = server.get("/api/community?extra=1").await;
    assert_eq!(reply.status, 200);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    assert_eq!(reply.json(), community);
    let call = &stub.to("GET /api/community")[0];
    assert_eq!(call.query, [("extra".to_owned(), "1".to_owned())].into());
    assert_eq!((call.header("cookie"), call.header("authorization")), (None, None));

    let rarity = json!({"builders": 4, "holders": {"streak": [3, 2, 1, 0]}});
    stub.answer("GET /api/achievements/rarity", Answer::json(rarity.clone()));
    let reply = server.get("/api/achievements/rarity").await;
    assert_eq!(reply.status, 200);
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    assert_eq!(reply.json(), rarity);
    let call = &stub.to("GET /api/achievements/rarity")[0];
    assert!(call.query.is_empty());
    assert_eq!((call.header("cookie"), call.header("authorization")), (None, None));

    // The profile proxy's alias limit, its 404 and 502 mapping, and no redirects.
    expect_error(
        &server
            .get(&format!("/api/leaderboard/around/{}", "a".repeat(101)))
            .await,
        404,
        "NOT_FOUND",
    );
    expect_error(
        &server.get("/api/leaderboard/around/nobody").await,
        404,
        "CLOUD_UNAVAILABLE",
    );
    for status in [500, 429, 400] {
        let failure = Answer::json(json!({"error": {"code": "X", "message": "x"}})).with_status(status);
        stub.answer("GET /api/leaderboard/around/builder_1", failure.clone());
        expect_error(
            &server.get("/api/leaderboard/around/builder_1").await,
            502,
            "CLOUD_UNAVAILABLE",
        );
        stub.answer("GET /api/achievements/rarity", failure.clone());
        expect_error(&server.get("/api/achievements/rarity").await, 502, "CLOUD_UNAVAILABLE");
        stub.answer("GET /api/community", failure);
        expect_error(&server.get("/api/community").await, 502, "CLOUD_UNAVAILABLE");
    }
    stub.answer(
        "GET /api/achievements/rarity",
        Answer::status(302).with_header("location", &format!("{}/api/elsewhere", stub.url)),
    );
    expect_error(&server.get("/api/achievements/rarity").await, 502, "CLOUD_UNAVAILABLE");
    assert!(stub.to("GET /api/elsewhere").is_empty());
    stub.close().await;
    expect_error(
        &server.get("/api/leaderboard/around/builder_1").await,
        502,
        "CLOUD_UNAVAILABLE",
    );
    expect_error(&server.get("/api/achievements/rarity").await, 502, "CLOUD_UNAVAILABLE");
    expect_error(&server.get("/api/community").await, 502, "CLOUD_UNAVAILABLE");
}

#[tokio::test]
async fn a_hosted_service_that_cannot_be_reached() {
    let stub = Stub::start().await;
    let url = stub.url.clone();
    stub.close().await;
    let server = Server::start(Some(&url), true).await;
    assert_eq!(server.get("/api/health").await.json()["cloudUrl"], json!(url));
    expect_error(&server.get("/api/leaderboard").await, 502, "CLOUD_UNAVAILABLE");
    expect_error(&server.get("/api/profiles/someone").await, 502, "CLOUD_UNAVAILABLE");
    expect_error(
        &server.get("/api/profiles/someone/stats").await,
        502,
        "CLOUD_UNAVAILABLE",
    );
    expect_error(
        &server.request("/api/local/connect", Init::method("POST")).await,
        502,
        "CONNECT_FAILED",
    );
    // Linking to it: 502 SYNC_FAILED (the first quirk of tests/contract/README.md; TypeScript answers 500).
    let link = put(
        json!({"url": url, "deviceToken": "t".repeat(32), "historyStart": null, "shareTools": false, "shareCost": false}),
    );
    expect_error(&server.request("/api/local/cloud", link).await, 502, "SYNC_FAILED");
}

fn publication(change: Value) -> Value {
    let generation = uuid::Uuid::new_v4().to_string();
    let mut value = json!({"alias": "stub-builder", "historyStart": null, "shareTools": false, "shareCost": false, "shareModels": false, "generation": generation});
    merge(&mut value, change);
    value
}

const TOKEN: &str = "device-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// Rust only, for the Mac app's pages: likes go to the linked service with the device token, and its answer comes
/// back as it is.
#[tokio::test]
async fn likes_through_the_device_token() {
    let stub = Stub::start().await;
    // Likes go to the linked service, never to the configured one.
    let configured = Stub::start().await;
    let server = Server::start(Some(&configured.url), true).await;
    let like = async |method: &'static str, alias: &str| {
        let path = format!("/api/local/likes/{alias}");
        server.request(&path, Init::method(method)).await
    };
    let mut replies = Vec::new();

    // Nothing linked: 409 CLOUD_NOT_LINKED, without asking the hosted service.
    for method in ["GET", "PUT", "DELETE"] {
        let reply = like(method, "builder_1").await;
        expect_error(&reply, 409, "CLOUD_NOT_LINKED");
        replies.push(reply);
    }
    assert!(stub.calls().is_empty());

    stub.answer(
        "GET /api/device-policy",
        Answer::json(json!({"publication": publication(json!({}))})),
    );
    let link =
        json!({"url": stub.url, "deviceToken": TOKEN, "historyStart": null, "shareTools": false, "shareCost": false});
    assert_eq!(server.request("/api/local/cloud", put(link.clone())).await.status, 200);

    // The device token as Bearer, no body and no local credentials; `{liked}` and 204 relayed.
    let route = "/api/profiles/builder_1/like";
    stub.answer(&format!("GET {route}"), Answer::json(json!({"liked": true})));
    stub.answer(&format!("PUT {route}"), Answer::status(204));
    stub.answer(&format!("DELETE {route}"), Answer::status(204));
    let reply = like("GET", "builder_1").await;
    assert_eq!((reply.status, reply.json()), (200, json!({"liked": true})));
    assert!(reply.header("content-type").unwrap().starts_with("application/json"));
    replies.push(reply);
    for method in ["PUT", "DELETE"] {
        let reply = like(method, "builder_1").await;
        assert_eq!((reply.status, reply.text.as_str()), (204, ""));
        replies.push(reply);
    }
    // HEAD is refused here rather than sent on with the token.
    let calls = stub.calls().len();
    assert_eq!(like("HEAD", "builder_1").await.status, 404);
    assert_eq!(stub.calls().len(), calls);
    for method in ["GET", "PUT", "DELETE"] {
        let calls = stub.to(&format!("{method} {route}"));
        assert_eq!(calls.len(), 1, "{method}");
        let call = &calls[0];
        assert_eq!(call.header("authorization"), Some(bearer(TOKEN).as_str()));
        assert_eq!(call.header("accept"), Some("application/json"));
        assert_eq!((call.header("cookie"), call.header("content-type")), (None, None));
        assert!(call.body.is_none() && call.query.is_empty());
    }
    stub.answer("PUT /api/profiles/x%20y/like", Answer::status(204));
    assert_eq!(like("PUT", "x%20y").await.status, 204);

    // Hosted refusals keep their status and body.
    for (status, code) in [
        (400, "INVALID_REQUEST"),
        (401, "UNAUTHORIZED"),
        (404, "NOT_FOUND"),
        (429, "RATE_LIMITED"),
    ] {
        let body = json!({"error": {"code": code, "message": "Hosted says no."}});
        stub.answer(&format!("PUT {route}"), Answer::json(body.clone()).with_status(status));
        let reply = like("PUT", "builder_1").await;
        assert_eq!((reply.status, reply.json()), (status, body));
        assert!(reply.header("content-type").unwrap().starts_with("application/json"));
        replies.push(reply);
    }
    // An over-long alias, as the profile proxy refuses it; an unreadable answer or a redirect is 502.
    let reply = like("GET", &"a".repeat(101)).await;
    expect_error(&reply, 404, "NOT_FOUND");
    replies.push(reply);
    stub.answer(&format!("GET {route}"), Answer::text("<html>not json</html>"));
    let reply = like("GET", "builder_1").await;
    expect_error(&reply, 502, "CLOUD_UNAVAILABLE");
    replies.push(reply);
    stub.answer(
        &format!("DELETE {route}"),
        Answer::status(302).with_header("location", &format!("{}/api/elsewhere", stub.url)),
    );
    let reply = like("DELETE", "builder_1").await;
    expect_error(&reply, 502, "CLOUD_UNAVAILABLE");
    replies.push(reply);
    assert!(stub.to("DELETE /api/elsewhere").is_empty());

    // The session's protections of local changes apply before anything is forwarded.
    let calls = stub.calls().len();
    let path = "/api/local/likes/builder_1";
    let reply = server.request(path, Init::method("PUT").header("origin", None)).await;
    expect_error(&reply, 403, "ORIGIN_REQUIRED");
    let reply = server
        .request(
            path,
            Init::method("DELETE").header("origin", Some("https://evil.example")),
        )
        .await;
    expect_error(&reply, 403, "ORIGIN_REJECTED");
    let form = Init::method("PUT")
        .header("content-type", Some("application/x-www-form-urlencoded"))
        .body("liked=1");
    expect_error(&server.request(path, form).await, 415, "INVALID_REQUEST");
    let reply = server.request(path, Init::method("PUT").header("cookie", None)).await;
    expect_error(&reply, 401, "LOCAL_AUTH_REQUIRED");
    assert_eq!(stub.calls().len(), calls);

    // Unlinked again: 409, and a service that cannot be reached is 502.
    assert_eq!(
        server.request("/api/local/cloud", Init::method("DELETE")).await.status,
        204
    );
    expect_error(&like("PUT", "builder_1").await, 409, "CLOUD_NOT_LINKED");
    assert_eq!(server.request("/api/local/cloud", put(link)).await.status, 200);
    stub.close().await;
    let reply = like("GET", "builder_1").await;
    expect_error(&reply, 502, "CLOUD_UNAVAILABLE");
    replies.push(reply);
    // The token is never echoed.
    assert!(replies.iter().all(|reply| !reply.text.contains(TOKEN)));
    assert!(configured.calls().is_empty());
}

#[tokio::test]
async fn device_connection_through_browser_approval() {
    let stub = Stub::start().await;
    let server = Server::start(Some(&stub.url), true).await;
    let start = || {
        stub.answer(
            "POST /api/device-auth",
            Answer::json(
                json!({"pollToken": "poll-secret-1", "userCode": "BCDF-GHJK", "expiresAt": "2026-10-24T12:00:00.000Z"}),
            ),
        )
    };
    let poll = || server.request("/api/local/connect/poll", Init::method("POST"));
    let connect = || server.request("/api/local/connect", Init::method("POST"));

    // 409 CONNECT_NOT_STARTED to a poll before anything was started.
    expect_error(&poll().await, 409, "CONNECT_NOT_STARTED");

    // Starts a connection: the user code and the approval address, never the poll secret.
    start();
    let reply = connect().await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.json(),
        json!({"userCode": "BCDF-GHJK", "verificationUrl": format!("{}/?connect=BCDF-GHJK", stub.url), "expiresAt": "2026-10-24T12:00:00.000Z"})
    );
    assert!(!reply.text.contains("poll-secret-1"));
    let call = &stub.to("POST /api/device-auth")[0];
    assert!(call.header("content-type").unwrap().starts_with("application/json"));
    let body = call.body.as_ref().unwrap().as_object().unwrap();
    // A salted hash of the hardware id, where the computer has one (F4); the frozen TypeScript app sends none.
    let keys = body.keys().collect::<Vec<_>>();
    assert!(
        keys == ["deviceName"] || keys == ["deviceName", "machineId"],
        "{keys:?}"
    );
    if let Some(machine_id) = body.get("machineId") {
        let machine_id = machine_id.as_str().unwrap();
        assert!(
            machine_id.len() == 64
                && machine_id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    }
    let name = body["deviceName"].as_str().unwrap();
    assert!(!name.starts_with(char::is_whitespace) && (1..=80).contains(&name.chars().count()) && !name.contains('\n'));

    // Polls with the poll secret and reports pending until the member approves.
    stub.answer("POST /api/device-auth/poll", Answer::json(json!({"status": "pending"})));
    for _ in 0..2 {
        let reply = poll().await;
        assert_eq!((reply.status, reply.json()), (200, json!({"status": "pending"})));
    }
    let polls = stub.to("POST /api/device-auth/poll");
    assert!(
        polls
            .iter()
            .all(|call| call.header("authorization") == Some("Bearer poll-secret-1"))
    );
    assert_eq!(server.status().await["cloudLinked"], json!(false));

    // Reports a code that expired, and then has nothing in progress.
    let expired = Answer::json(json!({"error": {"code": "EXPIRED", "message": "Expired."}})).with_status(410);
    stub.answer("POST /api/device-auth/poll", expired);
    assert_eq!(poll().await.json(), json!({"status": "expired"}));
    expect_error(&poll().await, 409, "CONNECT_NOT_STARTED");

    // 429 RATE_LIMITED, and 502 CONNECT_FAILED for a failure or an answer it cannot use, when starting.
    let limited = Answer::json(json!({"error": {"code": "RATE_LIMITED", "message": "Slow down."}})).with_status(429);
    stub.answer("POST /api/device-auth", limited);
    expect_error(&connect().await, 429, "RATE_LIMITED");
    let unusable = [
        Answer::json(json!({})).with_status(500),
        Answer::json(json!({"pollToken": "p", "userCode": "bcdf-ghjk", "expiresAt": "x"})),
        Answer::json(json!({"pollToken": 1, "userCode": "BCDF-GHJK", "expiresAt": "x"})),
        Answer::json(json!({"userCode": "BCDF-GHJK", "expiresAt": "x"})),
        Answer::text("nope"),
    ];
    for answer in unusable {
        stub.answer("POST /api/device-auth", answer);
        expect_error(&connect().await, 502, "CONNECT_FAILED");
    }

    // 502 CONNECT_FAILED when polling fails or the answer is not usable, keeping the connection to poll again.
    start();
    assert_eq!(connect().await.status, 200);
    let unusable = [
        Answer::json(json!({})).with_status(500),
        Answer::json(json!({"status": "approved"})),
        Answer::json(json!({"status": "rejected"})),
        Answer::text("nope"),
    ];
    for answer in unusable {
        stub.answer("POST /api/device-auth/poll", answer);
        expect_error(&poll().await, 502, "CONNECT_FAILED");
    }
    stub.answer("POST /api/device-auth/poll", Answer::json(json!({"status": "pending"})));
    assert_eq!(poll().await.json(), json!({"status": "pending"}));

    // Links the device once the member approves, saving the approved scope, and then has nothing in progress.
    let approved = publication(json!({"alias": "approved-builder", "shareTools": true}));
    stub.answer(
        "POST /api/device-auth/poll",
        Answer::json(json!({"status": "approved", "deviceToken": TOKEN, "publication": approved})),
    );
    stub.answer("GET /api/device-policy", Answer::json(json!({"publication": approved})));
    stub.on("POST /api/ingest", |call| {
        Answer::json(json!({"accepted": call.body.as_ref().unwrap()["buckets"].as_array().unwrap().len()}))
    });
    let reply = poll().await;
    assert_eq!(
        (reply.status, reply.json()),
        (200, json!({"status": "connected", "alias": "approved-builder"}))
    );
    assert_eq!(
        stub.to("GET /api/device-policy")[0].header("authorization"),
        Some(bearer(TOKEN).as_str())
    );
    // The first upload happens before success is reported, so the app can show its standing at once.
    let ingests = stub.to("POST /api/ingest");
    assert_eq!(ingests.len(), 1);
    let body = ingests[0].body.as_ref().unwrap();
    assert_eq!(
        (&body["generation"], &body["buckets"]),
        (&approved["generation"], &json!([]))
    );
    let status = server.status().await;
    assert_eq!(
        (&status["cloudLinked"], &status["alias"], &status["syncError"]),
        (&json!(true), &json!("approved-builder"), &Value::Null)
    );
    assert!(is_iso(&status["lastSyncAt"]));
    assert!(!status.to_string().contains(TOKEN));
    expect_error(&poll().await, 409, "CONNECT_NOT_STARTED");
    stub.close().await;
}

const FIXTURE_DAY: &str = "2026-10-20";
const LOG: &str = "/home/.claude/projects/p/session.jsonl";

/// The kinds of the fixture log's totals, always uploaded: `log(11, 20)` is 161 tokens and `log(1, 2)` is 133.
fn kinds(tokens: u64) -> Value {
    let (input, output) = match tokens {
        161 => (11, 20),
        133 => (1, 2),
        172 => (16, 26),
        _ => unreachable!("{tokens}"),
    };
    json!({"input": input, "output": output, "cacheRead": 100, "cacheWrite": 30, "reasoning": output.min(7)})
}
fn bucket(tokens: u64, revision: &Value, change: Value) -> Value {
    let mut value = json!({"day": FIXTURE_DAY, "tool": "all", "tokens": tokens, "costMicrousd": null, "revision": revision, "breakdown": kinds(tokens)});
    merge(&mut value, change);
    value
}

#[tokio::test]
async fn linking_syncing_and_the_hosted_wire_format() {
    use std::sync::{Arc, Mutex};
    let stub = Stub::start().await;
    let server = Server::start(Some(&stub.url), true).await;
    let store = server.state.store.clone();
    // Read-time pricing, so shared costs are numbers.
    store.lock().unwrap().set_pricer(
        Some(Box::new(|_| {
            let parts = CostParts {
                input: 476,
                ..CostParts::default()
            };
            Some(tokentracky_collector::store::PricedCost {
                cost_microusd: parts.total(),
                parts,
                pricing_version: "litellm:000000000000".to_owned(),
            })
        })),
        Some("litellm:000000000000"),
    );
    let current = Arc::new(Mutex::new(publication(json!({}))));
    let failure: Arc<Mutex<Option<Answer>>> = Arc::default();
    let serve_policy = {
        let current = current.clone();
        move |_: &Call| Answer::json(json!({"publication": *current.lock().unwrap()}))
    };
    stub.on("GET /api/device-policy", serve_policy.clone());
    stub.on("POST /api/ingest", {
        let failure = failure.clone();
        move |call| {
            failure.lock().unwrap().clone().unwrap_or_else(|| {
                Answer::json(json!({"accepted": call.body.as_ref().unwrap()["buckets"].as_array().unwrap().len()}))
            })
        }
    });
    let set = |value: Value| *current.lock().unwrap() = value;
    let generation = || current.lock().unwrap()["generation"].clone();
    let fail = |answer: Option<Answer>| *failure.lock().unwrap() = answer;
    let link = |change: Value| {
        let mut body = json!({"url": stub.url, "deviceToken": TOKEN, "historyStart": null, "shareTools": false, "shareCost": false});
        merge(&mut body, change);
        server.request("/api/local/cloud", put(body))
    };
    let sync = || server.request("/api/local/sync", Init::method("POST"));
    let ingests = || stub.to("POST /api/ingest");
    let last = || ingests().last().unwrap().body.clone().unwrap();
    let log = |input: u64, output: u64| {
        commit(
            &store,
            LOG,
            &[claude("claude-session", "/synthetic/private-project", input, output)],
        )
    };

    // Refuses a scope that differs from the published one, checking it with the device token.
    set(publication(json!({"shareTools": true})));
    for change in [
        json!({"shareTools": false}),
        json!({"shareCost": true, "shareTools": true}),
        json!({"shareTools": true, "shareModels": true}),
        json!({"shareTools": true, "historyStart": "2026-10-01"}),
    ] {
        expect_error(&link(change).await, 400, "SCOPE_NOT_PUBLISHED");
    }
    let policies = stub.to("GET /api/device-policy");
    assert!(
        policies
            .iter()
            .all(|call| call.header("authorization") == Some(bearer(TOKEN).as_str()))
    );
    assert_eq!(server.status().await["cloudLinked"], json!(false));

    // 409 RELINK_REQUIRED when the hosted service no longer accepts the device, 502 SYNC_FAILED when it is down.
    for status in [401, 403, 404, 409] {
        let refused = Answer::json(json!({"error": {"code": "X", "message": "x"}})).with_status(status);
        stub.answer("GET /api/device-policy", refused);
        expect_error(&link(json!({})).await, 409, "RELINK_REQUIRED");
    }
    for status in [500, 503] {
        stub.answer("GET /api/device-policy", Answer::json(json!({})).with_status(status));
        expect_error(&link(json!({})).await, 502, "SYNC_FAILED");
    }
    stub.on("GET /api/device-policy", serve_policy.clone());

    // Links a device whose scope matches, and never shows the token again.
    set(publication(json!({})));
    let reply = link(json!({})).await;
    assert_eq!((reply.status, reply.json()), (200, json!({"linked": true})));
    let status = server.status().await;
    assert_eq!(
        (
            &status["cloudLinked"],
            &status["alias"],
            &status["syncError"],
            &status["lastSyncAt"]
        ),
        (&json!(true), &json!("stub-builder"), &Value::Null, &Value::Null)
    );
    assert!(!status.to_string().contains(TOKEN));

    // Uploads even an empty history, which authenticates the device, and reports when.
    let reply = sync().await;
    assert_eq!(reply.status, 200);
    let synced_at = reply.json()["syncedAt"].clone();
    assert!(is_iso(&synced_at));
    assert_eq!(reply.json(), json!({"syncedAt": synced_at}));
    assert_eq!(server.status().await["lastSyncAt"], synced_at);
    let call = &ingests()[0];
    assert_eq!(call.header("authorization"), Some(bearer(TOKEN).as_str()));
    assert!(call.header("content-type").unwrap().starts_with("application/json"));
    let body = call.body.clone().unwrap();
    assert!(is_uuid(&body["collectorId"]) && is_uuid(&body["receipt"]) && body["checkpoint"].is_u64());
    assert_eq!(
        body,
        json!({"generation": generation(), "collectorId": body["collectorId"], "checkpoint": body["checkpoint"], "receipt": body["receipt"], "baseReceipt": null, "buckets": [], "hours": []})
    );

    // Uploads day totals only: no tool, model, project, session or text unless approved.
    log(11, 20);
    assert_eq!(sync().await.status, 200);
    let body = last();
    let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "baseReceipt",
            "buckets",
            "checkpoint",
            "collectorId",
            "generation",
            "hours",
            "receipt"
        ]
    );
    assert_eq!(
        body["buckets"],
        json!([bucket(161, &body["buckets"][0]["revision"], json!({}))])
    );
    let mut keys: Vec<_> = body["buckets"][0].as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["breakdown", "costMicrousd", "day", "revision", "tokens", "tool"]);
    let wire = Value::Array(ingests().into_iter().map(|call| call.body.unwrap()).collect()).to_string();
    for marker in [
        "PRIVATE_PROMPT_MARKER",
        "/synthetic/private-project",
        "claude-session",
        "msg-1",
        "claude-sonnet-4-6",
        "req-msg-1",
    ] {
        assert!(!wire.contains(marker), "{marker}");
    }

    // Posts nothing while usage is unchanged, and chains the next upload to the one last acknowledged.
    let first = last();
    let posted = ingests().len();
    assert_eq!(sync().await.status, 200);
    assert_eq!(ingests().len(), posted);
    log(16, 26);
    assert_eq!(sync().await.status, 200);
    let second = last();
    assert_eq!(second["baseReceipt"], first["receipt"]);
    assert_ne!(second["receipt"], first["receipt"]);
    assert_eq!(
        second["buckets"],
        json!([bucket(172, &second["buckets"][0]["revision"], json!({}))])
    );
    assert_eq!(second["collectorId"], first["collectorId"]);

    // Keeps a failed upload frozen and sends it again unchanged, while a later correction waits for the next upload.
    let acknowledged = last();
    let down = json!({"error": {"code": "SERVICE_UNAVAILABLE", "message": "Down."}});
    fail(Some(Answer::json(down).with_status(503)));
    // A change to send, frozen by the failed upload.
    log(11, 20);
    expect_error(&sync().await, 502, "SYNC_FAILED");
    let failed = last();
    assert_eq!(failed["baseReceipt"], acknowledged["receipt"]);
    let status = server.status().await;
    assert_eq!(
        (&status["syncError"], &status["cloudLinked"]),
        (&json!("SYNC_FAILED"), &json!(true))
    );
    // Usage goes down again while the hosted service is unreachable: a smaller log replaces the old one.
    log(1, 2);
    fail(None);
    assert_eq!(sync().await.status, 200);
    let retried = last();
    assert_eq!(retried["receipt"], failed["receipt"]);
    assert_eq!(retried["buckets"], failed["buckets"]);
    assert_eq!(
        retried["buckets"],
        json!([bucket(161, &retried["buckets"][0]["revision"], json!({}))])
    );
    assert_eq!(server.status().await["syncError"], Value::Null);
    // The next upload carries the correction, as a total that went down under a newer revision.
    assert_eq!(sync().await.status, 200);
    let corrected = last();
    assert_eq!(corrected["baseReceipt"], retried["receipt"]);
    assert_eq!(
        corrected["buckets"],
        json!([bucket(133, &corrected["buckets"][0]["revision"], json!({}))])
    );
    assert!(corrected["buckets"][0]["revision"].as_u64() > retried["buckets"][0]["revision"].as_u64());

    // Makes a day that no longer has usage a zero, so the hosted total is replaced.
    commit(&store, LOG, &[]);
    assert_eq!(sync().await.status, 200);
    let zeroed = last()["buckets"][0].clone();
    assert_eq!(
        (
            &zeroed["day"],
            &zeroed["tool"],
            &zeroed["tokens"],
            &zeroed["costMicrousd"],
            &zeroed["breakdown"]
        ),
        (
            &json!(FIXTURE_DAY),
            &json!("all"),
            &json!(0),
            &Value::Null,
            &json!({"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0})
        )
    );
    assert!(zeroed["revision"].as_u64().unwrap() > 0);
    log(1, 2);

    // Refuses to upload under a wider scope than was approved, until the device is linked again.
    let before = ingests().len();
    set(publication(json!({"shareTools": true, "shareCost": true})));
    expect_error(&sync().await, 409, "RELINK_REQUIRED");
    assert_eq!(server.status().await["syncError"], json!("RELINK_REQUIRED"));
    assert_eq!(ingests().len(), before);
    expect_error(
        &link(json!({"shareTools": true, "shareCost": false})).await,
        400,
        "SCOPE_NOT_PUBLISHED",
    );
    assert_eq!(link(json!({"shareTools": true, "shareCost": true})).await.status, 200);
    assert_eq!(sync().await.status, 200);
    let body = last();
    assert_eq!(body["generation"], generation());
    assert!(body["buckets"][0]["costMicrousd"].is_u64());
    let shared = json!({"tool": "claude", "costMicrousd": body["buckets"][0]["costMicrousd"]});
    assert_eq!(
        body["buckets"],
        json!([bucket(133, &body["buckets"][0]["revision"], shared)])
    );

    // Narrows the upload by itself when the member narrows the publication.
    set(publication(json!({"shareTools": true, "shareCost": false})));
    assert_eq!(sync().await.status, 200);
    let body = last();
    assert_eq!(body["generation"], generation());
    let tools = json!({"tool": "claude"});
    assert_eq!(
        body["buckets"],
        json!([bucket(133, &body["buckets"][0]["revision"], tools)])
    );
    set(publication(json!({})));
    assert_eq!(sync().await.status, 200);
    let body = last();
    assert_eq!(
        body["buckets"],
        json!([bucket(133, &body["buckets"][0]["revision"], json!({}))])
    );

    // A withdrawn publication, a reset local history or a rejected device is 409, a bad confirmation 502.
    let gone = json!({"error": {"code": "NOT_PUBLISHED", "message": "Gone."}});
    stub.answer("GET /api/device-policy", Answer::json(gone).with_status(404));
    expect_error(&sync().await, 409, "RELINK_REQUIRED");
    stub.on("GET /api/device-policy", serve_policy);
    // A change to send, frozen by the first failed upload, so every sync below posts it again.
    log(5, 6);
    for status in [401, 403, 404, 409] {
        fail(Some(
            Answer::json(json!({"error": {"code": "X", "message": "x"}})).with_status(status),
        ));
        expect_error(&sync().await, 409, "RELINK_REQUIRED");
    }
    let reset = json!({"error": {"code": "LOCAL_STATE_RESET", "message": "Reset."}});
    fail(Some(Answer::json(reset).with_status(409)));
    expect_error(&sync().await, 409, "LOCAL_STATE_RESET");
    assert_eq!(server.status().await["syncError"], json!("LOCAL_STATE_RESET"));
    for answer in [
        Answer::json(json!({"accepted": "many"})),
        Answer::json(json!({"accepted": -1})),
        Answer::json(json!({"accepted": 99})),
        Answer::json(json!({})),
        Answer::json(json!({})).with_status(500),
    ] {
        fail(Some(answer));
        expect_error(&sync().await, 502, "SYNC_FAILED");
    }
    fail(None);

    // Unlinks: 204, the device forgets the link, and nothing is sent to the hosted service any more.
    let calls = stub.calls().len();
    let reply = server.request("/api/local/cloud", Init::method("DELETE")).await;
    assert_eq!((reply.status, reply.text.as_str()), (204, ""));
    let status = server.status().await;
    assert_eq!(
        (
            &status["cloudLinked"],
            &status["alias"],
            &status["lastSyncAt"],
            &status["syncError"]
        ),
        (&json!(false), &Value::Null, &Value::Null, &Value::Null)
    );
    expect_error(&sync().await, 409, "CLOUD_NOT_LINKED");
    assert_eq!(stub.calls().len(), calls);
    assert_eq!(server.get("/api/health").await.json()["cloudUrl"], json!(stub.url));
    stub.close().await;
}
