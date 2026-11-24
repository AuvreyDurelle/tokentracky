//! The window's URL boundary: the window renders only the app's own
//! origin, and links leave it for the browser only at the configured hosted origin.
use tokentracky_local_api::{DEFAULT_CLOUD_ORIGIN, LocalError, cloud_origin};
use url::Url;

/// The origin of the `app` scheme the windows load: `app://localhost` on macOS and Linux. WebView2 serves custom
/// schemes as `http://<scheme>.localhost`, and a page navigated there reports that origin.
#[cfg(not(windows))]
pub const ORIGIN: &str = "app://localhost";
#[cfg(windows)]
pub const ORIGIN: &str = "http://app.localhost";

/// Only the app's own origin is rendered in the window (`isSameLoopbackOrigin`).
pub fn is_app_url(value: &str) -> bool {
    is_at(value, ORIGIN)
}

/// Whether `value` is a URL at `origin`: the same scheme and host, and no other port.
fn is_at(value: &str, origin: &str) -> bool {
    let (Ok(url), Ok(origin)) = (Url::parse(value), Url::parse(origin)) else {
        return false;
    };
    url.scheme() == origin.scheme() && url.host_str() == origin.host_str() && url.port() == origin.port()
}

/// Downloads come only from the page's own blobs (the CSV export) or origin.
pub fn is_app_download(value: &str) -> bool {
    value
        .strip_prefix("blob:")
        .map_or_else(|| is_app_url(value), is_app_url)
}

/// Hosted links can leave the shell only when they match an already configured HTTPS origin.
pub fn is_allowed_external_url(value: &str, configured_cloud_url: Option<&str>) -> bool {
    let (Ok(destination), Some(Ok(configured))) = (Url::parse(value), configured_cloud_url.map(Url::parse)) else {
        return false;
    };
    destination.scheme() == "https" && configured.scheme() == "https" && destination.origin() == configured.origin()
}

/// Resolves the packaged default or an explicit override, reporting invalid overrides instead of dropping them.
pub fn configured_cloud_origin(value: Option<&str>) -> Result<String, LocalError> {
    let origin = cloud_origin(value.unwrap_or(DEFAULT_CLOUD_ORIGIN))?;
    // The Mac navigation boundary allows HTTPS only, including approval links.
    if !origin.starts_with("https://") {
        return Err(LocalError::new(
            400,
            "INVALID_CLOUD_URL",
            "The Mac leaderboard requires an HTTPS origin.",
        ));
    }
    Ok(origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn does_not_let_the_window_leave_its_own_origin() {
        assert!(is_app_url(&format!("{ORIGIN}/")));
        assert!(is_app_url(&format!("{ORIGIN}/leaderboard?period=week")));
        assert!(is_app_download(&format!(
            "blob:{ORIGIN}/5b8e4a0c-6f2d-4c1e-9a7b-3d2f1e0c9b8a"
        )));
        assert!(!is_app_url("https://example.com"));
        assert!(!is_app_download("blob:https://example.com/5b8e4a0c"));
        assert!(!is_app_download("https://example.com/usage.csv"));
    }

    #[test]
    fn loads_the_app_scheme_where_each_web_view_serves_it() {
        let expected = if cfg!(windows) {
            "http://app.localhost"
        } else {
            "app://localhost"
        };
        assert_eq!(ORIGIN, expected);
    }

    /// WKWebView and WebKitGTK: the scheme itself.
    #[test]
    fn accepts_only_app_localhost_at_the_app_scheme() {
        let origin = "app://localhost";
        assert!(is_at("app://localhost/", origin));
        assert!(is_at("app://localhost/leaderboard?period=week", origin));
        assert!(!is_at("app://localhost:4123/", origin));
        assert!(!is_at("app://localhost.example.test/", origin));
        assert!(!is_at("http://app.localhost/", origin));
        assert!(!is_at("not a url", origin));
    }

    /// WebView2: the scheme as a host of plain HTTP.
    #[test]
    fn accepts_only_http_app_localhost_at_webview2_s_origin() {
        let origin = "http://app.localhost";
        assert!(is_at("http://app.localhost/", origin));
        assert!(is_at("http://app.localhost/settings", origin));
        assert!(is_at("http://app.localhost:80/", origin));
        assert!(!is_at("http://app.localhost:8080/", origin));
        assert!(!is_at("https://app.localhost/", origin));
        assert!(!is_at("http://app.localhost.example.test/", origin));
        assert!(!is_at("http://localhost/", origin));
        assert!(!is_at("app://localhost/", origin));
    }

    #[test]
    fn permits_external_links_only_at_the_configured_https_origin() {
        let configured = Some("https://app.example.test");
        assert!(is_allowed_external_url("https://app.example.test/oauth", configured));
        assert!(!is_allowed_external_url("https://evil.example.test", configured));
        assert!(!is_allowed_external_url("http://app.example.test", configured));
        assert!(!is_allowed_external_url("https://app.example.test/oauth", None));
        assert!(!is_allowed_external_url(
            "http://127.0.0.1:4123/",
            Some("http://127.0.0.1:4123")
        ));
    }

    #[test]
    fn configures_only_a_bare_https_origin() {
        assert_eq!(
            configured_cloud_origin(Some("https://app.example.test/")),
            Ok("https://app.example.test".into())
        );
        for value in ["https://app.example.test/path", "https://user@app.example.test", ""] {
            assert!(configured_cloud_origin(Some(value)).is_err(), "{value}");
        }
        assert_eq!(configured_cloud_origin(None).unwrap(), DEFAULT_CLOUD_ORIGIN);
        assert!(configured_cloud_origin(Some("http://127.0.0.1:4123")).is_err());
    }
}
