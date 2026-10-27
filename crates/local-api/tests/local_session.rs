//! `apps/server/src/local-session.test.ts`, case for case: loopback workspace authentication, on a bare router.
use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::time::Duration;
use tokentracky_local_api::LocalSession;
use tower::ServiceExt;

struct Answer {
    status: u16,
    headers: axum::http::HeaderMap,
    body: String,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|value| value.to_str().unwrap())
    }
}

fn fixture() -> (Router, LocalSession) {
    let session = LocalSession::new("http://127.0.0.1:4771");
    let app = Router::new()
        .route("/", get(|| async { "workspace" }))
        .route("/api/local/status", get(|| async { Json(json!({"private": true})) }))
        .route("/api/local/scan", post(|| async { Json(json!({"ok": true})) }));
    (session.protect(app), session)
}

async fn inject(app: &Router, method: &str, url: &str, headers: &[(&str, &str)]) -> Answer {
    let mut request = Request::builder().method(method).uri(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Answer {
        status,
        headers,
        body: String::from_utf8(body.to_vec()).unwrap(),
    }
}

const HOST: (&str, &str) = ("host", "127.0.0.1:4771");

#[tokio::test]
async fn requires_the_one_time_launch_link_and_never_leaves_the_token_in_the_url() {
    let (app, session) = fixture();
    assert_eq!(inject(&app, "GET", "/api/local/status", &[HOST]).await.status, 401);
    let link = session.launch_url();
    let response = inject(&app, "GET", &link, &[HOST, ("sec-fetch-site", "cross-site")]).await;
    assert_eq!(response.status, 200);
    assert!(response.body.contains(r#"window.location.replace("/")"#));
    assert!(
        response
            .header("content-security-policy")
            .unwrap()
            .contains("script-src 'sha256-")
    );
    assert_eq!(response.header("cache-control"), Some("no-store"));
    let set_cookie = response.header("set-cookie").unwrap();
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Strict"));
    let cookie = set_cookie.split(';').next().unwrap();
    assert_eq!(inject(&app, "GET", &link, &[HOST]).await.status, 401);
    assert_eq!(
        inject(&app, "GET", "/api/local/status", &[HOST, ("cookie", cookie)])
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn rejects_dns_rebinding_cross_site_reads_and_cross_origin_mutations_even_with_a_valid_cookie() {
    let (app, session) = fixture();
    let response = inject(&app, "GET", &session.launch_url(), &[HOST]).await;
    let set_cookie = response.header("set-cookie").unwrap().to_owned();
    let cookie = ("cookie", set_cookie.split(';').next().unwrap());
    let cases = [
        ("GET", "/api/local/status", vec![("host", "evil.example:4771")], 403),
        (
            "GET",
            "/api/local/status",
            vec![HOST, ("sec-fetch-site", "cross-site")],
            403,
        ),
        (
            "POST",
            "/api/local/scan",
            vec![HOST, ("origin", "https://evil.example")],
            403,
        ),
        ("POST", "/api/local/scan", vec![HOST], 403),
        (
            "POST",
            "/api/local/scan",
            vec![HOST, ("origin", "http://127.0.0.1:4771")],
            200,
        ),
    ];
    for (method, url, mut headers, status) in cases {
        headers.push(cookie);
        assert_eq!(
            inject(&app, method, url, &headers).await.status,
            status,
            "{method} {url} {headers:?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn shows_recovery_instructions_for_expired_browser_links_without_authorizing_private_apis() {
    let (app, session) = fixture();
    let expired = session.launch_url();
    tokio::time::advance(Duration::from_secs(6 * 60)).await;
    let headers = [HOST, ("accept", "text/html")];
    let response = inject(&app, "GET", &expired, &headers).await;
    assert_eq!(response.status, 401);
    assert!(response.header("content-type").unwrap().contains("text/html"));
    assert!(response.body.contains("Open a fresh workspace link"));
    assert!(response.body.contains("Press Enter"));
    let token = expired.split("launch=").nth(1).unwrap();
    assert!(!response.body.contains(token));
    assert_eq!(response.header("set-cookie"), None);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert!(
        response
            .header("content-security-policy")
            .unwrap()
            .contains("default-src 'none'")
    );
    let api = inject(&app, "GET", "/api/local/status", &headers).await;
    assert_eq!(api.status, 401);
    let body: Value = serde_json::from_str(&api.body).unwrap();
    assert_eq!(body["error"]["code"], "LOCAL_AUTH_REQUIRED");
    let fresh = inject(&app, "GET", &session.launch_url(), &headers).await;
    assert_eq!(fresh.status, 200);
    assert!(fresh.header("set-cookie").unwrap().contains("HttpOnly"));
}

#[tokio::test(start_paused = true)]
async fn keeps_at_most_32_launch_links_dropping_the_oldest() {
    let (app, session) = fixture();
    let links: Vec<String> = (0..33).map(|_| session.launch_url()).collect();
    assert_eq!(inject(&app, "GET", &links[0], &[HOST]).await.status, 401);
    assert_eq!(inject(&app, "GET", &links[1], &[HOST]).await.status, 200);
    let token = links[32].split("launch=").nth(1).unwrap();
    assert_eq!(token.len(), 32, "24 random bytes in base64url");
    assert!(
        token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    );
    // Exactly five minutes is still valid; expired links are dropped when the next one is made.
    tokio::time::advance(Duration::from_secs(5 * 60)).await;
    assert_eq!(inject(&app, "GET", &links[2], &[HOST]).await.status, 200);
    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(inject(&app, "GET", &links[3], &[HOST]).await.status, 401);
}
