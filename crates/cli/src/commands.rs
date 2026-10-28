//! `status`, `refresh`, `doctor`, `login`, `unlink` and `uninstall`; `serve` is in `serve.rs`.
use crate::args::Flags;
use crate::report::{report, text};
use crate::{CliError, Context, create_directory, database_path, other};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::sync::PoisonError;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};
use tokentracky_collector::detect::{DetectedTool, detect_tools};
use tokentracky_collector::limits::claude_config_file;
use tokentracky_collector::store::{StoreError, UsageStore};
use tokentracky_local_api::{ConnectStatus, DEFAULT_CLOUD_ORIGIN, LocalApp, LocalOptions, ReqwestClient, cloud_origin};
use tokentracky_pricing::bundled_table;

pub async fn status(directory: &Path, flags: &Flags, context: &mut Context) -> Result<i32, CliError> {
    let value = report(directory, context).await?;
    let output = if flags.json { json(&value) } else { text(&value) };
    context.out(&output);
    Ok(0)
}

/// `JSON.stringify(value, null, 2) + '\n'`.
fn json(value: &impl Serialize) -> String {
    serde_json::to_string_pretty(value).expect("reports serialize") + "\n"
}

/// `withCollector`: creates the data folder and opens the app on it, taking the lock on its database, which another
/// process may hold ([`CliError::Locked`]). It is the app `serve` serves, not started, without a hosted origin and
/// turning no tools on, so a command runs the same cycle and the same device connect as the server does.
fn open(directory: &Path, context: &Context) -> Result<LocalApp, CliError> {
    create_directory(directory)?;
    Ok(LocalApp::open(LocalOptions {
        database_path: database_path(directory),
        web_root: context.web_root.clone(),
        cloud_url: None,
        secrets: context.secrets(),
        client: Arc::new(ReqwestClient::new().map_err(other)?),
        pricing_refresh: context.pricing_refresh(),
        initially_paused: false,
        refresh_interval_ms: None,
        on_refresh: None,
        detected: Vec::new(),
        claude_config_file: Some(claude_config_file(|key| context.var(key), &context.home())),
    })?)
}

/// `collector.cycle.hasEnabledSource()`.
fn tracks_something(app: &LocalApp) -> bool {
    let store = app.state().store.lock().unwrap_or_else(PoisonError::into_inner);
    store
        .source_statuses()
        .is_ok_and(|sources| sources.iter().any(|source| source.enabled))
}

pub async fn refresh(directory: &Path, flags: &Flags, context: &mut Context) -> Result<i32, CliError> {
    let app = open(directory, context)?;
    if !tracks_something(&app) {
        context.err("Nothing is tracked yet. Run `tokentracky serve` and choose Start tracking.\n");
    }
    let cycle = app.refresh().await;
    let sync_error = app.state().sync.status().sync_error;
    // A store that fails to close has nothing more to tell the user; the lock is released with the process.
    let _ = app.close().await;
    // Any failure of the cycle is the generic line, as an error without a `code` is in TypeScript.
    cycle.map_err(other)?;
    if let Some(error) = sync_error {
        context.err(&format!(
            "Leaderboard sync failed ({error}); local totals are current and the next refresh retries.\n"
        ));
    }
    status(directory, flags, context).await
}

#[derive(Serialize)]
struct DoctorCheck {
    name: &'static str,
    ok: bool,
    detail: String,
}

/// The `doctor --json` document. The first check is `runtime`: the TypeScript CLI's `node` check, which asked for a
/// Node version; this binary has no Node, so it reports its own build instead.
#[derive(Serialize)]
struct Doctor {
    ok: bool,
    checks: Vec<DoctorCheck>,
    detected: Vec<DetectedTool>,
}

/// A file can be created in `directory`: a temporary one, unnamed or deleted on close, is created and dropped.
/// Truthful on every system, where `access(W_OK)` reads only Unix mode bits.
fn writable(directory: &Path) -> bool {
    tempfile::tempfile_in(directory).is_ok()
}

pub async fn doctor(directory: &Path, flags: &Flags, context: &mut Context) -> Result<i32, CliError> {
    let check = |name, ok, detail: String| DoctorCheck { name, ok, detail };
    let mut checks = vec![check(
        "runtime",
        true,
        format!("Tokentracky {} (native build, no Node.js needed)", context.version),
    )];
    let sqlite = UsageStore::open(":memory:").is_ok();
    checks.push(check(
        "sqlite",
        sqlite,
        format!("SQLite is {}", if sqlite { "available" } else { "unavailable" }),
    ));
    let usable = create_directory(directory).is_ok() && writable(directory);
    checks.push(check(
        "data",
        usable,
        format!(
            "{} is {}writable",
            directory.display(),
            if usable { "" } else { "not " }
        ),
    ));
    let value = report(directory, context).await.ok();
    checks.push(match &value {
        Some(value) => {
            let state = if value.running {
                "in use by a running Tokentracky (checked read-only)"
            } else if database_path(directory).exists() {
                "readable"
            } else {
                "not created yet"
            };
            check("database", true, format!("Database: {state}"))
        }
        None => check("database", false, "The usage database could not be opened".to_owned()),
    });
    let home = context.home();
    let detected = detect_tools(|name| context.var(name), &home);
    let found = detected
        .iter()
        .map(|tool| format!("{} ({})", tool.name, tool.paths.join(", ")))
        .collect::<Vec<_>>();
    checks.push(check(
        "tools",
        true,
        if found.is_empty() {
            "Tools: no supported tool folders found".to_owned()
        } else {
            format!("Tools: found {}", found.join("; "))
        },
    ));
    if let Some(value) = &value {
        let board = &value.leaderboard;
        let state = match (&board.url, board.error) {
            (Some(url), _) if board.linked => format!("linked to {url}"),
            (_, Some(_)) => "credential store unavailable".to_owned(),
            _ => "not linked".to_owned(),
        };
        checks.push(check(
            "leaderboard",
            board.error.is_none(),
            format!("Leaderboard: {state}"),
        ));
        let last = value.last_refresh_at.as_deref().unwrap_or("never");
        checks.push(check("refresh", true, format!("Last refresh: {last}")));
    }
    let prices = value
        .as_ref()
        .map_or_else(|| bundled_table().version().to_owned(), |v| v.pricing_version.clone());
    let refresh = if context.pricing_refresh() { "on" } else { "off" };
    checks.push(check(
        "pricing",
        true,
        format!("Prices {prices}, daily refresh {refresh}"),
    ));
    let ok = checks.iter().all(|check| check.ok);
    let output = if flags.json {
        json(&Doctor { ok, checks, detected })
    } else {
        let lines: Vec<String> = checks
            .iter()
            .map(|check| format!("{} {}", if check.ok { "✓" } else { "✗" }, check.detail))
            .collect();
        lines.join("\n") + "\n"
    };
    context.out(&output);
    Ok(if ok { 0 } else { 1 })
}

/// `Date.prototype.toLocaleTimeString()` in the `en-US` form: `2:05:00 PM`.
fn clock(expires_at: &str, offset: UtcOffset) -> String {
    let Ok(at) = OffsetDateTime::parse(expires_at, &Rfc3339) else {
        return "Invalid Date".to_owned();
    };
    let at = at.to_offset(offset);
    let hour = match at.hour() % 12 {
        0 => 12,
        hour => hour,
    };
    let half = if at.hour() < 12 { "AM" } else { "PM" };
    format!("{hour}:{:02}:{:02} {half}", at.minute(), at.second())
}

pub async fn login(directory: &Path, flags: &Flags, context: &mut Context) -> Result<i32, CliError> {
    let Some(store) = context.secret_store.clone() else {
        context
            .err("Staying signed in needs a credential store. Use `tokentracky serve` and join from the dashboard.\n");
        return Ok(1);
    };
    let stored = store.get().await.ok().flatten();
    // A saved link owns the credential and its server. Overrides only select a server for a fresh connection.
    let configured = login_cloud_url(
        stored.map(|link| link.url),
        flags.cloud_url.clone(),
        context.var("TOKENTRACKY_CLOUD_URL"),
    );
    let origin = cloud_origin(&configured)?;
    let app = open(directory, context)?;
    let alias = approval(&app, &origin, context).await;
    let _ = app.close().await;
    match alias? {
        Some(alias) => {
            context.out(&format!(
                "Connected as {alias}. This computer now uploads its daily totals every 5 minutes.\n"
            ));
            Ok(0)
        }
        None => {
            context.err("The code expired before it was approved. Run `tokentracky login` again.\n");
            Ok(1)
        }
    }
}

fn login_cloud_url(saved: Option<String>, flag: Option<String>, env: Option<String>) -> String {
    saved
        .or(flag)
        .or(env)
        .unwrap_or_else(|| DEFAULT_CLOUD_ORIGIN.to_owned())
}

/// Starts the browser approval and waits for it: the alias once approved, `None` if the code expires first.
async fn approval(app: &LocalApp, origin: &str, context: &mut Context) -> Result<Option<String>, CliError> {
    let connect = app.state().connect.clone();
    let started = connect.start(origin).await?;
    context.out(&format!(
        "Your code: {}\nApprove this computer at {}\nWaiting for approval (the code expires at {})…\n",
        started.user_code,
        started.verification_url,
        clock(&started.expires_at, context.utc_offset)
    ));
    let (open, url) = (context.open_url.clone(), started.verification_url);
    let _ = tokio::task::spawn_blocking(move || open(&url)).await;
    loop {
        tokio::time::sleep(context.poll_interval).await;
        match connect.poll().await? {
            ConnectStatus::Connected { alias } => return Ok(Some(alias)),
            ConnectStatus::Expired => return Ok(None),
            ConnectStatus::Pending => {}
        }
    }
}

pub async fn unlink(context: &mut Context) -> Result<i32, CliError> {
    context.secrets().clear().await.map_err(|_| CliError::Other)?;
    context.out("This computer no longer uploads to the leaderboard. Your public profile stays until you leave on the website.\n");
    Ok(0)
}

pub async fn uninstall(directory: &Path, flags: &Flags, context: &mut Context) -> Result<i32, CliError> {
    let question = format!(
        "Delete {} and this computer's leaderboard credential? [y/N] ",
        directory.display()
    );
    let confirmed = flags.yes || (context.interactive && (context.confirm)(&question));
    if !confirmed {
        context.err("Nothing was deleted. Run `tokentracky uninstall --yes` to confirm.\n");
        return Ok(1);
    }
    if database_path(directory).exists() {
        // Only the lock matters; any other failure to open is left to the removal below.
        match UsageStore::open(database_path(directory)) {
            Ok(store) => drop(store.close()),
            Err(error @ StoreError::CollectorDatabaseLocked(_)) => return Err(error.into()),
            Err(_) => {}
        }
    }
    if let Some(store) = &context.secret_store {
        let _ = store.clear().await;
    }
    // `rm(directory, {recursive: true, force: true})`.
    match std::fs::symlink_metadata(directory) {
        Ok(entry) if entry.is_dir() => std::fs::remove_dir_all(directory)?,
        Ok(_) => std::fs::remove_file(directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    context.out(&format!(
        "Removed {}. Tokentracky never changed your tools' settings, so there is nothing else to undo.\n",
        directory.display()
    ));
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::login_cloud_url;
    use tokentracky_local_api::DEFAULT_CLOUD_ORIGIN;

    #[test]
    fn login_uses_the_packaged_origin_when_unconfigured() {
        assert_eq!(login_cloud_url(None, None, None), DEFAULT_CLOUD_ORIGIN);
    }

    #[test]
    fn login_flags_override_environment_without_a_saved_link() {
        assert_eq!(
            login_cloud_url(
                None,
                Some("https://flag.example".into()),
                Some("https://env.example".into())
            ),
            "https://flag.example"
        );
        assert_eq!(
            login_cloud_url(None, None, Some("https://env.example".into())),
            "https://env.example"
        );
    }

    #[test]
    fn saved_login_link_precedes_flag_and_environment() {
        assert_eq!(
            login_cloud_url(
                Some("https://saved.example".into()),
                Some("ftp://invalid.example".into()),
                Some("https://env.example".into())
            ),
            "https://saved.example"
        );
    }
}
