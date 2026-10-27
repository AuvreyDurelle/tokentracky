//! DeepSeek Harness `session[.vN].jsonl.zstd` logs: one independent zstd frame for the header, then one per append.
//! Fixtures hold no binary files, so archives are made here with ruzstd's encoder, as `codex_archives.rs` does.
mod support;

use ruzstd::encoding::{CompressionLevel, compress_to_vec};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use support::fixture_text;
use tokentracky_collector::store::{QueryOptions, SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService};
use tokentracky_core::{ToolId, total_tokens};

const SESSION: &str = "--synthetic-dsh-project--/dsh-session-b";

/// The lines of session `dsh-session-b` as format generation `version` writes them: two messages, 540 and 100 tokens.
fn lines(version: u8) -> Vec<String> {
    let text = fixture_text(format!(
        "deepseek/copies-across-generations-and-forks/root/{SESSION}/session.v{version}.jsonl"
    ));
    text.lines().map(|line| format!("{line}\n")).collect()
}
/// One frame per group of lines, as the harness writes a header frame and then a frame per append batch.
fn frames(groups: &[&[String]]) -> Vec<u8> {
    groups
        .iter()
        .flat_map(|group| compress_to_vec(group.concat().as_bytes(), CompressionLevel::Fastest))
        .collect()
}

/// A harness `sessions` folder authorized as one folder, with its store.
struct Home {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    store: Arc<Mutex<UsageStore>>,
    service: IngestionService,
}
impl Home {
    fn new() -> Self {
        let temporary = tempfile::Builder::new().prefix("synthetic-").tempdir().unwrap();
        let directory = fs::canonicalize(temporary.path()).unwrap();
        let root = directory.join("sessions");
        fs::create_dir_all(root.join(SESSION)).unwrap();
        let store = Arc::new(Mutex::new(UsageStore::open(directory.join("usage.sqlite")).unwrap()));
        let service = IngestionService::new(store.clone(), IngestionOptions::default()).unwrap();
        let paths = vec![root.to_string_lossy().into_owned()];
        service
            .configure_source(ToolId::DeepSeek, &SourceConfiguration { enabled: true, paths })
            .unwrap();
        Self {
            _temporary: temporary,
            root,
            store,
            service,
        }
    }
    fn write(&self, name: &str, content: impl AsRef<[u8]>) {
        fs::write(self.root.join(SESSION).join(name), content).unwrap();
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
}
fn none() -> Vec<String> {
    Vec::new()
}

#[test]
fn reads_every_frame_of_a_log_that_grows_by_appended_frames() {
    let home = Home::new();
    let lines = lines(4);
    // The header frame, then the first turn (the first message, 540 tokens).
    home.write("session.v4.jsonl.zstd", frames(&[&lines[..1], &lines[1..7]]));
    assert_eq!(home.scan(), (540, none()));
    // The second turn appended as a third frame.
    home.write(
        "session.v4.jsonl.zstd",
        frames(&[&lines[..1], &lines[1..7], &lines[7..]]),
    );
    assert_eq!(home.scan(), (640, none()));
    assert_eq!(home.scan(), (640, none()), "an unchanged log is not counted again");
}

#[test]
fn counts_plain_compressed_and_older_generation_copies_once() {
    let home = Home::new();
    home.write("session.v3.jsonl", lines(3).concat());
    home.write("session.v3.jsonl.zstd", frames(&[&lines(3)]));
    home.write("session.v4.jsonl.zstd", frames(&[&lines(4)[..1], &lines(4)[1..]]));
    assert_eq!(home.scan(), (640, none()));
}

#[test]
fn keeps_the_usage_of_a_log_whose_last_frame_is_torn_until_it_is_complete() {
    let home = Home::new();
    let lines = lines(4);
    let complete = frames(&[&lines[..1], &lines[1..7]]);
    home.write("session.v4.jsonl.zstd", &complete);
    assert_eq!(home.scan(), (540, none()));
    // An append cut short: its frame ends early.
    let appended = frames(&[&lines[7..]]);
    let torn = [&complete[..], &appended[..appended.len() / 2]].concat();
    home.write("session.v4.jsonl.zstd", &torn);
    assert_eq!(home.scan(), (540, vec!["archive_unreadable".to_owned()]));
    // Bytes after a frame that are not a frame make it unreadable too.
    home.write("session.v4.jsonl.zstd", [&complete[..], b"not a frame"].concat());
    assert_eq!(home.scan(), (540, vec!["archive_unreadable".to_owned()]));
    home.write("session.v4.jsonl.zstd", [complete, appended].concat());
    assert_eq!(home.scan(), (640, none()));
}
