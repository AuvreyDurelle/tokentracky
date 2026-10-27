//! `/api/shell/*`: what the app's own pages may ask of the app. Same-origin HTTP through the `app://` handler, so the
//! web views keep zero IPC permissions. Downloading and installing updates stay in the native menu.
//!
//! `GET state`, `PUT launch-at-login` and `POST check-updates` answer the [`state`]; `POST open-dashboard`, `menu`
//! and `quit` answer 204. Refusals ([`Refusal`]) use the local API's error shape; a body over [`BODY_LIMIT`] is refused
//! before it is read. The CLI's server has none of these routes, so there they are its JSON 404, and the page hides
//! their controls.
use crate::menu::UpdateState;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use std::path::Path;
use tokentracky_local_api::{LocalError, content_security_policy, secure};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellRequest {
    State,
    /// `{"enabled": bool}`.
    LaunchAtLogin(bool),
    /// `{"page": ..}`, one of [`PAGES`]: the dashboard at that page, opened if closed.
    OpenDashboard(&'static str),
    /// What the menu's "Check for updates" does; nothing in a build without the updater.
    CheckForUpdates,
    /// The native gear menu, at the pointer, over the window that asked.
    GearMenu,
    Quit,
}

/// The dashboard pages a page may open.
const PAGES: [&str; 5] = ["/", "/tokens", "/achievements", "/settings", "/leaderboard"];
/// The largest body a shell request may carry, as `PUT /api/local/cloud` allows.
pub const BODY_LIMIT: usize = 4096;

/// Why a shell request is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NotFound,
    /// A known action with another method; the method it takes.
    MethodNotAllowed(&'static str),
    /// Not a JSON object with the action's field.
    InvalidBody,
    /// `open-dashboard` with a page outside [`PAGES`].
    InvalidPage,
    /// A body over [`BODY_LIMIT`].
    TooLarge,
}

/// `None` for any path outside `/api/shell/`, which the router serves; else the request or why it is refused.
pub fn parse(method: &str, path: &str, body: &[u8]) -> Option<Result<ShellRequest, Refusal>> {
    let action = path.strip_prefix("/api/shell/")?;
    if body.len() > BODY_LIMIT {
        return Some(Err(Refusal::TooLarge));
    }
    let field = |key: &str| {
        serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|value| value.get(key).cloned())
    };
    Some(match (method, action) {
        ("GET", "state") => Ok(ShellRequest::State),
        ("PUT", "launch-at-login") => field("enabled")
            .as_ref()
            .and_then(Value::as_bool)
            .map(ShellRequest::LaunchAtLogin)
            .ok_or(Refusal::InvalidBody),
        ("POST", "open-dashboard") => match field("page").as_ref().and_then(Value::as_str) {
            Some(page) => PAGES
                .into_iter()
                .find(|known| *known == page)
                .map(ShellRequest::OpenDashboard)
                .ok_or(Refusal::InvalidPage),
            None => Err(Refusal::InvalidBody),
        },
        ("POST", "check-updates") => Ok(ShellRequest::CheckForUpdates),
        ("POST", "menu") => Ok(ShellRequest::GearMenu),
        ("POST", "quit") => Ok(ShellRequest::Quit),
        (_, "state") => Err(Refusal::MethodNotAllowed("GET")),
        (_, "launch-at-login") => Err(Refusal::MethodNotAllowed("PUT")),
        (_, "open-dashboard" | "check-updates" | "menu" | "quit") => Err(Refusal::MethodNotAllowed("POST")),
        _ => Err(Refusal::NotFound),
    })
}

/// `{launchAtLogin, update: {state, version}, version}`: `update.version` is the update's while one is available,
/// downloading or ready, else `null`; `version` is the app's.
pub fn state(launch_at_login: bool, update: &UpdateState, version: &str) -> Value {
    let (state, update_version) = match update {
        UpdateState::Disabled => ("disabled", None),
        UpdateState::Idle => ("idle", None),
        UpdateState::Checking => ("checking", None),
        UpdateState::Available(version) => ("available", Some(version)),
        UpdateState::Downloading(version) => ("downloading", Some(version)),
        UpdateState::Ready(version) => ("ready", Some(version)),
    };
    json!({
        "launchAtLogin": launch_at_login,
        "update": {"state": state, "version": update_version},
        "version": version,
    })
}

/// The file in the app's own settings folder that records launch at login was turned on by default.
pub const LAUNCH_AT_LOGIN_SET: &str = "launch-at-login-set";

/// Turns launch at login on (`enable`, true once it is on) the first time the app runs, recorded by `marker`; after
/// that it stays as the user leaves it. A failed attempt is not recorded, so the next launch tries again.
pub fn launch_at_login_once(marker: &Path, enable: impl FnOnce() -> bool) {
    if !marker.exists() && enable() {
        let _ = marker
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(marker, ""));
    }
}

/// A JSON body with 200, no body with 204, or the refusal (405 with `Allow`); all with the router's headers.
pub fn respond(result: Result<Option<Value>, Refusal>) -> Response {
    let mut response = match result {
        Ok(Some(body)) => tokentracky_local_api::json(StatusCode::OK, &body),
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(refusal) => {
            let mut response = match refusal {
                Refusal::NotFound => LocalError::not_found(),
                Refusal::MethodNotAllowed(_) => {
                    LocalError::new(405, "METHOD_NOT_ALLOWED", "This method is not allowed here.")
                }
                Refusal::InvalidBody => LocalError::new(400, "INVALID_BODY", "Request contains invalid fields."),
                Refusal::InvalidPage => LocalError::new(400, "INVALID_PAGE", "This page cannot be opened in the app."),
                // What the router answers a body over a route's limit.
                Refusal::TooLarge => LocalError::from_status(413),
            }
            .into_response();
            if let Refusal::MethodNotAllowed(method) = refusal {
                response
                    .headers_mut()
                    .insert(header::ALLOW, HeaderValue::from_static(method));
            }
            response
        }
    };
    let csp = HeaderValue::try_from(content_security_policy(None)).expect("the fixed policy is a header value");
    secure(response.headers_mut(), &csp);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::menu::UpdateState;
    use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
    use serde_json::{Value, json};
    use tokentracky_local_api::content_security_policy;

    #[test]
    fn parses_shell_requests() {
        assert_eq!(parse("GET", "/api/shell/state", b""), Some(Ok(ShellRequest::State)));
        assert_eq!(
            parse("PUT", "/api/shell/launch-at-login", br#"{"enabled":true}"#),
            Some(Ok(ShellRequest::LaunchAtLogin(true)))
        );
        assert_eq!(
            parse("POST", "/api/shell/open-dashboard", br#"{"page":"/settings"}"#),
            Some(Ok(ShellRequest::OpenDashboard("/settings")))
        );
        assert_eq!(
            parse("POST", "/api/shell/check-updates", b""),
            Some(Ok(ShellRequest::CheckForUpdates))
        );
        assert_eq!(parse("POST", "/api/shell/menu", b""), Some(Ok(ShellRequest::GearMenu)));
        assert_eq!(parse("POST", "/api/shell/quit", b""), Some(Ok(ShellRequest::Quit)));
        assert_eq!(parse("GET", "/api/local/status", b""), None); // not a shell route: the router serves it
    }

    #[test]
    fn refuses_unknown_actions_other_methods_and_invalid_bodies() {
        let evil = br#"{"page":"https://evil.example"}"#;
        assert_eq!(
            parse("POST", "/api/shell/open-dashboard", evil),
            Some(Err(Refusal::InvalidPage))
        );
        assert_eq!(
            parse("GET", "/api/shell/quit", b""),
            Some(Err(Refusal::MethodNotAllowed("POST")))
        );
        assert_eq!(
            parse("POST", "/api/shell/state", b""),
            Some(Err(Refusal::MethodNotAllowed("GET")))
        );
        assert_eq!(parse("GET", "/api/shell/unknown", b""), Some(Err(Refusal::NotFound)));
        assert_eq!(parse("GET", "/api/shell/", b""), Some(Err(Refusal::NotFound)));
        for body in [&br#"{"enabled":"yes"}"#[..], b"", b"enabled=true", b"[true]"] {
            assert_eq!(
                parse("PUT", "/api/shell/launch-at-login", body),
                Some(Err(Refusal::InvalidBody)),
                "{body:?}"
            );
        }
        for body in [&b"<html>"[..], b"", br#"{"page":5}"#, br#"{"path":"/"}"#] {
            assert_eq!(
                parse("POST", "/api/shell/open-dashboard", body),
                Some(Err(Refusal::InvalidBody)),
                "{body:?}"
            );
        }
        let oversize = [b' '; BODY_LIMIT + 1];
        assert_eq!(
            parse("POST", "/api/shell/menu", &oversize),
            Some(Err(Refusal::TooLarge))
        );
        assert_eq!(
            parse("POST", "/api/shell/menu", &oversize[1..]),
            Some(Ok(ShellRequest::GearMenu))
        );
    }

    #[test]
    fn describes_launch_at_login_the_update_and_the_version() {
        assert_eq!(
            state(true, &UpdateState::Disabled, "0.1.0"),
            json!({"launchAtLogin": true, "update": {"state": "disabled", "version": null}, "version": "0.1.0"})
        );
        assert_eq!(
            state(false, &UpdateState::Available("0.2.0".into()), "0.1.0")["update"],
            json!({"state": "available", "version": "0.2.0"})
        );
    }

    #[test]
    fn turns_launch_at_login_on_only_the_first_time() {
        let config = tempfile::tempdir().unwrap();
        let marker = config.path().join("com.tokentracky.desktop").join(LAUNCH_AT_LOGIN_SET);
        // A failed attempt is not recorded, so the next launch tries again.
        launch_at_login_once(&marker, || false);
        assert!(!marker.exists());
        let mut enabled = 0;
        for _ in 0..3 {
            launch_at_login_once(&marker, || {
                enabled += 1;
                true
            });
        }
        assert_eq!(enabled, 1);
        assert!(marker.exists());
    }

    async fn parts(response: axum::response::Response) -> (StatusCode, header::HeaderMap, Vec<u8>) {
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        (parts.status, parts.headers, bytes.to_vec())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn answers_with_the_local_api_error_shape() {
        let (status, headers, body) = parts(respond(Err(Refusal::MethodNotAllowed("POST")))).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(headers[header::ALLOW], "POST");
        let error: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(error["error"]["code"], "METHOD_NOT_ALLOWED");
        assert!(error["error"]["message"].is_string());
        for (refusal, status, code) in [
            (Refusal::InvalidBody, 400, "INVALID_BODY"),
            (Refusal::InvalidPage, 400, "INVALID_PAGE"),
            (Refusal::NotFound, 404, "NOT_FOUND"),
            (Refusal::TooLarge, 413, "INVALID_REQUEST"),
        ] {
            let (answered, headers, body) = parts(respond(Err(refusal))).await;
            let error: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                (answered.as_u16(), error["error"]["code"].as_str()),
                (status, Some(code))
            );
            assert!(!headers.contains_key(header::ALLOW));
        }
        let (status, ok_headers, body) = parts(respond(Ok(Some(json!({"a": 1}))))).await;
        assert_eq!((status, body), (StatusCode::OK, br#"{"a":1}"#.to_vec()));
        assert_eq!(ok_headers[header::CONTENT_TYPE], tokentracky_local_api::JSON);
        let (status, _, body) = parts(respond(Ok(None))).await;
        assert_eq!((status, body.is_empty()), (StatusCode::NO_CONTENT, true));
    }

    /// Every answer carries the security headers the router sets on its own.
    #[test]
    fn answers_with_the_router_s_security_headers() {
        let csp = HeaderValue::try_from(content_security_policy(None)).unwrap();
        let mut expected = HeaderMap::new();
        tokentracky_local_api::secure(&mut expected, &csp);
        assert!(expected.contains_key(header::CONTENT_SECURITY_POLICY));
        for response in [
            respond(Ok(None)),
            respond(Ok(Some(json!({})))),
            respond(Err(Refusal::NotFound)),
        ] {
            for (name, value) in &expected {
                assert_eq!(response.headers().get(name), Some(value), "{name}");
            }
        }
    }
}
