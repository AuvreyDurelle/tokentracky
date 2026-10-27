//! The window's URL boundary: the window renders only the app's own
//! origin, and links leave it for the browser only at the configured hosted origin.
use tokentracky_local_api::{DEFAULT_CLOUD_ORIGIN, LocalError, cloud_origin};
use url::Url;

/// The origin of the `app` scheme the window loads on macOS (Tauri serves it as `http://app.localhost` elsewhere).
pub const ORIGIN: &str = "app://localhost";

/// Only the app's own origin is rendered in the window (`isSameLoopbackOrigin`).
pub fn is_app_url(value: &str) -> bool {
    Url::parse(value)
        .is_ok_and(|url| url.scheme() == "app" && url.host_str() == Some("localhost") && url.port().is_none())
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
        assert!(is_app_url("app://localhost/"));
        assert!(is_app_url("app://localhost/leaderboard?period=week"));
        assert!(!is_app_url("app://localhost:4123/"));
        assert!(!is_app_url("app://localhost.example.test/"));
        assert!(!is_app_url("http://app.localhost/"));
        assert!(!is_app_url("https://example.com"));
        assert!(is_app_download(
            "blob:app://localhost/5b8e4a0c-6f2d-4c1e-9a7b-3d2f1e0c9b8a"
        ));
        assert!(!is_app_download("blob:https://example.com/5b8e4a0c"));
        assert!(!is_app_download("https://example.com/usage.csv"));
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
