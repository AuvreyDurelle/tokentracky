//! The router this crate owns: its routes and the session in front of each, unknown paths and methods, the web build,
//! request bodies as Fastify parses them, the in-process transport, the 30-second receive limit and the per-client
//! rate limit.
mod support;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::extract::Request;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::Arc;
use support::*;
use tokentracky_local_api::{HttpClient, LocalState, MemorySecretStore, base_router};
use tower::ServiceExt;

/// The routes of [`base_router`], each with a well-formed request.
const ROUTES: [(&str, &str); 19] = [
    ("GET", "/api/health"),
    ("PUT", "/api/local/cloud"),
    ("DELETE", "/api/local/cloud"),
    ("POST", "/api/local/sync"),
    ("POST", "/api/local/connect"),
    ("POST", "/api/local/connect/poll"),
    ("GET", "/api/leaderboard"),
    ("GET", "/api/profiles/someone"),
    ("GET", "/api/profiles/someone/stats"),
    ("GET", "/"),
    ("GET", "/privacy"),
    ("GET", "/terms"),
    ("GET", "/support"),
    ("GET", "/leaderboard"),
    ("GET", "/you"),
    ("GET", "/join"),
    ("GET", "/u/Some-Builder"),
    ("GET", "/assets/contract.js"),
    ("HEAD", "/assets/contract.js"),
];
/// Routes only the Rust server has, for the Mac app's pages (the TypeScript server is frozen).
const RUST_ROUTES: [(&str, &str); 6] = [
    ("GET", "/api/community"),
    ("GET", "/api/leaderboard/around/someone"),
    ("GET", "/api/achievements/rarity"),
    ("GET", "/api/local/likes/someone"),
    ("PUT", "/api/local/likes/someone"),
    ("DELETE", "/api/local/likes/someone"),
];

fn sample(method: &'static str, path: &str) -> Init {
    let init = Init::method(method);
    if path == "/api/local/cloud" && method == "PUT" {
        // A well-formed link to a non-loopback http origin is refused before any network access.
        return init.json(json!({"url": "http://example.com", "deviceToken": "x".repeat(32), "historyStart": null, "shareTools": false, "shareCost": false}));
    }
    init
}

#[tokio::test]
async fn answers_every_route_and_protects_each_with_the_session() {
    let server = Server::start(None, true).await;
    for (method, path) in ROUTES.into_iter().chain(RUST_ROUTES) {
        let reply = server.request(path, sample(method, path)).await;
        assert_ne!(reply.status, 404, "{method} {path}");
        let reply = server.request(path, sample(method, path).header("cookie", None)).await;
        assert_eq!(reply.status, 401, "{method} {path}");
        if method != "HEAD" {
            expect_error(&reply, 401, "LOCAL_AUTH_REQUIRED");
        }
    }
}

#[tokio::test]
async fn answers_404_not_found_for_unknown_paths_and_other_methods() {
    let server = Server::start(None, true).await;
    for path in [
        "/api/nope",
        "/api/local",
        "/api/local/nope",
        "/api/account",
        "/api/device-auth",
        "/api/ingest",
        "/privacy/extra",
        "/u/x",
        "/u/a/b",
        "/api/health/",
    ] {
        for method in ["GET", "POST", "PUT", "DELETE"] {
            expect_error(&server.request(path, Init::method(method)).await, 404, "NOT_FOUND");
        }
    }
    for (method, path) in [
        ("PUT", "/api/health"),
        ("POST", "/api/leaderboard"),
        ("GET", "/api/local/cloud"),
        ("GET", "/api/local/sync"),
        ("OPTIONS", "/api/health"),
        ("POST", "/"),
    ] {
        let reply = server.request(path, Init::method(method)).await;
        expect_error(&reply, 404, "NOT_FOUND");
        assert_eq!(reply.header("allow"), None);
    }
    // Fastify's router matches decoded parameters of at most 100 UTF-16 units.
    expect_error(
        &server.get(&format!("/api/profiles/{}", "a".repeat(101))).await,
        404,
        "NOT_FOUND",
    );
    expect_error(
        &server.get(&format!("/api/profiles/{}", "%20".repeat(100))).await,
        503,
        "CLOUD_UNAVAILABLE",
    );
    expect_error(
        &server.get(&format!("/api/profiles/{}/stats", "a".repeat(101))).await,
        404,
        "NOT_FOUND",
    );
    expect_error(
        &server.get(&format!("/api/profiles/{}/stats", "%20".repeat(100))).await,
        503,
        "CLOUD_UNAVAILABLE",
    );
}

#[tokio::test]
async fn reads_bodies_as_fastify_does() {
    let server = Server::start(None, true).await;
    let put = |content_type: &str, body: &str| {
        Init::method("PUT")
            .header("content-type", Some(content_type))
            .body(body)
    };
    // Malformed, empty or poisoned JSON is 400, as is any body that is not an object.
    for body in [
        r#"{"paused":"#,
        "not json",
        "{",
        "",
        r#"{"__proto__":{}}"#,
        r#"{"constructor":{"prototype":{}}}"#,
    ] {
        expect_error(
            &server.request("/api/local/cloud", put("application/json", body)).await,
            400,
            "INVALID_REQUEST",
        );
    }
    expect_error(
        &server
            .request("/api/local/cloud", put("Application/JSON; charset=utf-8", "[]"))
            .await,
        400,
        "INVALID_REQUEST",
    );
    expect_error(
        &server.request("/api/local/cloud", put("text/plain", "link")).await,
        400,
        "INVALID_REQUEST",
    );
    // Another media type, or a body without one, is 415.
    expect_error(
        &server
            .request("/api/local/cloud", put("application/xml", "<link/>"))
            .await,
        415,
        "INVALID_REQUEST",
    );
    let untyped = Init::method("POST").body("{}");
    expect_error(
        &server.request("/api/local/sync", untyped).await,
        415,
        "INVALID_REQUEST",
    );
    // Routes that ignore their body still parse it, and the global limit is 256,000 bytes.
    let broken = Init::method("POST")
        .header("content-type", Some("application/json"))
        .body("{");
    expect_error(&server.request("/api/local/sync", broken).await, 400, "INVALID_REQUEST");
    let large = format!(r#"{{"padding":"{}"}}"#, "x".repeat(256_000));
    let large = Init::method("POST")
        .header("content-type", Some("application/json"))
        .body(&large);
    expect_error(
        &server.request("/api/local/connect", large).await,
        413,
        "INVALID_REQUEST",
    );
    // An empty POST has no body to parse.
    expect_error(
        &server.request("/api/local/connect", Init::method("POST")).await,
        503,
        "CLOUD_UNAVAILABLE",
    );
}

#[tokio::test]
async fn serves_the_web_build_without_listing_or_escaping_it() {
    let server = Server::start(None, true).await;
    std::fs::create_dir_all(server.web_root.path().join("assets/nested")).unwrap();
    std::fs::write(server.web_root.path().join("assets/.secret"), "hidden").unwrap();
    for page in [
        "/",
        "/privacy",
        "/terms",
        "/support",
        "/leaderboard",
        "/you",
        "/join",
        "/tokens",
        "/achievements",
        "/settings",
        "/popover",
        "/u/Some-Builder",
        "/?view=today",
    ] {
        let reply = server.get(page).await;
        assert_eq!(reply.status, 200, "{page}");
        assert!(reply.text.contains("contract workspace"));
        assert!(reply.header("content-type").unwrap().starts_with("text/html"));
    }
    let asset = server.get("/assets/contract.js").await;
    assert_eq!((asset.status, asset.text.as_str()), (200, "/* contract asset */"));
    assert_eq!(asset.header("cache-control").as_deref(), Some("no-store"));
    let head = server.request("/assets/contract.js", Init::method("HEAD")).await;
    assert_eq!((head.status, head.text.as_str()), (200, ""));
    for path in [
        "/assets/missing.js",
        "/assets/nested",
        "/assets/nested/",
        "/assets/.secret",
        "/assets/",
        "/assets",
    ] {
        expect_error(&server.get(path).await, 404, "NOT_FOUND");
    }
    for path in [
        "/assets/../index.html",
        "/assets/%2e%2e/index.html",
        "/assets/nested/..%2f..%2findex.html",
    ] {
        expect_error(&server.get(path).await, 403, "INVALID_REQUEST");
    }
    // Without a web build every page is the JSON 404.
    std::fs::remove_file(server.web_root.path().join("index.html")).unwrap();
    expect_error(&server.get("/").await, 404, "NOT_FOUND");
}

#[tokio::test]
async fn serves_a_profile_page_only_for_an_alias_of_the_alias_pattern() {
    let server = Server::start(None, true).await;
    let long = "a".repeat(30);
    for alias in ["Some-Builder", "abc", "a_-", "0x9", long.as_str(), "Some%2DBuilder"] {
        let reply = server.get(&format!("/u/{alias}")).await;
        assert_eq!(reply.status, 200, "{alias}");
        assert!(reply.text.contains("contract workspace"));
        assert!(reply.header("content-type").unwrap().starts_with("text/html"));
    }
    let long = "a".repeat(31);
    for alias in [
        "x",
        "ab",
        long.as_str(),
        "-builder",
        "_builder",
        "bad.name",
        "bad%20name",
        "%C3%A9t%C3%A9",
        "Some-Builder/",
    ] {
        expect_error(&server.get(&format!("/u/{alias}")).await, 404, "NOT_FOUND");
    }
    // Without a web build a profile page is the JSON 404 too.
    std::fs::remove_file(server.web_root.path().join("index.html")).unwrap();
    expect_error(&server.get("/u/Some-Builder").await, 404, "NOT_FOUND");
}

/// The in-process transport: the router alone, with no session and no peer address.
fn in_process(web_root: &std::path::Path) -> Router {
    let client: Arc<dyn HttpClient> = ScriptedClient::new(|_| offline());
    let state = LocalState::new(memory_store(), Arc::new(MemorySecretStore::default()), client, None).unwrap();
    base_router(web_root, None, Router::new(), state)
}

async fn call(app: &Router, request: Request) -> (u16, axum::http::HeaderMap, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let (status, headers) = (response.status().as_u16(), response.headers().clone());
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn the_in_process_transport_needs_no_session_and_has_no_rate_limit() {
    let web = tempfile::tempdir().unwrap();
    let app = in_process(web.path());
    for _ in 0..300 {
        let (status, headers, body) = call(&app, Request::get("/api/health").body(Body::empty()).unwrap()).await;
        assert_eq!((status, &body["mode"]), (200, &json!("local")));
        assert_eq!(headers.get("x-ratelimit-limit"), None);
        for (name, value) in SECURITY_HEADERS {
            assert_eq!(headers.get(name).unwrap(), value);
        }
    }
    let (status, _, body) = call(&app, Request::post("/api/local/sync").body(Body::empty()).unwrap()).await;
    assert_eq!((status, &body["error"]["code"]), (409, &json!("CLOUD_NOT_LINKED")));
}

#[tokio::test(start_paused = true)]
async fn refuses_a_body_that_does_not_arrive_within_30_seconds() {
    let web = tempfile::tempdir().unwrap();
    let app = in_process(web.path());
    let (reader, _writer) = tokio::io::duplex(64);
    let request = Request::put("/api/local/cloud")
        .header("content-type", "application/json")
        .header("content-length", "100")
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(reader)))
        .unwrap();
    let (status, _, body) = call(&app, request).await;
    assert_eq!((status, &body["error"]["code"]), (408, &json!("INVALID_REQUEST")));
}

#[tokio::test(start_paused = true)]
async fn limits_each_tcp_client_to_240_requests_a_minute() {
    let web = tempfile::tempdir().unwrap();
    let from = |port: u16, path: &str| {
        let mut request = Request::get(path).body(Body::empty()).unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], port))));
        request
    };
    let app = in_process(web.path());
    let health = || from(50_000, "/api/health");
    // Unknown paths are not counted, as Fastify's 404 handler is not rate limited.
    for _ in 0..10 {
        assert_eq!(call(&app, from(50_000, "/api/nope")).await.0, 404);
    }
    for count in 1..=240u64 {
        let (status, headers, _) = call(&app, health()).await;
        assert_eq!(status, 200);
        assert_eq!(headers["x-ratelimit-limit"], "240");
        assert_eq!(headers["x-ratelimit-remaining"], (240 - count).to_string());
        assert_eq!(headers["x-ratelimit-reset"], "60");
    }
    let (status, headers, body) = call(&app, health()).await;
    assert_eq!((status, &body["error"]["code"]), (429, &json!("RATE_LIMITED")));
    assert_eq!(headers["retry-after"], "60");
    assert_eq!(headers["x-ratelimit-remaining"], "0");
    for (name, value) in SECURITY_HEADERS {
        assert_eq!(headers.get(name).unwrap(), value);
    }
    // Clients are counted by address, and each window lasts a minute from its first request.
    assert_eq!(call(&app, from(50_001, "/api/health")).await.0, 429);
    let mut elsewhere = Request::get("/api/health").body(Body::empty()).unwrap();
    elsewhere
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 2], 50_000))));
    assert_eq!(call(&app, elsewhere).await.0, 200);
    tokio::time::advance(std::time::Duration::from_secs(30)).await;
    let (status, headers, _) = call(&app, health()).await;
    assert_eq!((status, headers["retry-after"].to_str().unwrap()), (429, "30"));
    tokio::time::advance(std::time::Duration::from_secs(30)).await;
    let (status, headers, _) = call(&app, health()).await;
    assert_eq!(
        (status, headers["x-ratelimit-remaining"].to_str().unwrap()),
        (200, "239")
    );
}

#[tokio::test]
async fn serves_over_loopback_tcp_behind_the_session() {
    let web = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let session = tokentracky_local_api::LocalSession::new(&origin);
    let app = session.protect(in_process(web.path()));
    tokio::spawn(async move {
        let app = app.into_make_service_with_connect_info::<SocketAddr>();
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .unwrap();
    let health = format!("{origin}/api/health");
    assert_eq!(client.get(&health).send().await.unwrap().status(), 401);
    let launch = client.get(session.launch_url()).send().await.unwrap();
    assert_eq!(launch.status(), 200);
    let cookie = launch.headers()["set-cookie"].to_str().unwrap();
    let cookie = cookie.split(';').next().unwrap().to_owned();
    let reply = client.get(&health).header("cookie", cookie).send().await.unwrap();
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.headers()["x-ratelimit-remaining"], "239");
    assert_eq!(reply.headers()["cache-control"], "no-store");
    assert_eq!(reply.json::<Value>().await.unwrap()["mode"], "local");
}
