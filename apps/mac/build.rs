fn main() {
    // The Tauri build step exists only where the app does (see Cargo.toml).
    #[cfg(target_os = "macos")]
    tauri_build::build();

    // An updater is only linked into a release candidate that was built through the release
    // preparation script.  In particular, `cargo build` and unsigned developer bundles must
    // not offer a check button backed by an empty or invented update configuration.
    println!("cargo:rustc-check-cfg=cfg(tokentracky_release_updater)");
    println!("cargo:rerun-if-env-changed=TOKENTRACKY_RELEASE_UPDATER");
    if std::env::var("TOKENTRACKY_RELEASE_UPDATER").as_deref() == Ok("1") {
        println!("cargo:rustc-cfg=tokentracky_release_updater");
    }
}
