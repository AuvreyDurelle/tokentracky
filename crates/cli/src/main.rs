//! The `tokentracky` binary: connects the command library to process I/O, signals and the local service.
use std::io::{BufRead, IsTerminal, Write};
use std::process::{Command, ExitCode, Stdio};
use std::sync::Arc;
use std::time::Duration;
use time::UtcOffset;
use tokentracky_cli::{Context, OnServe, ServeHandle, run};
use tokentracky_local_api::SecretStore;
use tokio::sync::mpsc;

mod web;

/// A private file in the data folder, shared with the Mac app; other systems have no persistent credential store yet.
fn secret_store() -> Result<Option<Arc<dyn SecretStore>>, tokentracky_local_api::SecretError> {
    #[cfg(target_os = "macos")]
    return Ok(Some(Arc::new(tokentracky_secrets::FileSecretStore::from_env()?)));
    #[cfg(not(target_os = "macos"))]
    Ok(None)
}

fn open_url(url: &str) {
    // `url` is always an http(s) origin's page, so Windows' URL handler opens it in the browser.
    let (opener, options): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("open", &[])
    } else if cfg!(windows) {
        ("rundll32", &["url.dll,FileProtocolHandler"])
    } else {
        ("xdg-open", &[])
    };
    let silent = || Stdio::null();
    let _ = Command::new(opener)
        .args(options)
        .arg(url)
        .stdin(silent())
        .stdout(silent())
        .stderr(silent())
        .status();
}

/// `y` or `yes`, any case, after the question on the terminal.
fn confirm(question: &str) -> bool {
    print!("{question}");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    let _ = std::io::stdin().lock().read_line(&mut answer);
    matches!(answer.trim().to_lowercase().as_str(), "y" | "yes")
}

/// SIGTERM; on Windows, Ctrl-Break, which a parent sends to stop a process group.
#[cfg(unix)]
fn terminate() -> std::io::Result<tokio::signal::unix::Signal> {
    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
}
#[cfg(windows)]
fn terminate() -> std::io::Result<tokio::signal::windows::CtrlBreak> {
    tokio::signal::windows::ctrl_break()
}

/// Runs until Ctrl-C or SIGTERM (Ctrl-Break on Windows). On a terminal, Enter prints a fresh launch link.
fn on_serve(interactive: bool) -> OnServe {
    Box::new(move |server: ServeHandle| {
        Box::pin(async move {
            let (enter, mut lines) = mpsc::unbounded_channel();
            if interactive {
                // A thread of its own: a blocked read of stdin must not hold the process open at exit.
                std::thread::spawn(move || {
                    for _ in std::io::stdin().lock().lines() {
                        if enter.send(()).is_err() {
                            break;
                        }
                    }
                });
            }
            let Ok(mut terminate) = terminate() else {
                return;
            };
            loop {
                tokio::select! {
                    Some(()) = lines.recv() => println!("Open your private dashboard: {}", server.launch_url()),
                    _ = tokio::signal::ctrl_c() => return,
                    _ = terminate.recv() => return,
                }
            }
        })
    })
}

fn main() -> ExitCode {
    let web = match web::WebRoot::open() {
        Ok(web) => web,
        Err(error) => {
            eprintln!("Tokentracky could not prepare its dashboard: {error}");
            return ExitCode::FAILURE;
        }
    };
    let secrets = match secret_store() {
        Ok(secrets) => secrets,
        Err(_) => {
            eprintln!("Tokentracky could not select its credential store.");
            return ExitCode::FAILURE;
        }
    };
    let interactive = std::io::stdin().is_terminal();
    // The local time zone can only be read while the process has one thread.
    let utc_offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
    let mut context = Context {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        env: Box::new(|name| std::env::var(name).ok()),
        home: None,
        stdout: Box::new(std::io::stdout()),
        stderr: Box::new(std::io::stderr()),
        secret_store: secrets,
        open_url: Arc::new(open_url),
        web_root: web.path().to_owned(),
        interactive,
        confirm: Box::new(confirm),
        poll_interval: Duration::from_secs(3),
        utc_offset,
        on_serve: Some(on_serve(interactive)),
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Tokentracky could not start: {error}");
            return ExitCode::FAILURE;
        }
    };
    let code = runtime.block_on(run(std::env::args_os().skip(1), &mut context));
    runtime.shutdown_background();
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
