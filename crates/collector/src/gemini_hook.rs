//! Gemini CLI's `SessionEnd` hook. When a Gemini CLI session ends, the hook touches [`REFRESH_REQUEST`] in the data
//! folder, and the running app or `tokentracky serve` reads Gemini CLI's logs within seconds instead of at its next
//! cycle. As in TokenTracker (MIT, `xiufengsun/TokenTracker@3f72861`, `src/lib/gemini-config.js`), it is installed
//! whenever Gemini CLI's folder exists, kept up to date at each launch, and removed by `tokentracky uninstall`; the
//! settings file is backed up before each change. Unlike TokenTracker, and following Gemini CLI itself
//! (`google-gemini/gemini-cli@eecccfc`, `hookPlanner.ts`, `settingsSchema.ts`):
//!
//! - The hook has no matcher: a lifecycle matcher is compared as a whole string, so `exit|clear|…` never matches.
//! - `tools.enableHooks` is not written (Gemini CLI no longer has it), and `hooksConfig` is left alone, so hooks a user
//!   turned off stay off.
//! - A settings file that is not plain JSON (Gemini CLI also accepts comments) or not in the usual shape is never
//!   rewritten.
use serde_json::{Map, Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use time::OffsetDateTime;

/// The file the hook touches, in the data folder.
pub const REFRESH_REQUEST: &str = "refresh-now";
/// The hook's name in Gemini CLI's settings, which identifies it.
const NAME: &str = "tokentracky";
const EVENT: &str = "SessionEnd";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Written now; `backup` holds the earlier settings, when there were any.
    Written { backup: Option<PathBuf> },
    /// Already as it should be.
    Unchanged,
    /// Gemini CLI's folder does not exist.
    NoGemini,
    /// The settings are not plain JSON in the usual shape, so they are left as they are.
    Unreadable,
}

/// `$GEMINI_CLI_HOME/.gemini/settings.json`, else `~/.gemini/settings.json`. An empty value counts as unset.
pub fn settings_path(env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    env("GEMINI_CLI_HOME")
        .filter(|home| !home.is_empty())
        .map_or_else(|| home.to_path_buf(), PathBuf::from)
        .join(".gemini")
        .join("settings.json")
}

/// The hook's command, which never prints and always succeeds: Gemini CLI runs it with `bash -c`, or PowerShell on
/// Windows.
pub fn command(data_dir: &Path, windows: bool) -> String {
    let file = data_dir.join(REFRESH_REQUEST).to_string_lossy().into_owned();
    if windows {
        format!(
            "New-Item -ItemType File -Force -Path '{}' -ErrorAction SilentlyContinue | Out-Null",
            file.replace('\'', "''")
        )
    } else {
        format!("touch '{}' 2>/dev/null || true", file.replace('\'', r"'\''"))
    }
}

/// Adds the hook to Gemini CLI's settings, or brings an earlier one (found by name) up to date.
pub fn install(settings: &Path, command: &str) -> io::Result<Outcome> {
    if !settings.parent().is_some_and(Path::is_dir) {
        return Ok(Outcome::NoGemini);
    }
    let Some(mut root) = read(settings)? else {
        return Ok(Outcome::Unreadable);
    };
    let Some(entries) = session_end(&mut root) else {
        return Ok(Outcome::Unreadable);
    };
    let ours = entries
        .iter_mut()
        .filter_map(|entry| entry.get_mut("hooks")?.as_array_mut())
        .flatten()
        .find(|hook| hook.get("name").and_then(Value::as_str) == Some(NAME));
    match ours {
        Some(hook) if hook["type"] == "command" && hook["command"] == command => return Ok(Outcome::Unchanged),
        Some(hook) => {
            hook["type"] = json!("command");
            hook["command"] = json!(command);
        }
        None => entries.push(json!({"hooks": [{"name": NAME, "type": "command", "command": command}]})),
    }
    write(settings, &root)
}

/// Removes the hook (by name) from Gemini CLI's settings, and the lists it leaves empty. `Unchanged` when it is not
/// there.
pub fn remove(settings: &Path) -> io::Result<Outcome> {
    if !settings.is_file() {
        return Ok(Outcome::NoGemini);
    }
    let Some(mut root) = read(settings)? else {
        return Ok(Outcome::Unreadable);
    };
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(Outcome::Unchanged);
    };
    let Some(entries) = hooks.get_mut(EVENT).and_then(Value::as_array_mut) else {
        return Ok(Outcome::Unchanged);
    };
    let mut found = false;
    entries.retain_mut(|entry| {
        let Some(list) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
            return true;
        };
        let count = list.len();
        list.retain(|hook| hook.get("name").and_then(Value::as_str) != Some(NAME));
        found |= list.len() < count;
        // Only a group this emptied goes.
        !list.is_empty() || list.len() == count
    });
    if !found {
        return Ok(Outcome::Unchanged);
    }
    if entries.is_empty() {
        hooks.remove(EVENT);
    }
    if hooks.is_empty() {
        root.as_object_mut().map(|root| root.remove("hooks"));
    }
    write(settings, &root)
}

/// The settings as a JSON object; an absent file is an empty one, and `None` is anything else.
fn read(settings: &Path) -> io::Result<Option<Value>> {
    match fs::read_to_string(settings) {
        Ok(text) => Ok(serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Some(Value::Object(Map::new()))),
        Err(error) => Err(error),
    }
}

/// `hooks.SessionEnd`, made when absent; `None` when either is not of its usual type.
fn session_end(root: &mut Value) -> Option<&mut Vec<Value>> {
    root.as_object_mut()?
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()?
        .entry(EVENT)
        .or_insert_with(|| json!([]))
        .as_array_mut()
}

/// Backs up the current file, then replaces the file it is (a linked one's target, so the link stays) in one rename
/// of a complete copy with the same permissions.
fn write(settings: &Path, root: &Value) -> io::Result<Outcome> {
    let target = fs::canonicalize(settings).unwrap_or_else(|_| settings.to_path_buf());
    let backup = if target.exists() {
        let stamp = tokentracky_core::iso_timestamp(OffsetDateTime::now_utc()).replace([':', '.'], "-");
        let backup = with_suffix(settings, &format!(".bak.{stamp}"));
        fs::copy(&target, &backup)?;
        Some(backup)
    } else {
        None
    };
    let temporary = with_suffix(&target, ".tokentracky");
    fs::write(&temporary, format!("{}\n", serde_json::to_string_pretty(root)?))?;
    if let Ok(current) = fs::metadata(&target) {
        fs::set_permissions(&temporary, current.permissions())?;
    }
    fs::rename(&temporary, &target)?;
    Ok(Outcome::Written { backup })
}
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut path = path.as_os_str().to_owned();
    path.push(suffix);
    path.into()
}
