//! `serve`: the private dashboard on a loopback port, with the 5-minute refresh cycle. The app is `crates/local-api`'s
//! `LocalApp`, put on loopback behind the launch-link session by its `serve_tcp`.
use crate::args::Flags;
use crate::{CliError, Context, create_directory, database_path, other};
use std::path::Path;
use std::sync::Arc;
use tokentracky_collector::detect::detect_tools;
use tokentracky_collector::limits::claude_config_file;
use tokentracky_collector::scheduler::refresh_interval;
use tokentracky_local_api::{
    DEFAULT_CLOUD_ORIGIN, LocalApp, LocalError, LocalOptions, LocalSession, ReqwestClient, cloud_origin, serve_tcp,
};

/// What the `on_serve` hook gets: where the server is, and fresh launch links (`{url, launchUrl}`).
#[derive(Clone)]
pub struct ServeHandle {
    pub url: String,
    session: LocalSession,
}

fn serve_cloud_url(flag: Option<String>, env: Option<String>, linked: bool) -> Result<Option<String>, LocalError> {
    match cloud_origin(&flag.or(env).unwrap_or_else(|| DEFAULT_CLOUD_ORIGIN.to_owned())) {
        Ok(origin) => Ok(Some(origin)),
        // An existing link owns its origin. An invalid, unused override must not prevent serving it.
        Err(_) if linked => Ok(None),
        Err(error) => Err(error),
    }
}

impl ServeHandle {
    /// A one-use link that opens the dashboard; it expires in five minutes.
    pub fn launch_url(&self) -> String {
        self.session.launch_url()
    }
}

pub async fn serve(directory: &Path, flags: &Flags, context: &mut Context) -> Result<i32, CliError> {
    create_directory(directory)?;
    let secrets = context.secrets();
    let linked = secrets.get().await.ok().flatten().is_some();
    let cloud_url = serve_cloud_url(flags.cloud_url.clone(), context.var("TOKENTRACKY_CLOUD_URL"), linked)?;
    let refresh_interval_ms =
        refresh_interval(context.var("TOKENTRACKY_REFRESH_INTERVAL_MS").as_deref()).map_err(other)?;
    let app = LocalApp::open(LocalOptions {
        database_path: database_path(directory),
        web_root: context.web_root.clone(),
        cloud_url,
        secrets,
        client: Arc::new(ReqwestClient::new().map_err(other)?),
        pricing_refresh: context.pricing_refresh(),
        initially_paused: false,
        refresh_interval_ms: Some(refresh_interval_ms),
        on_refresh: None,
        detected: detect_tools(|key| context.var(key), &context.home()),
        claude_config_file: Some(claude_config_file(|key| context.var(key), &context.home())),
    })?;
    // Binds, starts the refresh cycle, and closes the app if the port cannot be bound.
    let server = serve_tcp(app, flags.port.unwrap_or(0)).await?;
    let again = if context.interactive {
        " Press Enter for a fresh link."
    } else {
        ""
    };
    context.out(&format!(
        "Open your private dashboard: {}\nThis link works once and expires in five minutes.{again}\n",
        server.launch_url()
    ));
    if context.secret_store.is_none() {
        context.out("Leaderboard credentials are kept only while this process runs.\n");
    }
    if context.interactive {
        // A link of its own, so the printed one still works in another browser.
        let (open, url) = (context.open_url.clone(), server.launch_url());
        let _ = tokio::task::spawn_blocking(move || open(&url)).await;
    }
    if let Some(on_serve) = &context.on_serve {
        let handle = ServeHandle {
            url: server.url().to_owned(),
            session: server.session().clone(),
        };
        on_serve(handle).await;
    }
    // A store that fails to close has nothing more to tell the user; the lock is released with the process.
    let _ = server.close().await;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::serve_cloud_url;
    use tokentracky_local_api::DEFAULT_CLOUD_ORIGIN;

    #[test]
    fn serve_uses_packaged_default_and_flag_precedence() {
        assert_eq!(
            serve_cloud_url(None, None, false).unwrap().as_deref(),
            Some(DEFAULT_CLOUD_ORIGIN)
        );
        assert_eq!(
            serve_cloud_url(
                Some("https://flag.example".into()),
                Some("https://env.example".into()),
                false
            )
            .unwrap(),
            Some("https://flag.example".into())
        );
        assert_eq!(
            serve_cloud_url(None, Some("https://env.example".into()), false).unwrap(),
            Some("https://env.example".into())
        );
    }

    #[test]
    fn invalid_unused_override_does_not_block_saved_connection() {
        assert_eq!(serve_cloud_url(Some("bad".into()), None, true).unwrap(), None);
        assert!(serve_cloud_url(Some("bad".into()), None, false).is_err());
        // Keep the valid fallback available after unlink, even when starting linked.
        assert_eq!(
            serve_cloud_url(None, None, true).unwrap().as_deref(),
            Some(DEFAULT_CLOUD_ORIGIN)
        );
    }
}
