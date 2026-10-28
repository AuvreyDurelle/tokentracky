//! Where each supported tool keeps its logs by default.
use crate::{normalize, resolve};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tokentracky_core::ToolId;

/// VS Code-family editors whose extension storage holds Cline, Roo Code and Kilo Code tasks.
const EDITORS: [&str; 5] = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

/// `path.join`.
fn join(base: impl AsRef<Path>, parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .fold(base.as_ref().to_path_buf(), |path, part| path.join(part));
    normalize(&joined).to_string_lossy().into_owned()
}
/// Where the editors keep their settings and extension storage on `os` (`std::env::consts::OS`): Application Support
/// on macOS, `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` (else `~/.config`) on Linux and the other Unix systems.
fn editor_settings(os: &str, var: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    match os {
        "macos" => home.join("Library/Application Support"),
        "windows" => var("APPDATA").map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from),
        _ => var("XDG_CONFIG_HOME").map_or_else(|| home.join(".config"), PathBuf::from),
    }
}
fn editor_tasks(settings: &Path, extension: &str) -> Vec<String> {
    let storage = ["User", "globalStorage", extension, "tasks"];
    EDITORS
        .iter()
        .map(|editor| join(settings.join(editor), &storage))
        .collect()
}

/// The paths in order, each once.
fn unique(paths: Vec<String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for path in paths {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique
}

/// Where each supported tool keeps its logs by default, honouring the tools' own home-directory overrides. Claude
/// Code's and Codex's overrides add a folder before the usual ones rather than replacing them, as one computer can run
/// a tool both with and without one. `env` reads an environment variable; an empty value counts as unset.
pub fn default_source_paths(env: impl Fn(&str) -> Option<String>, home: &Path) -> Vec<(ToolId, Vec<String>)> {
    let var = |key: &str| env(key).filter(|value| !value.is_empty());
    let or = |key: &str, default: String| var(key).unwrap_or(default);
    let data = or("XDG_DATA_HOME", join(home, &[".local", "share"]));
    let editors = editor_settings(std::env::consts::OS, var, home);
    // T3 Code's routed profiles: it launches Claude Code and Codex with their homes here, which this app's own
    // environment never shows.
    let t3 = join(home, &["t3-routing", ".runtime", "profiles"]);
    let claude = unique(vec![
        join(or("CLAUDE_CONFIG_DIR", join(home, &[".claude"])), &["projects"]),
        join(home, &[".claude", "projects"]),
        join(home, &[".config", "claude", "projects"]),
        join(&t3, &["claude", "projects"]),
    ]);
    // Codex moves some older rollouts out of `sessions` into `archived_sessions`.
    let codex_home = or("CODEX_HOME", join(home, &[".codex"]));
    let codex = unique(vec![
        join(&codex_home, &["sessions"]),
        join(&codex_home, &["archived_sessions"]),
        join(home, &[".codex", "sessions"]),
        join(home, &[".codex", "archived_sessions"]),
        join(&t3, &["codex", "sessions"]),
        join(&t3, &["codex", "archived_sessions"]),
    ]);
    let cline = or(
        "CLINE_DATA_DIR",
        join(or("CLINE_DIR", join(home, &[".cline"])), &["data"]),
    );
    // `path.resolve`, so an absolute `OPENCODE_DB` or `KILO_DB` stands on its own.
    let database = |tool: &str, key: &str, default: &str| {
        let file = var(key).unwrap_or_else(|| default.to_owned());
        resolve(&Path::new(&data).join(tool).join(file))
            .to_string_lossy()
            .into_owned()
    };
    vec![
        (ToolId::Claude, claude),
        (ToolId::Codex, codex),
        (
            ToolId::Gemini,
            vec![join(or("GEMINI_CLI_HOME", join(home, &[])), &[".gemini", "tmp"])],
        ),
        (
            ToolId::Cline,
            [
                vec![join(cline, &["sessions"])],
                editor_tasks(&editors, "saoudrizwan.claude-dev"),
            ]
            .concat(),
        ),
        (ToolId::Roo, editor_tasks(&editors, "rooveterinaryinc.roo-cline")),
        // The database file (`OPENCODE_DB`, absolute or relative to the data folder) and pre-1.2 message files.
        (
            ToolId::OpenCode,
            vec![
                database("opencode", "OPENCODE_DB", "opencode.db"),
                join(&data, &["opencode", "storage", "message"]),
            ],
        ),
        // Kilo Code 7 (`KILO_DB` likewise) and version 5 tasks in each editor.
        (
            ToolId::Kilo,
            [
                vec![database("kilo", "KILO_DB", "kilo.db")],
                editor_tasks(&editors, "kilocode.kilo-code"),
            ]
            .concat(),
        ),
        (
            ToolId::EveryCode,
            vec![join(or("CODE_HOME", join(home, &[".code"])), &["sessions"])],
        ),
        (
            ToolId::Mimo,
            vec![var("MIMOCODE_HOME").map_or_else(|| join(&data, &["mimocode"]), |mimo| join(mimo, &["data"]))],
        ),
        // DuMate keeps its database under Windows' application data; on macOS it is chosen by hand.
        (ToolId::DuMate, Vec::new()),
        (
            ToolId::Pi,
            vec![
                join(or("PI_CODING_AGENT_DIR", join(home, &[".pi", "agent"])), &["sessions"]),
                join(home, &[".multica", "pi-sessions"]),
            ],
        ),
        (ToolId::Omp, vec![join(home, &[".omp", "agent", "sessions"])]),
        (
            ToolId::Omo,
            vec![join(or("OMO_HOME", join(home, &[".omo"])), &["agent", "sessions"])],
        ),
        (
            ToolId::PrimeAgent,
            vec![join(
                var("PRIME_AGENT_SESSION_DIR").unwrap_or_else(|| {
                    join(
                        or("PRIME_AGENT_CODING_AGENT_DIR", join(home, &[".prime", "agent"])),
                        &["sessions"],
                    )
                }),
                &[],
            )],
        ),
        (ToolId::MiniMax, vec![join(home, &[".minimax", "v2", "sessions"])]),
        (
            ToolId::CodeBuddy,
            vec![join(
                or("CODEBUDDY_CONFIG_DIR", join(home, &[".codebuddy"])),
                &["projects"],
            )],
        ),
        (
            ToolId::Kimi,
            vec![
                join(or("KIMI_SHARE_DIR", join(home, &[".kimi"])), &["sessions"]),
                join(or("KIMI_CODE_HOME", join(home, &[".kimi-code"])), &["sessions"]),
            ],
        ),
        (ToolId::CommandCode, vec![join(home, &[".commandcode", "projects"])]),
        (
            ToolId::DeepSeek,
            vec![join(or("DSH_HOME", join(home, &[".dsh"])), &["sessions"])],
        ),
        (ToolId::LmStudio, vec![join(home, &[".lmstudio", "server-logs"])]),
        // The usage store and the OpenTelemetry exports, not the rest of Copilot's folder.
        (ToolId::Copilot, {
            let copilot = or("COPILOT_HOME", join(home, &[".copilot"]));
            vec![
                join(&copilot, &["session-store.db"]),
                join(&copilot, &["otel"]),
                join(home, &[".copilot-otel"]),
            ]
        }),
        (
            ToolId::Unsloth,
            vec![join(
                var("UNSLOTH_STUDIO_HOME")
                    .or_else(|| var("STUDIO_HOME"))
                    .unwrap_or_else(|| join(or("UNSLOTH_HOME", join(home, &[".unsloth"])), &["studio"])),
                &[],
            )],
        ),
        (ToolId::ZCode, vec![join(home, &[".zcode", "cli", "db"])]),
        (
            ToolId::Zed,
            vec![join(home, &["Library", "Application Support", "Zed", "threads"])],
        ),
        (
            ToolId::OpenClaw,
            vec![join(or("OPENCLAW_STATE_DIR", join(home, &[".openclaw"])), &["agents"])],
        ),
        (ToolId::Reasonix, vec![join(home, &[".reasonix"])]),
        (
            ToolId::Hermes,
            vec![join(or("HERMES_HOME", join(home, &[".hermes"])), &[])],
        ),
        // Goose keeps XDG folders on macOS too.
        (
            ToolId::Goose,
            vec![var("GOOSE_PATH_ROOT").map_or_else(
                || join(&data, &["goose", "sessions"]),
                |root| join(root, &["data", "sessions"]),
            )],
        ),
        (ToolId::Grok, vec![join(home, &[".grok", "sessions"])]),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DetectedTool {
    pub id: ToolId,
    pub name: String,
    pub paths: Vec<String>,
}

/// Stats default locations only; never lists or reads them. Returns the tools with at least one existing folder or
/// database file.
pub fn detect_tools(env: impl Fn(&str) -> Option<String>, home: &Path) -> Vec<DetectedTool> {
    default_source_paths(env, home)
        .into_iter()
        // A tool is offered once the collector reads it.
        .filter(|(id, _)| crate::readers::is_supported(*id))
        .filter_map(|(id, paths)| {
            let existing: Vec<String> = paths
                .into_iter()
                .filter(|path| {
                    fs::metadata(path).is_ok_and(|entry| {
                        if path.ends_with(".db") {
                            entry.is_file()
                        } else {
                            entry.is_dir()
                        }
                    })
                })
                .collect();
            (!existing.is_empty()).then(|| DetectedTool {
                id,
                name: id.name().to_owned(),
                paths: existing,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::editor_settings;
    use std::path::Path;

    #[test]
    fn editors_keep_their_storage_where_each_system_keeps_settings() {
        let home = Path::new("/home/ada");
        let unset = |_: &str| None;
        let only = |key: &'static str, value: &'static str| move |name: &str| (name == key).then(|| value.to_owned());
        assert_eq!(
            editor_settings("macos", unset, home),
            home.join("Library/Application Support")
        );
        assert_eq!(editor_settings("linux", unset, home), home.join(".config"));
        assert_eq!(
            editor_settings("linux", only("XDG_CONFIG_HOME", "/xdg"), home),
            Path::new("/xdg")
        );
        assert_eq!(
            editor_settings("freebsd", only("XDG_CONFIG_HOME", "/xdg"), home),
            Path::new("/xdg")
        );
        assert_eq!(
            editor_settings("windows", unset, home),
            home.join("AppData").join("Roaming")
        );
        assert_eq!(
            editor_settings("windows", only("APPDATA", "D:/Roaming"), home),
            Path::new("D:/Roaming")
        );
    }
}
