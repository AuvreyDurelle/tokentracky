//! The Tokentracky Mac app: a menu-bar-only Tauri app around the Rust collector and local API.
//! See `app.rs`. macOS only; elsewhere the crate builds portable modules and their tests.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(target_os = "macos")]
mod app;
mod backend;
mod menu;
#[cfg(target_os = "macos")]
mod native;
mod popover;
mod security;
mod shell;
mod updates;

#[cfg(target_os = "macos")]
fn main() {
    app::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The Tokentracky app runs on macOS only.");
    std::process::exit(1);
}
