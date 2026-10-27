//! Check the actual build script against partial/missing bundles without needing Node in Rust-only CI.
use std::fs;
use std::process::Command;

#[test]
fn embedding_fails_closed_for_missing_incomplete_or_symlinked_web_builds() {
    let fixture = tempfile::tempdir().unwrap();
    let manifest = fixture.path().join("crates/cli");
    let dist = fixture.path().join("apps/web/dist");
    let output = fixture.path().join("output");
    fs::create_dir_all(&manifest).unwrap();
    fs::create_dir(&output).unwrap();
    let build = fixture.path().join("build-web");
    let compiled = Command::new("rustc")
        .args(["--edition=2024", concat!(env!("CARGO_MANIFEST_DIR"), "/build.rs"), "-o"])
        .arg(&build)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let run = |embed: bool| {
        let mut command = Command::new(&build);
        command.env("CARGO_MANIFEST_DIR", &manifest).env("OUT_DIR", &output);
        if embed {
            command.env("CARGO_FEATURE_EMBED_WEB", "1");
        } else {
            command.env_remove("CARGO_FEATURE_EMBED_WEB");
        }
        command.output().unwrap()
    };
    assert!(
        run(false).status.success(),
        "default debug builds must not require web assets"
    );
    assert!(!run(true).status.success(), "missing bundle must fail");
    fs::create_dir_all(dist.join("assets")).unwrap();
    let index = "<html><script src=\"/assets/app.js\"></script><link href=\"/assets/app.css\"></html>";
    fs::write(dist.join("index.html"), index).unwrap();
    fs::write(dist.join("assets/app.js"), "console.log('dashboard');").unwrap();
    fs::write(dist.join("assets/app.css"), "body { color: red; }").unwrap();
    assert!(run(true).status.success());
    assert!(
        fs::read_to_string(output.join("web_bundle.rs"))
            .unwrap()
            .contains("include_bytes!")
    );
    fs::remove_file(dist.join("assets/app.js")).unwrap();
    assert!(!run(true).status.success(), "missing referenced JS must fail");
    fs::write(dist.join("assets/app.js"), "console.log('dashboard');").unwrap();
    fs::write(dist.join("assets/app.css"), "").unwrap();
    assert!(!run(true).status.success(), "empty referenced CSS must fail");
    fs::write(dist.join("assets/app.css"), "body { color: red; }").unwrap();
    fs::remove_file(dist.join("index.html")).unwrap();
    assert!(!run(true).status.success(), "missing HTML must fail");
    fs::write(dist.join("index.html"), "<html></html>").unwrap();
    assert!(
        !run(true).status.success(),
        "HTML without the built entry points must fail"
    );
    fs::write(dist.join("index.html"), index).unwrap();
    std::os::unix::fs::symlink(dist.join("assets/app.js"), dist.join("assets/symlink.js")).unwrap();
    assert!(!run(true).status.success(), "symlinks must not enter a release bundle");
}

#[test]
fn release_cli_cannot_compile_without_embedding() {
    let fixture = tempfile::tempdir().unwrap();
    let result = Command::new("rustc")
        .args([
            "--edition=2024",
            "--crate-type=lib",
            "-C",
            "debug-assertions=no",
            concat!(env!("CARGO_MANIFEST_DIR"), "/src/web.rs"),
            "-o",
        ])
        .arg(fixture.path().join("web.rlib"))
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("release CLI requires --features embed-web"));
}
