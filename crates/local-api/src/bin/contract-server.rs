//! The Rust local server for `CONTRACT_SERVER_CMD` (`tests/contract/README.md`): `apps/server/src/main.ts` in local
//! mode, with the device credential kept in memory. Runs until SIGINT or SIGTERM, then closes gracefully.
use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;
use tokentracky_local_api::{MemorySecretStore, serve_from_env};
use tokio::signal::unix::{SignalKind, signal};

#[tokio::main]
async fn main() -> ExitCode {
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM can be handled");
    let server = match serve_from_env(Arc::new(MemorySecretStore::default())).await {
        Ok(server) => server,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let interactive = std::io::stdin().is_terminal();
    println!("Open your private workspace: {}", server.launch_url());
    let fresh = if interactive {
        " Press Enter for a fresh link."
    } else {
        ""
    };
    println!("This link works once and expires in five minutes.{fresh}");
    println!("CLI device credentials are kept only for this process. Desktop uses OS encryption.");
    if interactive {
        let session = server.session().clone();
        std::thread::spawn(move || {
            for _ in std::io::stdin().lines() {
                println!("Open your private workspace: {}", session.launch_url());
            }
        });
    }
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
    match server.close().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
