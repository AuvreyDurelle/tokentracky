//! Protection of the loopback TCP transport (`apps/server/src/local-session.ts`): Host and Origin checks against DNS
//! rebinding and cross-origin writes, one-use launch links exchanged for an HttpOnly SameSite=Strict session cookie,
//! and that cookie on every request. The Mac app's in-process transport has no port and does not use it.
use crate::app::{content_security_policy, secure};
use crate::error::LocalError;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::time::Instant;
use url::Url;

/// The session cookie.
pub const COOKIE: &str = "tk_local";
/// A launch link works once, within this time.
pub const LAUNCH_TTL: Duration = Duration::from_secs(5 * 60);
/// Outstanding launch links; the oldest is dropped beyond this, bounding a long-running process.
pub const MAX_LAUNCH_TOKENS: usize = 32;

const BOOTSTRAP: &str = r#"window.location.replace("/");"#;
const RECOVERY_CSP: &str =
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const RECOVERY_PAGE: &str = r#"<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Tokentracky</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08080a;color:#f4f4f6;font:15px/1.6 ui-sans-serif,-apple-system,system-ui,sans-serif}main{max-width:560px;margin:24px;padding:32px;border:1px solid rgba(255,255,255,.1);border-radius:14px;background:#0f0f13}h1{font-size:22px;line-height:1.2;letter-spacing:-.02em}code{color:#b0a6ff}p{color:#a3a3b0}strong{color:#f4f4f6}</style><main><h1>Open a fresh workspace link</h1><p>This link has expired, was already used, or belongs to a previous app session. Launch links work once and expire after five minutes.</p><p><strong>Using the desktop app?</strong> Open Tokentracky from its app or tray icon.</p><p><strong>Using the local web app?</strong> Press Enter in the terminal running <code>npm run dev</code> to print a new link. If the server is stopped, run <code>npm run dev</code> from the project folder.</p><p>Keep the authenticated workspace tab open after launching. No account sign-in is needed for local tracking.</p></main></html>"#;

const ORIGIN_REJECTED: LocalError = LocalError::new(
    403,
    "ORIGIN_REJECTED",
    "This workspace accepts requests only from its local origin.",
);
const ORIGIN_REQUIRED: LocalError =
    LocalError::new(403, "ORIGIN_REQUIRED", "Local changes require the workspace origin.");

/// The session of one server process. Cheap to clone.
#[derive(Clone)]
pub struct LocalSession(Arc<Inner>);

struct Inner {
    base: Url,
    /// `URL.host` and `URL.origin` of the base.
    host: String,
    origin: String,
    token: String,
    /// Launch tokens and their expiry, oldest first.
    launch: Mutex<VecDeque<(String, Instant)>>,
    /// The base security headers for the session's own answers.
    csp: HeaderValue,
}

fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0; bytes];
    getrandom::fill(&mut buffer).expect("the system random source is available");
    URL_SAFE_NO_PAD.encode(buffer)
}

/// The header as Node presents it: repeated values joined with `, `, bytes outside UTF-8 replaced.
fn text(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    let mut values = headers.get_all(name).iter().peekable();
    values.peek()?;
    Some(
        values
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// `decodeURIComponent`, or `None` where it would throw.
fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))?;
            decoded.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// The first cookie called `name`, as the `cookie` package parses it: pairs split at `;` and their first `=`, names
/// and values trimmed of spaces and tabs, values URI-decoded when they contain `%` and decode cleanly.
fn cookie(header: &str, name: &str) -> Option<String> {
    let trim = |part: &str| part.trim_matches([' ', '\t']).to_owned();
    let len = header.len();
    let mut index = 0;
    while index < len {
        let eq = header[index..].find('=').map_or(len, |at| at + index);
        if eq == len {
            break;
        }
        let end = header[index..].find(';').map_or(len, |at| at + index);
        if eq > end {
            // A pair without `=`: start again after the last `;` before the next `=`.
            index = header[..eq].rfind(';').map_or(0, |at| at + 1);
            continue;
        }
        if trim(&header[index..eq]) == name {
            let value = trim(&header[eq + 1..end]);
            return Some(if value.contains('%') {
                decode_uri_component(&value).unwrap_or(value)
            } else {
                value
            });
        }
        index = end + 1;
    }
    None
}

impl LocalSession {
    /// `origin` is the server's own origin, `http://127.0.0.1:PORT`, known once the listener is bound.
    pub fn new(origin: &str) -> Self {
        let base = Url::parse(origin).expect("the server origin is a URL");
        let host = match base.port() {
            Some(port) => format!("{}:{port}", base.host_str().unwrap_or("")),
            None => base.host_str().unwrap_or("").to_owned(),
        };
        let csp = HeaderValue::try_from(content_security_policy(None)).expect("the policy is a header value");
        Self(Arc::new(Inner {
            origin: base.origin().ascii_serialization(),
            host,
            base,
            token: random_token(32),
            launch: Mutex::default(),
            csp,
        }))
    }

    fn launch(&self) -> MutexGuard<'_, VecDeque<(String, Instant)>> {
        self.0.launch.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A fresh one-use launch link: `ORIGIN/?launch=TOKEN`, 24 random bytes in base64url, valid for five minutes.
    pub fn launch_url(&self) -> String {
        let now = Instant::now();
        let token = random_token(24);
        let mut launch = self.launch();
        launch.retain(|(_, expiry)| *expiry > now);
        if launch.len() >= MAX_LAUNCH_TOKENS {
            launch.pop_front();
        }
        launch.push_back((token.clone(), now + LAUNCH_TTL));
        format!("{}/?launch={token}", self.0.origin)
    }

    /// Takes a launch token out; true if it existed and has not expired.
    fn redeem(&self, token: &str) -> bool {
        let mut launch = self.launch();
        let found = launch
            .iter()
            .position(|(known, _)| bool::from(known.as_bytes().ct_eq(token.as_bytes())));
        found
            .and_then(|index| launch.remove(index))
            .is_some_and(|(_, expiry)| expiry >= Instant::now())
    }

    /// `router` behind the session: wrap the finished router (after `with_state`) with this for the TCP transport.
    pub fn protect(&self, router: Router) -> Router {
        router.layer(middleware::from_fn_with_state(self.clone(), guard))
    }
}

async fn guard(State(session): State<LocalSession>, request: Request, next: Next) -> Response {
    let Some(mut response) = session.check(&request) else {
        return next.run(request).await;
    };
    // The session answers before the router, so it gives its own answers the base security headers.
    secure(response.headers_mut(), &session.0.csp);
    response
}

impl LocalSession {
    /// The session's own answer to `request`, or `None` when the request may pass.
    fn check(&self, request: &Request) -> Option<Response> {
        let inner = &self.0;
        let headers = request.headers();
        let host = headers
            .get(header::HOST)
            .map(|host| String::from_utf8_lossy(host.as_bytes()));
        let origin = text(headers, header::ORIGIN);
        if host.as_deref() != Some(inner.host.as_str())
            || origin
                .as_deref()
                .is_some_and(|origin| !origin.is_empty() && origin != inner.origin)
        {
            return Some(ORIGIN_REJECTED.into_response());
        }
        let url = inner.base.join(&request.uri().to_string()).ok();
        let root = url.as_ref().is_some_and(|url| url.path() == "/");
        let launch = url
            .as_ref()
            .and_then(|url| url.query_pairs().find(|(key, _)| key == "launch"))
            .map(|(_, token)| token.into_owned());
        if request.method() == Method::GET
            && root
            && let Some(token) = launch
        {
            return Some(if self.redeem(&token) {
                self.launch_page()
            } else {
                reject(request, root, 401)
            });
        }
        // A valid one-use launch token authorizes entry; other cross-site reads remain blocked.
        if text(headers, HeaderName::from_static("sec-fetch-site")).as_deref() == Some("cross-site") {
            return Some(reject(request, root, 403));
        }
        let cookie = text(headers, header::COOKIE)
            .and_then(|header| cookie(&header, COOKIE))
            .unwrap_or_default();
        if !bool::from(cookie.as_bytes().ct_eq(inner.token.as_bytes())) {
            return Some(reject(request, root, 401));
        }
        let safe = [Method::GET, Method::HEAD, Method::OPTIONS].contains(request.method());
        if !safe && origin.as_deref() != Some(inner.origin.as_str()) {
            return Some(ORIGIN_REQUIRED.into_response());
        }
        None
    }

    /// Sets the cookie and commits a local document before navigating to `/`: Strict cookies are omitted on
    /// cross-site redirect chains, including links opened from another app, and the token never stays in a URL.
    fn launch_page(&self) -> Response {
        let digest = STANDARD.encode(Sha256::digest(BOOTSTRAP));
        let page = format!(
            "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Opening Tokentracky</title><script>{BOOTSTRAP}</script><p>Opening your private workspace… <a href=\"/\">Continue</a></p></html>"
        );
        let headers = [
            (header::CONTENT_TYPE, "text/html".to_owned()),
            (
                header::SET_COOKIE,
                format!("{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", self.0.token),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                format!("default-src 'none'; script-src 'sha256-{digest}'; base-uri 'none'; frame-ancestors 'none'"),
            ),
        ];
        (headers, page).into_response()
    }
}

/// The browser asking for the workspace page gets recovery instructions; everything else the JSON refusal.
fn reject(request: &Request, root: bool, status: u16) -> Response {
    let accept = text(request.headers(), header::ACCEPT).unwrap_or_default();
    if request.method() == Method::GET && root && accept.contains("text/html") {
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::UNAUTHORIZED);
        let headers = [
            (header::CONTENT_TYPE, "text/html"),
            (header::CONTENT_SECURITY_POLICY, RECOVERY_CSP),
        ];
        return (status, headers, RECOVERY_PAGE).into_response();
    }
    LocalError::new(
        status,
        "LOCAL_AUTH_REQUIRED",
        "Open this workspace from the desktop app or its terminal launch link.",
    )
    .into_response()
}
