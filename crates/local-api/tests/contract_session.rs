//! The assertions of `tests/contract/session.test.ts`, against the assembled router behind the session. The
//! collector-backed routes it touches are stand-ins (see `support::stand_ins`). As there, the steps run in order on
//! one server: the launch link is one-use.
mod support;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};
use support::*;

const HTML_RECOVERY_CSP: &str =
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const HOSTS: [&str; 4] = [
    "evil.example",
    "evil.example:4771",
    "127.0.0.1.evil.example:4771",
    "127.0.0.1",
];
const ORIGINS: [&str; 4] = [
    "http://evil.example",
    "http://evil.example:4771",
    "https://127.0.0.1:4771",
    "null",
];

#[track_caller]
fn security_headers(label: &str, reply: &Reply) {
    for (name, value) in SECURITY_HEADERS {
        assert_eq!(reply.header(name).as_deref(), Some(value), "{label}: {name}");
    }
}

#[tokio::test]
async fn launch_link_session_protection_and_response_headers() {
    let mut server = Server::start(None, false).await;
    let launch = server.launch_path();
    let token = launch.split("launch=").nth(1).unwrap().to_owned();

    // Refuses every route before a session exists, without revealing which routes exist.
    for path in ["/api/local/status", "/api/health", "/api/nope", "/"] {
        expect_error(
            &server.request(path, Init::default().no_session()).await,
            401,
            "LOCAL_AUTH_REQUIRED",
        );
    }
    let page = server
        .request(
            "/",
            Init::default()
                .no_session()
                .header("accept", Some("text/html,application/xhtml+xml")),
        )
        .await;
    assert_eq!(page.status, 401);
    assert!(page.header("content-type").unwrap().starts_with("text/html"));
    assert_eq!(
        page.header("content-security-policy").as_deref(),
        Some(HTML_RECOVERY_CSP)
    );
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("cache-control", "no-store"),
        ("referrer-policy", "no-referrer"),
    ] {
        assert_eq!(page.header(name).as_deref(), Some(value));
    }
    assert!(page.text.to_ascii_lowercase().starts_with("<!doctype html>"));
    assert!(page.cookies().is_empty());
    // Only the workspace page falls back to HTML; API routes always answer with the JSON error.
    let api = Init::default().no_session().header("accept", Some("text/html"));
    expect_error(
        &server.request("/api/local/status", api).await,
        401,
        "LOCAL_AUTH_REQUIRED",
    );

    // Rejects a wrong Host before it looks at the launch link, and keeps the link usable.
    for host in HOSTS {
        let reply = server
            .request(&launch, Init::default().no_session().header("host", Some(host)))
            .await;
        expect_error(&reply, 403, "ORIGIN_REJECTED");
        assert!(reply.cookies().is_empty());
    }

    // Rejects unknown launch tokens.
    let long = format!("/?launch={}", "a".repeat(32));
    for path in [
        "/?launch=",
        "/?launch=not-a-token",
        &long,
        "/api/local/status?launch=not-a-token",
    ] {
        let reply = server.request(path, Init::default().no_session()).await;
        expect_error(&reply, 401, "LOCAL_AUTH_REQUIRED");
        assert!(reply.cookies().is_empty());
    }

    // Exchanges the launch link once for an HttpOnly, SameSite=Strict session cookie; a link opened from another
    // app is a cross-site navigation, and the link itself authorises the entry.
    let first = server
        .request(
            &launch,
            Init::default()
                .no_session()
                .header("sec-fetch-site", Some("cross-site")),
        )
        .await;
    assert_eq!(first.status, 200);
    assert!(first.header("content-type").unwrap().starts_with("text/html"));
    let cookies = first.cookies();
    assert_eq!(cookies.len(), 1);
    let cookie = &cookies[0];
    let (pair, attributes) = cookie.split_once(';').unwrap();
    let (name, value) = pair.split_once('=').unwrap();
    assert!(!name.is_empty() && !value.is_empty() && !pair.contains(char::is_whitespace));
    let attributes: Vec<&str> = attributes.split(';').map(str::trim).collect();
    for expected in ["HttpOnly", "SameSite=Strict", "Path=/"] {
        assert!(
            attributes
                .iter()
                .any(|attribute| attribute.eq_ignore_ascii_case(expected)),
            "{cookie}"
        );
    }
    assert!(
        !attributes
            .iter()
            .any(|attribute| attribute.to_ascii_lowercase().starts_with("domain="))
    );
    // The token never stays in a URL: a local document commits the cookie, then replaces itself with "/".
    let script = first
        .text
        .split("<script>")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    assert!(script.contains(r#"location.replace("/")"#));
    let digest = STANDARD.encode(Sha256::digest(script));
    assert_eq!(
        first.header("content-security-policy"),
        Some(format!(
            "default-src 'none'; script-src 'sha256-{digest}'; base-uri 'none'; frame-ancestors 'none'"
        ))
    );
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("cache-control", "no-store"),
        ("referrer-policy", "no-referrer"),
        ("permissions-policy", "camera=(), microphone=(), geolocation=()"),
    ] {
        assert_eq!(first.header(name).as_deref(), Some(value));
    }
    assert!(!first.text.contains(&token));

    let replay = server.request(&launch, Init::default().no_session()).await;
    expect_error(&replay, 401, "LOCAL_AUTH_REQUIRED");
    assert!(replay.cookies().is_empty());
    let replay_page = server
        .request(
            &launch,
            Init::default().no_session().header("accept", Some("text/html")),
        )
        .await;
    assert_eq!(replay_page.status, 401);
    assert!(replay_page.header("content-type").unwrap().starts_with("text/html"));
    assert_eq!(
        replay_page.header("content-security-policy").as_deref(),
        Some(HTML_RECOVERY_CSP)
    );
    assert!(!replay_page.text.contains(&token));
    assert!(replay_page.cookies().is_empty());

    server.cookie = Some(pair.to_owned());
    // Replaying a spent link neither revokes nor replaces the session that it created.
    let status = Init::default().header("origin", None);
    assert_eq!(server.request("/api/local/status", status).await.status, 200);

    // Requires the session cookie on every request.
    let wrong = format!(
        "{}{}",
        &value[..value.len() - 1],
        if value.ends_with('a') { "b" } else { "a" }
    );
    let cookies = [
        None,
        Some(String::new()),
        Some(format!("{name}=")),
        Some(format!("{name}={wrong}")),
        Some(format!("{name}={value}{value}")),
        Some(format!("other={value}")),
    ];
    for cookie in &cookies {
        let read = Init::default().header("cookie", cookie.as_deref());
        expect_error(
            &server.request("/api/local/status", read).await,
            401,
            "LOCAL_AUTH_REQUIRED",
        );
        let write = Init::method("POST").header("cookie", cookie.as_deref());
        expect_error(
            &server.request("/api/local/refresh", write).await,
            401,
            "LOCAL_AUTH_REQUIRED",
        );
    }
    let nope = Init::default().header("cookie", None);
    expect_error(&server.request("/api/nope", nope).await, 401, "LOCAL_AUTH_REQUIRED");

    // Accepts reads with or without an Origin header when the cookie and Host are right.
    assert_eq!(server.get("/api/local/status").await.status, 200);
    let read = Init::default().header("origin", None);
    assert_eq!(server.request("/api/local/status", read).await.status, 200);

    // Rejects a wrong Host, even with a valid cookie and for the launch route.
    for host in HOSTS {
        let read = Init::default().header("host", Some(host));
        expect_error(&server.request("/api/local/status", read).await, 403, "ORIGIN_REJECTED");
        let write = Init::method("POST").header("host", Some(host));
        expect_error(
            &server.request("/api/local/refresh", write).await,
            403,
            "ORIGIN_REJECTED",
        );
        let anonymous = Init::default().header("host", Some(host)).header("cookie", None);
        expect_error(
            &server.request("/api/local/status", anonymous).await,
            403,
            "ORIGIN_REJECTED",
        );
    }

    // Rejects a wrong Origin on reads and on changes, even with a valid cookie.
    for origin in ORIGINS {
        let read = Init::default().header("origin", Some(origin));
        expect_error(&server.request("/api/local/status", read).await, 403, "ORIGIN_REJECTED");
        let write = Init::method("POST").header("origin", Some(origin));
        expect_error(
            &server.request("/api/local/refresh", write).await,
            403,
            "ORIGIN_REJECTED",
        );
    }

    // Requires the workspace Origin for every change, and changes nothing without it.
    for (method, path) in [("POST", "/api/local/refresh"), ("DELETE", "/api/local/cloud")] {
        let write = Init::method(method).header("origin", None);
        expect_error(&server.request(path, write).await, 403, "ORIGIN_REQUIRED");
    }
    let pause = Init::method("PUT")
        .json(serde_json::json!({"paused": true}))
        .header("origin", None);
    expect_error(
        &server.request("/api/local/collection", pause).await,
        403,
        "ORIGIN_REQUIRED",
    );
    // The rejected pause had no effect: a refresh still runs (it would answer 409 if collection were paused).
    assert_eq!(
        server.request("/api/local/refresh", Init::method("POST")).await.status,
        200
    );

    // Rejects cross-site fetches even with a valid cookie, and allows same-origin and direct navigation.
    let cross = || Init::default().header("sec-fetch-site", Some("cross-site"));
    expect_error(
        &server.request("/api/local/status", cross()).await,
        403,
        "LOCAL_AUTH_REQUIRED",
    );
    let cross_write = Init::method("POST").header("sec-fetch-site", Some("cross-site"));
    expect_error(
        &server.request("/api/local/refresh", cross_write).await,
        403,
        "LOCAL_AUTH_REQUIRED",
    );
    for site in ["same-origin", "none"] {
        let read = Init::default().header("sec-fetch-site", Some(site));
        assert_eq!(server.request("/api/local/status", read).await.status, 200);
    }

    // Sets every security header with its exact value on every kind of response.
    let replies = [
        ("health", server.get("/api/health").await),
        ("status", server.get("/api/local/status").await),
        (
            "empty 204",
            server.request("/api/local/cloud", Init::method("DELETE")).await,
        ),
        ("400 filter", server.get("/api/local/summary?days=3").await),
        (
            "400 body",
            server
                .request("/api/local/collection", Init::method("PUT").json(serde_json::json!({})))
                .await,
        ),
        ("404", server.get("/api/nope").await),
        ("503", server.get("/api/leaderboard").await),
        ("csv", server.get("/api/local/export").await),
        (
            "401",
            server
                .request("/api/local/status", Init::default().header("cookie", None))
                .await,
        ),
        (
            "403 host",
            server
                .request(
                    "/api/local/status",
                    Init::default().header("host", Some("evil.example")),
                )
                .await,
        ),
        (
            "403 origin",
            server
                .request("/api/local/refresh", Init::method("POST").header("origin", None))
                .await,
        ),
        ("workspace page", server.get("/").await),
    ];
    for (label, reply) in &replies {
        security_headers(label, reply);
    }
    assert_eq!(replies[2].1.status, 204);
    assert_eq!(replies[11].1.status, 200);

    // Sends no CORS headers, so only the workspace origin can read responses.
    for init in [
        Init::default(),
        Init::default().header("origin", Some("http://evil.example")),
    ] {
        let reply = server.request("/api/local/status", init).await;
        assert!(
            reply
                .headers
                .keys()
                .all(|name| !name.as_str().starts_with("access-control-"))
        );
    }
}
