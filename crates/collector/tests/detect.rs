//! The default source folders of each tool, and which of them exist.
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tokentracky_collector::detect::{DetectedTool, default_source_paths, detect_tools};
use tokentracky_core::ToolId;

const EDITORS: [&str; 5] = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
/// Where the editors keep their settings below the home, with no `XDG_CONFIG_HOME` or `APPDATA` set.
const EDITOR_SETTINGS: &str = if cfg!(target_os = "macos") {
    "Library/Application Support"
} else if cfg!(windows) {
    "AppData/Roaming"
} else {
    ".config"
};

/// An environment holding only `vars`.
fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    move |key| vars.get(key).cloned()
}
/// The home [`defaults`] lists below; Windows needs a drive for it to be absolute.
const HOME: &str = if cfg!(windows) { "C:/Users/ada" } else { "/Users/ada" };
fn defaults(vars: &[(&str, &str)], tool: ToolId) -> Vec<String> {
    let all = default_source_paths(env(vars), Path::new(HOME));
    let paths = all.into_iter().find(|(id, _)| *id == tool).unwrap().1;
    paths.into_iter().map(unix).collect()
}
/// `path` as Unix writes it, so that one expectation holds everywhere: on Windows, `/` for `\` and no drive.
fn unix(path: String) -> String {
    if !cfg!(windows) {
        return path;
    }
    let path = path.replace('\\', "/");
    match path.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => path[2..].to_owned(),
        _ => path,
    }
}
fn editor_tasks(extension: &str) -> Vec<String> {
    EDITORS
        .map(|editor| format!("/Users/ada/{EDITOR_SETTINGS}/{editor}/User/globalStorage/{extension}/tasks"))
        .to_vec()
}
fn home() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("tokentracky-home-").tempdir().unwrap()
}
/// `path` with the system's separators: `join("a/b")` keeps the `/`.
fn text(path: &Path) -> String {
    path.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR)
}

#[test]
fn finds_existing_default_folders_without_reading_them_honouring_tool_home_overrides() {
    let home = home();
    let home = home.path();
    assert_eq!(detect_tools(env(&[]), home), []);
    fs::create_dir_all(home.join(".claude/projects")).unwrap();
    fs::create_dir_all(home.join("custom-codex")).unwrap();
    fs::write(home.join("custom-codex/sessions"), "a file, not a folder").unwrap();
    let codex = text(&home.join("custom-codex"));
    assert_eq!(
        detect_tools(env(&[("CODEX_HOME", &codex)]), home),
        [DetectedTool {
            id: ToolId::Claude,
            name: "Claude Code".into(),
            paths: vec![text(&home.join(".claude/projects"))],
        }]
    );
    fs::remove_file(home.join("custom-codex/sessions")).unwrap();
    fs::create_dir(home.join("custom-codex/sessions")).unwrap();
    let ids: Vec<ToolId> = detect_tools(env(&[("CODEX_HOME", &codex)]), home)
        .into_iter()
        .map(|tool| tool.id)
        .collect();
    assert_eq!(ids, [ToolId::Claude, ToolId::Codex]);
}

#[test]
fn finds_t3_code_profiles_without_their_home_variables() {
    let home = home();
    let home = home.path();
    let profiles = home.join("t3-routing/.runtime/profiles");
    for folder in ["claude/projects", "codex/sessions"] {
        fs::create_dir_all(profiles.join(folder)).unwrap();
    }
    let paths: Vec<(ToolId, Vec<String>)> = detect_tools(env(&[]), home)
        .into_iter()
        .map(|tool| (tool.id, tool.paths))
        .collect();
    assert_eq!(
        paths,
        [
            (ToolId::Claude, vec![text(&profiles.join("claude/projects"))]),
            (ToolId::Codex, vec![text(&profiles.join("codex/sessions"))])
        ]
    );
}

#[test]
fn lists_the_default_and_alternate_claude_code_locations() {
    assert_eq!(
        defaults(&[], ToolId::Claude),
        [
            "/Users/ada/.claude/projects",
            "/Users/ada/.config/claude/projects",
            "/Users/ada/t3-routing/.runtime/profiles/claude/projects"
        ]
    );
    assert_eq!(
        defaults(&[], ToolId::Codex),
        [
            "/Users/ada/.codex/sessions",
            "/Users/ada/.codex/archived_sessions",
            "/Users/ada/t3-routing/.runtime/profiles/codex/sessions",
            "/Users/ada/t3-routing/.runtime/profiles/codex/archived_sessions"
        ]
    );
    assert_eq!(
        defaults(&[("CLAUDE_CONFIG_DIR", "/cfg")], ToolId::Claude)[0],
        "/cfg/projects"
    );
}

#[test]
fn keeps_the_usual_claude_code_and_codex_folders_beside_their_home_overrides() {
    assert_eq!(
        defaults(&[("CLAUDE_CONFIG_DIR", "/cfg")], ToolId::Claude),
        [
            "/cfg/projects",
            "/Users/ada/.claude/projects",
            "/Users/ada/.config/claude/projects",
            "/Users/ada/t3-routing/.runtime/profiles/claude/projects"
        ]
    );
    assert_eq!(
        defaults(&[("CODEX_HOME", "/cdx")], ToolId::Codex),
        [
            "/cdx/sessions",
            "/cdx/archived_sessions",
            "/Users/ada/.codex/sessions",
            "/Users/ada/.codex/archived_sessions",
            "/Users/ada/t3-routing/.runtime/profiles/codex/sessions",
            "/Users/ada/t3-routing/.runtime/profiles/codex/archived_sessions"
        ]
    );
    assert_eq!(
        defaults(
            &[("CLAUDE_CONFIG_DIR", &format!("{HOME}/.config/claude"))],
            ToolId::Claude
        ),
        [
            "/Users/ada/.config/claude/projects",
            "/Users/ada/.claude/projects",
            "/Users/ada/t3-routing/.runtime/profiles/claude/projects"
        ]
    );
    let home = home();
    let home = home.path();
    for folder in [
        ".claude/projects",
        "profile/claude/projects",
        ".codex/sessions",
        "profile/codex/sessions",
        "profile/codex/archived_sessions",
    ] {
        fs::create_dir_all(home.join(folder)).unwrap();
    }
    let (claude, codex) = (text(&home.join("profile/claude")), text(&home.join("profile/codex")));
    let paths: Vec<Vec<String>> = detect_tools(env(&[("CLAUDE_CONFIG_DIR", &claude), ("CODEX_HOME", &codex)]), home)
        .into_iter()
        .map(|tool| tool.paths)
        .collect();
    assert_eq!(
        paths,
        [
            vec![
                text(&home.join("profile/claude/projects")),
                text(&home.join(".claude/projects"))
            ],
            vec![
                text(&home.join("profile/codex/sessions")),
                text(&home.join("profile/codex/archived_sessions")),
                text(&home.join(".codex/sessions"))
            ],
        ]
    );
}

#[test]
fn lists_gemini_cli_project_folders_honouring_gemini_cli_home() {
    assert_eq!(defaults(&[], ToolId::Gemini), ["/Users/ada/.gemini/tmp"]);
    assert_eq!(
        defaults(&[("GEMINI_CLI_HOME", "/alt")], ToolId::Gemini),
        ["/alt/.gemini/tmp"]
    );
}

#[test]
fn lists_cline_sdk_sessions_honouring_cline_dir_and_cline_data_dir_and_classic_tasks_in_each_editor() {
    let cline = defaults(&[], ToolId::Cline);
    assert_eq!(cline[0], "/Users/ada/.cline/data/sessions");
    assert_eq!(cline[1..], editor_tasks("saoudrizwan.claude-dev"));
    assert_eq!(defaults(&[("CLINE_DIR", "/c")], ToolId::Cline)[0], "/c/data/sessions");
    assert_eq!(
        defaults(&[("CLINE_DIR", "/c"), ("CLINE_DATA_DIR", "/d")], ToolId::Cline)[0],
        "/d/sessions"
    );
}

#[test]
fn lists_roo_code_tasks_in_each_editor() {
    assert_eq!(defaults(&[], ToolId::Roo), editor_tasks("rooveterinaryinc.roo-cline"));
}

#[test]
fn lists_the_opencode_database_and_message_files_honouring_xdg_data_home_and_opencode_db() {
    assert_eq!(
        defaults(&[], ToolId::OpenCode),
        [
            "/Users/ada/.local/share/opencode/opencode.db",
            "/Users/ada/.local/share/opencode/storage/message"
        ]
    );
    assert_eq!(
        defaults(
            &[("XDG_DATA_HOME", "/xdg"), ("OPENCODE_DB", "opencode-next.db")],
            ToolId::OpenCode
        ),
        ["/xdg/opencode/opencode-next.db", "/xdg/opencode/storage/message"]
    );
    assert_eq!(
        defaults(&[("OPENCODE_DB", "/elsewhere/custom.db")], ToolId::OpenCode)[0],
        "/elsewhere/custom.db"
    );
}

#[test]
fn lists_the_kilo_code_database_honouring_xdg_data_home_and_kilo_db_and_version_5_tasks_in_each_editor() {
    let kilo = defaults(&[], ToolId::Kilo);
    assert_eq!(kilo[0], "/Users/ada/.local/share/kilo/kilo.db");
    assert_eq!(kilo[1..], editor_tasks("kilocode.kilo-code"));
    assert_eq!(
        defaults(&[("XDG_DATA_HOME", "/xdg")], ToolId::Kilo)[0],
        "/xdg/kilo/kilo.db"
    );
    assert_eq!(
        defaults(&[("KILO_DB", "/elsewhere/kilo-dev.db")], ToolId::Kilo)[0],
        "/elsewhere/kilo-dev.db"
    );
}

#[test]
fn detects_a_database_only_when_it_is_a_file_by_stat_alone() {
    let home = home();
    let home = home.path();
    let database = home.join(".local/share/opencode/opencode.db");
    fs::create_dir_all(&database).unwrap();
    assert_eq!(detect_tools(env(&[]), home), []);
    fs::remove_dir(&database).unwrap();
    fs::write(&database, "not opened by detection").unwrap();
    assert_eq!(
        detect_tools(env(&[]), home),
        [DetectedTool {
            id: ToolId::OpenCode,
            name: "OpenCode".into(),
            paths: vec![text(&database)],
        }]
    );
}

#[test]
fn detects_only_the_editor_task_folders_that_exist() {
    let home = home();
    let home = home.path();
    let tasks = home
        .join(EDITOR_SETTINGS)
        .join("VSCodium/User/globalStorage/saoudrizwan.claude-dev/tasks");
    fs::create_dir_all(&tasks).unwrap();
    assert_eq!(
        detect_tools(env(&[]), home),
        [DetectedTool {
            id: ToolId::Cline,
            name: "Cline".into(),
            paths: vec![text(&tasks)],
        }]
    );
}

// Rust only: the TypeScript collector does not read these tools.
#[test]
fn lists_the_phase_6_tools_honouring_their_own_home_overrides() {
    let one = |vars: &[(&str, &str)], tool| defaults(vars, tool);
    assert_eq!(one(&[], ToolId::Mimo), ["/Users/ada/.local/share/mimocode"]);
    assert_eq!(one(&[("MIMOCODE_HOME", "/m")], ToolId::Mimo), ["/m/data"]);
    assert_eq!(
        one(&[("PI_CODING_AGENT_DIR", "/p")], ToolId::Pi),
        ["/p/sessions", "/Users/ada/.multica/pi-sessions"]
    );
    assert_eq!(one(&[], ToolId::PrimeAgent), ["/Users/ada/.prime/agent/sessions"]);
    assert_eq!(
        one(&[("PRIME_AGENT_CODING_AGENT_DIR", "/a")], ToolId::PrimeAgent),
        ["/a/sessions"]
    );
    assert_eq!(
        one(
            &[
                ("PRIME_AGENT_CODING_AGENT_DIR", "/a"),
                ("PRIME_AGENT_SESSION_DIR", "/s")
            ],
            ToolId::PrimeAgent
        ),
        ["/s"]
    );
    assert_eq!(
        one(&[("CODEBUDDY_CONFIG_DIR", "/c")], ToolId::CodeBuddy),
        ["/c/projects"]
    );
    assert_eq!(
        one(&[("KIMI_SHARE_DIR", "/k")], ToolId::Kimi),
        ["/k/sessions", "/Users/ada/.kimi-code/sessions"]
    );
    assert_eq!(
        one(&[], ToolId::Copilot),
        [
            "/Users/ada/.copilot/session-store.db",
            "/Users/ada/.copilot/otel",
            "/Users/ada/.copilot-otel"
        ]
    );
    assert_eq!(one(&[], ToolId::Unsloth), ["/Users/ada/.unsloth/studio"]);
    assert_eq!(one(&[("UNSLOTH_HOME", "/u")], ToolId::Unsloth), ["/u/studio"]);
    assert_eq!(
        one(&[("STUDIO_HOME", "/s"), ("UNSLOTH_HOME", "/u")], ToolId::Unsloth),
        ["/s"]
    );
    assert_eq!(
        one(&[("UNSLOTH_STUDIO_HOME", "/x"), ("STUDIO_HOME", "/s")], ToolId::Unsloth),
        ["/x"]
    );
    assert_eq!(one(&[("HERMES_HOME", "/h")], ToolId::Hermes), ["/h"]);
    assert_eq!(one(&[], ToolId::Goose), ["/Users/ada/.local/share/goose/sessions"]);
    assert_eq!(one(&[("XDG_DATA_HOME", "/d")], ToolId::Goose), ["/d/goose/sessions"]);
    assert_eq!(one(&[("GOOSE_PATH_ROOT", "/g")], ToolId::Goose), ["/g/data/sessions"]);
}
