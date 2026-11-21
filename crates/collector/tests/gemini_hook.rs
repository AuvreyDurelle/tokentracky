//! Gemini CLI's `SessionEnd` hook in its settings file.
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use tokentracky_collector::gemini_hook::{Outcome, command, install, remove, settings_path};

const COMMAND: &str = "touch '/Users/ada/.tokentracky/refresh-now' 2>/dev/null || true";

fn gemini() -> (tempfile::TempDir, PathBuf) {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join(".gemini")).unwrap();
    let settings = home.path().join(".gemini/settings.json");
    (home, settings)
}
fn json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}
fn ours(command: &str) -> Value {
    json!({"name": "tokentracky", "type": "command", "command": command})
}

#[test]
fn finds_the_settings_in_gemini_cli_home_or_the_home_folder() {
    let home = Path::new("/Users/ada");
    assert_eq!(settings_path(|_| None, home), home.join(".gemini/settings.json"));
    let custom = |key: &str| (key == "GEMINI_CLI_HOME").then(|| "/g".to_owned());
    assert_eq!(settings_path(custom, home), Path::new("/g/.gemini/settings.json"));
    let empty = |key: &str| (key == "GEMINI_CLI_HOME").then(String::new);
    assert_eq!(settings_path(empty, home), home.join(".gemini/settings.json"));
}

#[test]
fn touches_the_refresh_request_quietly_in_each_shell() {
    assert_eq!(command(Path::new("/Users/ada/.tokentracky"), false), COMMAND);
    assert_eq!(
        command(Path::new("/Users/o'neil/.tokentracky"), false),
        r"touch '/Users/o'\''neil/.tokentracky/refresh-now' 2>/dev/null || true"
    );
    let windows = command(Path::new(r"C:\Users\o'neil\.tokentracky"), true);
    assert!(windows.starts_with("New-Item -ItemType File -Force -Path 'C:\\Users\\o''neil\\.tokentracky"));
    assert!(windows.ends_with("refresh-now' -ErrorAction SilentlyContinue | Out-Null"));
}

#[test]
fn installs_a_hook_without_a_matcher_and_only_when_gemini_cli_is_there() {
    let empty = tempfile::tempdir().unwrap();
    let nowhere = empty.path().join(".gemini/settings.json");
    assert_eq!(install(&nowhere, COMMAND).unwrap(), Outcome::NoGemini);
    assert!(!empty.path().join(".gemini").exists());

    let (_home, settings) = gemini();
    assert_eq!(install(&settings, COMMAND).unwrap(), Outcome::Written { backup: None });
    assert_eq!(
        json(&settings),
        json!({"hooks": {"SessionEnd": [{"hooks": [ours(COMMAND)]}]}})
    );
    assert_eq!(install(&settings, COMMAND).unwrap(), Outcome::Unchanged);
}

#[test]
fn keeps_everything_else_backs_up_and_updates_an_earlier_hook_in_place() {
    let (_home, settings) = gemini();
    let theirs = json!({"name": "notify", "type": "command", "command": "say done"});
    let original = json!({
        "theme": "dark",
        "hooksConfig": {"enabled": false},
        "hooks": {
            "BeforeTool": [{"matcher": "write_file", "hooks": [theirs]}],
            "SessionEnd": [{"matcher": "exit", "hooks": [theirs, ours("old command")]}],
        },
    });
    fs::write(&settings, original.to_string()).unwrap();
    let Outcome::Written { backup: Some(backup) } = install(&settings, COMMAND).unwrap() else {
        panic!("expected a backup");
    };
    assert_eq!(json(&backup), original);
    let mut expected = original.clone();
    expected["hooks"]["SessionEnd"][0]["hooks"][1] = ours(COMMAND);
    // `hooksConfig` is left as the user set it, and no `tools.enableHooks` is added.
    assert_eq!(json(&settings), expected);
}

#[test]
fn never_rewrites_settings_it_cannot_read_as_plain_json() {
    let (_home, settings) = gemini();
    for text in [
        "{\n  // Gemini CLI accepts comments\n  \"theme\": \"dark\"\n}",
        "[]",
        r#"{"hooks": []}"#,
        r#"{"hooks": {"SessionEnd": {}}}"#,
    ] {
        fs::write(&settings, text).unwrap();
        assert_eq!(install(&settings, COMMAND).unwrap(), Outcome::Unreadable, "{text}");
        assert_eq!(fs::read_to_string(&settings).unwrap(), text);
    }
}

#[test]
fn removes_only_its_own_hook_and_the_lists_it_leaves_empty() {
    let (_home, settings) = gemini();
    assert_eq!(remove(&settings).unwrap(), Outcome::NoGemini);
    fs::write(&settings, json!({"theme": "dark"}).to_string()).unwrap();
    assert!(matches!(
        install(&settings, COMMAND).unwrap(),
        Outcome::Written { backup: Some(_) }
    ));
    assert!(matches!(
        remove(&settings).unwrap(),
        Outcome::Written { backup: Some(_) }
    ));
    assert_eq!(json(&settings), json!({"theme": "dark"}));
    assert_eq!(remove(&settings).unwrap(), Outcome::Unchanged);

    let theirs = json!({"name": "notify", "type": "command", "command": "say done"});
    let shared = json!({"hooks": {"SessionEnd": [{"hooks": [theirs, ours(COMMAND)]}, {"hooks": [ours(COMMAND)]}]}});
    fs::write(&settings, shared.to_string()).unwrap();
    assert!(matches!(remove(&settings).unwrap(), Outcome::Written { .. }));
    assert_eq!(json(&settings), json!({"hooks": {"SessionEnd": [{"hooks": [theirs]}]}}));
}
