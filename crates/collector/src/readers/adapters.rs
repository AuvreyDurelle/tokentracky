//! Which files each tool's reader opens and how it reads them.
use super::parser::{Counted, PENDING, ParserState, file_name, only, parent_name, parse_gemini_session, parse_json};
use super::{
    cline, codebuddy, commandcode, copilot, deepseek, dumate, everycode, goose, grok, hermes, kimi, lmstudio, mimo,
    openclaw, opencode, pi, reasonix, roo, unsloth, zcode, zed,
};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tokentracky_core::{ParseResult, SourceCapabilities, ToolId, UsageEvent};

/// How a file found under an authorized path is read: appended lines, a whole JSON document, a SQLite database or a
/// zstd-compressed line log written once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Jsonl,
    Json,
    Sqlite,
    CompressedJsonl,
}
/// Sibling files read with a document, by role: their content, `None` (or no entry) when absent.
pub type Sidecars = BTreeMap<&'static str, Option<String>>;
/// Paths of the sibling files a document is read with, by role.
pub type SidecarPaths = Vec<(&'static str, PathBuf)>;
/// Reads a database, given the events already counted from it.
pub type DatabaseReader = fn(&Path, &[UsageEvent]) -> rusqlite::Result<ParseResult>;
/// Reads one appended JSON record of a line log with the file's state: the event it records, if any. An `Err` is
/// `invalid_counters`; diagnostics are fixed codes.
pub(crate) type LineReader =
    fn(&Map<String, Value>, &Path, &mut ParserState, &mut Vec<String>) -> Counted<Option<UsageEvent>>;
/// Reads a whole text file (at most `MAX_DOCUMENT_BYTES`), such as a server log, with its sidecars.
pub type TextReader = fn(&Path, &str, &Sidecars) -> ParseResult;
/// Reads a database from a watermark (a rowid or update time the reader chose), given the events already counted from
/// it; returns the usage it found and the next watermark. Rows a tool finishes in place are re-read by the reader
/// from a short tail below the watermark. A watermark of 0 reads everything.
pub type IncrementalReader = fn(&Path, &[UsageEvent], u64) -> rusqlite::Result<(ParseResult, u64)>;
pub(crate) fn sidecar<'a>(sidecars: &'a Sidecars, role: &str) -> Option<&'a str> {
    sidecars.get(role)?.as_deref()
}

pub struct Adapter {
    /// Published per tool in the README's table of supported tools.
    pub capabilities: SourceCapabilities,
    /// Classifies a file under an authorized path; `None` means it is never opened.
    pub kind: fn(&Path) -> Option<SourceKind>,
    /// Usage once seen stays counted when the tool later rewinds, deletes or rewrites it (an append-only ledger).
    pub ledger: bool,
    /// Reads usage from a parsed `json` document and the sibling files named by `sidecars`.
    pub document: Option<fn(&Path, &Value, &Sidecars) -> ParseResult>,
    /// Sibling files read with a document, by role. Each is read only inside the authorized path; `None` when absent.
    pub sidecars: Option<fn(&Path) -> SidecarPaths>,
    /// Reads usage from a `sqlite` database, opened read-only. The events are those already counted from it. An error
    /// (busy, locked, unreadable) fails the file. A scan reads a database without `incremental` through the
    /// OpenCode-format reader, which also records fork lineage, so any other format sets `incremental`.
    pub database: Option<DatabaseReader>,
    /// Reads a `sqlite` database from where the last scan stopped instead of whole; usage it does not return again
    /// stays counted. Takes precedence over `database` during a scan.
    pub incremental: Option<IncrementalReader>,
    /// Reads each record of a `jsonl` line log (or compressed one); tools without it use the built-in readers.
    pub(crate) line: Option<LineReader>,
    /// Reads a `json`-kind file as text instead of as a JSON document.
    pub text: Option<TextReader>,
    /// Once a database is found, the tool has imported its documents into it: they are no longer read, and their usage
    /// is withdrawn.
    pub database_supersedes_documents: bool,
    /// Read passively and for usage metadata only (roadmap rule 1), so the first launch may turn the tool on by itself.
    /// Every current reader is.
    pub passive: bool,
}

/// Larger documents are skipped with `record_too_large` rather than parsed in memory.
pub const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
pub const NO_CAPABILITIES: SourceCapabilities = SourceCapabilities {
    tokens: false,
    models: false,
    projects: false,
    costs: false,
    quotas: false,
};

const fn capabilities(models: bool, projects: bool) -> SourceCapabilities {
    SourceCapabilities {
        tokens: true,
        models,
        projects,
        costs: false,
        quotas: false,
    }
}
fn jsonl(path: &Path) -> Option<SourceKind> {
    path.as_os_str()
        .as_encoded_bytes()
        .ends_with(b".jsonl")
        .then_some(SourceKind::Jsonl)
}
fn task_messages(path: &Path) -> Option<SourceKind> {
    (file_name(path) == "ui_messages.json").then_some(SourceKind::Json)
}
/// `join(dirname(path), name)`.
fn beside(path: &Path, name: &str) -> PathBuf {
    path.parent().unwrap_or(Path::new("")).join(name)
}
/// Roo Code task folders also hold the conversation (for the model) and the history item (for the workspace).
fn task_sidecars(path: &Path) -> SidecarPaths {
    vec![
        ("history", beside(path, "api_conversation_history.json")),
        ("item", beside(path, "history_item.json")),
    ]
}
/// `/^prefix.+suffix$/`: at least one character between, none of them a line terminator.
fn framed(name: &str, prefix: &str, suffix: &str) -> bool {
    let middle = name.strip_prefix(prefix).and_then(|rest| rest.strip_suffix(suffix));
    middle.is_some_and(|middle| !middle.is_empty() && !middle.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
}

/// Claude Code and Codex logs; the base of the other adapters.
const LINE_LOG: Adapter = Adapter {
    capabilities: capabilities(true, true),
    kind: jsonl,
    ledger: false,
    document: None,
    sidecars: None,
    database: None,
    incremental: None,
    line: None,
    text: None,
    database_supersedes_documents: false,
    passive: true,
};
static CLAUDE: Adapter = LINE_LOG;
/// Rollouts, and the `rollout-*.jsonl.zst` (or `.jsonl.zstd`) archives newer versions compress older ones into.
static CODEX: Adapter = Adapter {
    kind: |path| {
        let name = file_name(path);
        if framed(&name, "rollout-", ".jsonl.zst") || framed(&name, "rollout-", ".jsonl.zstd") {
            Some(SourceKind::CompressedJsonl)
        } else {
            jsonl(path)
        }
    },
    ..LINE_LOG
};
/// `tmp/<project>/chats/session-*.jsonl`, subagents in `chats/<parent>/`, and legacy `session-*.json`.
static GEMINI: Adapter = Adapter {
    capabilities: capabilities(true, false),
    kind: |path| {
        let name = file_name(path);
        let chats = path
            .parent()
            .is_some_and(|dir| dir.components().any(|part| part.as_os_str() == "chats"));
        if !chats || name.contains(".unreadable-") || name.contains(".tmp-") {
            None
        } else if name.ends_with(".jsonl") {
            Some(SourceKind::Jsonl)
        } else {
            framed(&name, "session-", ".json").then_some(SourceKind::Json)
        }
    },
    ledger: true,
    document: Some(|_, document, _| parse_gemini_session(document)),
    ..LINE_LOG
};
/// SDK sessions `<id>/<stem>.messages.json` with the `<id>/<id>.json` manifest; classic extension `tasks/<id>/ui_messages.json`.
static CLINE: Adapter = Adapter {
    capabilities: capabilities(true, true),
    kind: |path| {
        let name = file_name(path);
        (name.ends_with(".messages.json") || name == "ui_messages.json").then_some(SourceKind::Json)
    },
    ledger: true,
    sidecars: Some(|path| {
        if file_name(path) == "ui_messages.json" {
            vec![("metadata", beside(path, "task_metadata.json"))]
        } else {
            vec![("manifest", beside(path, &format!("{}.json", parent_name(path))))]
        }
    }),
    document: Some(|path, document, sidecars| {
        if file_name(path) == "ui_messages.json" {
            cline::parse_cline_task(path, document, sidecars)
        } else {
            cline::parse_cline_session(path, document, sidecars)
        }
    }),
    ..LINE_LOG
};
/// `globalStorage/rooveterinaryinc.roo-cline/tasks/<id>/ui_messages.json`, or the same layout under a custom storage path.
static ROO: Adapter = Adapter {
    capabilities: capabilities(true, true),
    kind: task_messages,
    ledger: true,
    sidecars: Some(task_sidecars),
    document: Some(|path, document, sidecars| roo::parse_task_messages(ToolId::Roo, path, document, sidecars)),
    ..LINE_LOG
};
/// `opencode.db` (v1 and OpenCode 2 tables) and the flat `storage/message/<session>/msg_*.json` files kept from before 1.2.
static OPENCODE: Adapter = Adapter {
    capabilities: capabilities(true, true),
    kind: |path| {
        let message = path
            .parent()
            .and_then(Path::parent)
            .is_some_and(|dir| file_name(dir) == "message");
        if path.as_os_str().as_encoded_bytes().ends_with(b".db") {
            Some(SourceKind::Sqlite)
        } else {
            (message && framed(&file_name(path), "msg_", ".json")).then_some(SourceKind::Json)
        }
    },
    ledger: true,
    document: Some(opencode::parse_opencode_message),
    database: Some(|path, known| opencode::read_opencode_database(ToolId::OpenCode, path, known)),
    ..LINE_LOG
};
/// Kilo Code 7 runs an OpenCode fork with `kilo.db`; version 5 kept Roo Code-style tasks in `globalStorage/kilocode.kilo-code`.
static KILO: Adapter = Adapter {
    capabilities: capabilities(true, true),
    kind: |path| {
        if path.as_os_str().as_encoded_bytes().ends_with(b".db") {
            Some(SourceKind::Sqlite)
        } else {
            task_messages(path)
        }
    },
    ledger: true,
    sidecars: Some(task_sidecars),
    document: Some(|path, document, sidecars| roo::parse_task_messages(ToolId::Kilo, path, document, sidecars)),
    database: Some(|path, known| opencode::read_opencode_database(ToolId::Kilo, path, known)),
    incremental: None,
    line: None,
    text: None,
    // The pinned v7 importer writes ZERO usage. Retain the legacy request ledger.
    database_supersedes_documents: false,
    passive: true,
};

/// Passive local readers. A tool without an adapter is reported as unsupported.
pub fn adapter(tool: ToolId) -> Option<&'static Adapter> {
    match tool {
        ToolId::Claude => Some(&CLAUDE),
        ToolId::Codex => Some(&CODEX),
        ToolId::Gemini => Some(&GEMINI),
        ToolId::Cline => Some(&CLINE),
        ToolId::Roo => Some(&ROO),
        ToolId::OpenCode => Some(&OPENCODE),
        ToolId::Kilo => Some(&KILO),
        ToolId::Cursor => None,
        ToolId::EveryCode => everycode::adapter(tool),
        ToolId::Mimo => mimo::adapter(tool),
        ToolId::DuMate => dumate::adapter(tool),
        ToolId::Pi => pi::adapter(tool),
        ToolId::Omp => pi::adapter(tool),
        ToolId::Omo => pi::adapter(tool),
        ToolId::PrimeAgent => pi::adapter(tool),
        ToolId::MiniMax => pi::adapter(tool),
        ToolId::CodeBuddy => codebuddy::adapter(tool),
        ToolId::Kimi => kimi::adapter(tool),
        ToolId::CommandCode => commandcode::adapter(tool),
        ToolId::DeepSeek => deepseek::adapter(tool),
        ToolId::LmStudio => lmstudio::adapter(tool),
        ToolId::Copilot => copilot::adapter(tool),
        ToolId::Unsloth => unsloth::adapter(tool),
        ToolId::ZCode => zcode::adapter(tool),
        ToolId::Zed => zed::adapter(tool),
        ToolId::OpenClaw => openclaw::adapter(tool),
        ToolId::Reasonix => reasonix::adapter(tool),
        ToolId::Hermes => hermes::adapter(tool),
        ToolId::Goose => goose::adapter(tool),
        ToolId::Grok => grok::adapter(tool),
    }
}
pub fn is_supported(tool: ToolId) -> bool {
    adapter(tool).is_some()
}
/// Tools whose databases keep one running total per session (Zed Agent, Hermes Agent, Goose). Their reader is given
/// the tool's events from every file instead of one file's, so a session's growth is measured against what any copy
/// of the database already counted, and a copied or moved database adds nothing.
pub fn counts_across_copies(tool: ToolId) -> bool {
    matches!(tool, ToolId::Zed | ToolId::Hermes | ToolId::Goose)
}
pub fn source_kind(tool: ToolId, path: &Path) -> Option<SourceKind> {
    adapter(tool).and_then(|adapter| (adapter.kind)(path))
}

/// Pure parser for whole-document sources. Unparseable content reports [`PENDING`].
pub fn parse_document(tool: ToolId, path: &Path, content: &str, sidecars: &Sidecars) -> ParseResult {
    let json = adapter(tool).filter(|adapter| (adapter.kind)(path) == Some(SourceKind::Json));
    if let Some(read) = json.and_then(|adapter| adapter.text) {
        return read(path, content, sidecars);
    }
    let Some(read) = json.and_then(|a| a.document) else {
        return only("unsupported_source");
    };
    match parse_json(content) {
        Some(document) => read(path, &document, sidecars),
        None => only(PENDING),
    }
}
