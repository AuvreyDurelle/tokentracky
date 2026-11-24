//! The Tokentracky desktop app: a tray-only Tauri app around the Rust collector and local API, on macOS, Windows and
//! Linux. See `app.rs`.
// Windows: a release build opens no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod backend;
mod menu;
#[cfg(target_os = "macos")]
mod native;
/// `native.rs`'s functions off macOS.
#[cfg(not(target_os = "macos"))]
#[path = "native_other.rs"]
mod native;
mod popover;
mod security;
mod shell;
mod updates;

fn main() {
    app::run();
}
