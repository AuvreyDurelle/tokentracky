//! Codex archive regression cases (`rollout-*.jsonl.zst`). Archives are built with ruzstd's encoder here.
mod support;

use ruzstd::encoding::{CompressionLevel, compress_to_vec};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use support::fixture_text;
use tokentracky_collector::store::{QueryOptions, SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService};
use tokentracky_core::{ToolId, total_tokens};

/// A rollout of 230 tokens (`fixtures/codex/cumulative-differencing`), as session `session`.
fn rollout(session: &str) -> String {
    fixture_text("codex/cumulative-differencing/root/rollout.jsonl").replace("codex-session", session)
}
fn compressed(text: &str) -> Vec<u8> {
    compress_to_vec(text.as_bytes(), CompressionLevel::Fastest)
}

/// A Codex home (`sessions/` and `archived_sessions/`) authorized as one folder, with its store.
struct Home {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    store: Arc<Mutex<UsageStore>>,
    service: IngestionService,
}
impl Home {
    fn new(options: IngestionOptions) -> Self {
        let temporary = tempfile::Builder::new().prefix("synthetic-").tempdir().unwrap();
        let directory = fs::canonicalize(temporary.path()).unwrap();
        let root = directory.join("codex");
        for folder in ["sessions", "archived_sessions"] {
            fs::create_dir_all(root.join(folder)).unwrap();
        }
        let store = Arc::new(Mutex::new(UsageStore::open(directory.join("usage.sqlite")).unwrap()));
        let service = IngestionService::new(store.clone(), options).unwrap();
        let paths = vec![root.to_string_lossy().into_owned()];
        service
            .configure_source(ToolId::Codex, &SourceConfiguration { enabled: true, paths })
            .unwrap();
        Self {
            _temporary: temporary,
            root,
            store,
            service,
        }
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }
    fn write(&self, relative: &str, content: impl AsRef<[u8]>) {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    /// One scan: the tokens of every event counted, and the scan's diagnostic codes.
    fn scan(&self) -> (u64, Vec<String>) {
        let diagnostics = self.service.scan().unwrap().diagnostics;
        let events = self.store.lock().unwrap().events(&QueryOptions::default()).unwrap();
        (
            events.iter().map(|event| total_tokens(&event.tokens)).sum(),
            diagnostics,
        )
    }
    fn message(&self) -> String {
        let sources = self.store.lock().unwrap().source_statuses().unwrap();
        sources
            .into_iter()
            .find(|source| source.id == ToolId::Codex)
            .unwrap()
            .message
    }
}
fn none() -> Vec<String> {
    Vec::new()
}

#[test]
fn an_archive_alone_counts_exactly() {
    let home = Home::new(IngestionOptions::default());
    home.write("sessions/2026/10/20/rollout-a.jsonl.zst", compressed(&rollout("a")));
    assert_eq!(home.scan(), (230, none()));
    home.write("sessions/2026/10/20/rollout-b.jsonl.zstd", compressed(&rollout("b")));
    // Only rollouts are archives.
    home.write("sessions/2026/10/20/notes.jsonl.zst", compressed(&rollout("c")));
    assert_eq!(home.scan(), (460, none()));
    assert_eq!(home.scan(), (460, none()), "an unchanged archive is not counted again");
    assert_eq!(home.message(), "Authorized logs are current.");
}

#[test]
fn a_rollout_replaced_by_its_archive_leaves_the_total_unchanged() {
    let home = Home::new(IngestionOptions::default());
    home.write("sessions/rollout-a.jsonl", rollout("a"));
    assert_eq!(home.scan(), (230, none()));
    home.write("sessions/rollout-a.jsonl.zst", compressed(&rollout("a")));
    assert_eq!(
        home.scan(),
        (230, none()),
        "the same event ids from a second file count once"
    );
    fs::remove_file(home.path("sessions/rollout-a.jsonl")).unwrap();
    assert_eq!(home.scan(), (230, none()));
}

#[test]
fn a_session_moved_to_archived_sessions_leaves_the_total_unchanged() {
    let home = Home::new(IngestionOptions::default());
    home.write("sessions/2026/10/20/rollout-a.jsonl.zst", compressed(&rollout("a")));
    assert_eq!(home.scan(), (230, none()));
    fs::rename(
        home.path("sessions/2026/10/20/rollout-a.jsonl.zst"),
        home.path("archived_sessions/rollout-a.jsonl.zst"),
    )
    .unwrap();
    assert_eq!(home.scan(), (230, none()));
}

#[test]
fn a_truncated_archive_gives_a_diagnostic_while_the_other_files_still_count() {
    let home = Home::new(IngestionOptions::default());
    let truncated = |session| {
        let archive = compressed(&rollout(session));
        archive[..archive.len() / 2].to_vec()
    };
    home.write("sessions/rollout-a.jsonl.zst", truncated("a"));
    home.write("sessions/rollout-b.jsonl", rollout("b"));
    assert_eq!(home.scan(), (230, vec!["archive_unreadable".to_owned()]));
    assert_eq!(home.message(), "Import completed with diagnostics: archive_unreadable.");
    // An archive that later becomes unreadable keeps the usage already counted from it.
    home.write("sessions/rollout-c.jsonl.zst", compressed(&rollout("c")));
    assert_eq!(home.scan(), (460, vec!["archive_unreadable".to_owned()]));
    home.write("sessions/rollout-c.jsonl.zst", truncated("c"));
    assert_eq!(home.scan(), (460, vec!["archive_unreadable".to_owned()]));
    home.write("sessions/rollout-a.jsonl.zst", b"not an archive");
    assert_eq!(home.scan(), (460, vec!["archive_unreadable".to_owned()]));
}

#[test]
fn an_archive_over_the_cap_is_skipped_with_a_diagnostic() {
    let size = rollout("a").len() as u64;
    let at_cap = Home::new(IngestionOptions {
        max_archive_bytes: size,
        ..Default::default()
    });
    at_cap.write("sessions/rollout-a.jsonl.zst", compressed(&rollout("a")));
    assert_eq!(at_cap.scan(), (230, none()));
    let over_cap = Home::new(IngestionOptions {
        max_archive_bytes: size - 1,
        ..Default::default()
    });
    over_cap.write("sessions/rollout-a.jsonl.zst", compressed(&rollout("a")));
    over_cap.write("sessions/rollout-b.jsonl", rollout("b"));
    assert_eq!(over_cap.scan(), (230, vec!["record_too_large".to_owned()]));
}

/// The line limit applies inside an archive too (a token count too long to read is reported), and its last line needs
/// no newline: here that line is the request that brings the session from 120 to 230 tokens.
#[test]
fn reads_archive_lines_as_rollout_lines() {
    let home = Home::new(IngestionOptions::default());
    let long = format!(
        "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":null,\"pad\":\"{}\"}}}}",
        "x".repeat(1024 * 1024)
    );
    let text = rollout("a");
    let lines: Vec<&str> = text.lines().collect();
    let without_replay = lines[..lines.len() - 1].join("\n");
    home.write(
        "sessions/rollout-a.jsonl.zst",
        compressed(&format!("{long}\n{without_replay}")),
    );
    assert_eq!(home.scan(), (230, vec!["record_too_large".to_owned()]));
}
