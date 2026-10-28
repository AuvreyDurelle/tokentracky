//! What sits beside the golden fixtures: permissions and symlinks, the database lock, crash recovery, receipts and the
//! metadata boundary. The symlink cases are Unix only.
mod support;

use serde_json::json;
use std::fs;
use std::io::{BufRead, BufReader};
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::Duration;
use support::fixture_text;
use time::OffsetDateTime;
use tokentracky_collector::store::{PublicationOptions, QueryOptions, SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService, ScanResult};
use tokentracky_core::{MAX_SAFE_INTEGER, SourceState, SourceStatus, TOOL_IDS, ToolId};

/// What these tests need from a log is any one valid Claude Code record: the golden fixtures hold it.
fn claude_log() -> String {
    fixture_text("claude/cache-categories-disjoint/root/session.jsonl")
}
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A temporary folder with the authorized folder (`source`) and the database beside it.
struct Folder {
    _temporary: tempfile::TempDir,
    directory: PathBuf,
    source: PathBuf,
    database: PathBuf,
}
fn folder() -> Folder {
    let temporary = tempfile::Builder::new().prefix("synthetic-").tempdir().unwrap();
    let directory = fs::canonicalize(temporary.path()).unwrap();
    let source = directory.join("authorized");
    fs::create_dir(&source).unwrap();
    Folder {
        database: directory.join("usage.sqlite"),
        source,
        directory,
        _temporary: temporary,
    }
}

struct Collector {
    store: Arc<Mutex<UsageStore>>,
    service: IngestionService,
}
fn open(database: &Path) -> Collector {
    open_with(database, IngestionOptions::default())
}
fn open_with(database: &Path, options: IngestionOptions) -> Collector {
    let store = Arc::new(Mutex::new(UsageStore::open(database).unwrap()));
    Collector {
        service: IngestionService::new(store.clone(), options).unwrap(),
        store,
    }
}
impl Collector {
    fn store(&self) -> MutexGuard<'_, UsageStore> {
        self.store.lock().unwrap()
    }
    fn grant(&self, tool: ToolId, path: &Path) -> SourceStatus {
        let configuration = SourceConfiguration {
            enabled: true,
            paths: vec![text(path)],
        };
        self.service.configure_source(tool, &configuration).unwrap()
    }
    fn scan(&self) -> ScanResult {
        let result = self.service.scan().unwrap();
        assert!(!result.diagnostics.contains(&"file_read_failed".to_owned()));
        result
    }
    fn tokens(&self) -> u64 {
        self.store().summary(&QueryOptions::default()).unwrap().tokens
    }
    /// Waits for a scan and closes the store, which releases the database lock.
    fn close(self) {
        self.service.stop();
        drop(self.service);
        let store = Arc::try_unwrap(self.store).unwrap_or_else(|_| panic!("the store has one owner"));
        store.into_inner().unwrap().close().unwrap();
    }
}

/// The refresh cycle admits its scan before handing it to the blocking pool, so a pause (`stop`) that lands between
/// the two waits for the scan, as it waits for TypeScript's synchronously started one, instead of returning first and
/// letting the scan read logs after the pause has applied.
#[test]
fn stop_waits_for_a_scan_admitted_but_not_yet_started() {
    let folder = folder();
    fs::write(folder.source.join("session.jsonl"), claude_log()).unwrap();
    let store = Arc::new(Mutex::new(UsageStore::open(&folder.database).unwrap()));
    let service = Arc::new(IngestionService::new(store.clone(), IngestionOptions::default()).unwrap());
    let configuration = SourceConfiguration {
        enabled: true,
        paths: vec![text(&folder.source)],
    };
    service.configure_source(ToolId::Claude, &configuration).unwrap();

    let ticket = service.admit();
    assert!(service.status().unwrap().collecting, "an admitted scan is in flight");
    let stopped = Arc::new(AtomicUsize::new(0));
    let (stopping, done) = (service.clone(), stopped.clone());
    let stop = std::thread::spawn(move || {
        stopping.stop();
        done.store(1, Ordering::SeqCst);
    });
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(stopped.load(Ordering::SeqCst), 0, "stop waits for the admitted scan");
    let result = ticket.scan().unwrap();
    stop.join().unwrap();
    assert!(result.diagnostics.is_empty());
    assert!(store.lock().unwrap().summary(&QueryOptions::default()).unwrap().tokens > 0);
    assert!(!service.status().unwrap().collecting);

    // A ticket dropped without scanning withdraws its admission, so stop does not wait for it.
    drop(service.admit());
    service.stop();
    assert!(!service.status().unwrap().collecting);
    drop(service);
    Arc::try_unwrap(store)
        .ok()
        .unwrap()
        .into_inner()
        .unwrap()
        .close()
        .unwrap();
}

#[test]
fn persists_pending_receipts_across_restart_and_restores_exact_ancestry_from_backups() {
    let folder = folder();
    fs::write(folder.source.join("session.jsonl"), claude_log()).unwrap();
    let mut collector = open(&folder.database);
    collector.grant(ToolId::Claude, &folder.source);
    collector.scan();
    let options = PublicationOptions::default();
    let pending = collector.store().pending_publication("target", &options).unwrap();
    collector.close();
    let backup = folder.directory.join("backup.sqlite");
    fs::copy(&folder.database, &backup).unwrap();
    collector = open(&folder.database);
    assert_eq!(
        collector.store().pending_publication("target", &options).unwrap(),
        pending
    );
    collector
        .store()
        .acknowledge_publication("target", &pending.receipt)
        .unwrap();
    let next = collector.store().pending_publication("target", &options).unwrap();
    assert_eq!(next.base_receipt.as_deref(), Some(pending.receipt.as_str()));
    collector.close();
    fs::copy(&backup, &folder.database).unwrap();
    collector = open(&folder.database);
    assert_eq!(
        collector.store().pending_publication("target", &options).unwrap(),
        pending
    );
    collector.close();
    fs::remove_file(&folder.database).unwrap();
    collector = open(&folder.database);
    assert_ne!(
        collector.store().publication_state().unwrap().collector_id,
        pending.collector_id
    );
}

/// The scan visits directory entries in byte order (the `localeCompare` order of every fixture name), and processing
/// order decides which of two differing copies of a record is current. No golden fixture depends on the order.
#[test]
fn visits_directory_entries_in_byte_order_so_the_later_of_two_differing_copies_is_current() {
    let folder = folder();
    let log = claude_log();
    fs::write(folder.source.join("a.jsonl"), &log).unwrap();
    let corrected = log.replace(r#""output_tokens":20"#, r#""output_tokens":25"#);
    assert_ne!(corrected, log);
    fs::write(folder.source.join("b.jsonl"), corrected).unwrap();
    let collector = open(&folder.database);
    collector.grant(ToolId::Claude, &folder.source);
    collector.scan();
    assert_eq!(collector.tokens(), 11 + 25 + 100 + 30);
}

mod explicit_permissions_and_ownership {
    use super::*;

    #[test]
    fn refuses_empty_or_relative_scopes_and_leaves_unverified_adapters_unsupported() {
        let folder = folder();
        let collector = open(&folder.database);
        let configure = |tool, paths: &[&str]| {
            let configuration = SourceConfiguration {
                enabled: true,
                paths: paths.iter().map(|path| (*path).to_owned()).collect(),
            };
            collector.service.configure_source(tool, &configuration)
        };
        let error = configure(ToolId::Claude, &[]).unwrap_err();
        assert_eq!(error.to_string(), "enabled_source_requires_paths");
        let error = configure(ToolId::Codex, &["relative"]).unwrap_err();
        assert_eq!(error.to_string(), "invalid_source_configuration");
        configure(ToolId::Cursor, &[&text(&folder.directory.join("does-not-exist"))]).unwrap();
        collector.scan();
        let status = collector.service.status().unwrap();
        let cursor = status
            .sources
            .iter()
            .find(|source| source.id == ToolId::Cursor)
            .unwrap();
        assert_eq!(cursor.state, SourceState::Unsupported);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks_into_unapproved_directories_and_rejects_symlink_replacement_of_an_approved_root() {
        let folder = folder();
        let outside = folder.directory.join("unapproved");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("private.jsonl"), claude_log()).unwrap();
        symlink(&outside, folder.source.join("linked-directory")).unwrap();
        symlink(outside.join("private.jsonl"), folder.source.join("linked-file.jsonl")).unwrap();
        let collector = open(&folder.database);
        collector.grant(ToolId::Claude, &folder.source);
        collector.scan();
        assert_eq!(collector.tokens(), 0);
        fs::rename(&folder.source, folder.directory.join("old-authorized")).unwrap();
        symlink(&outside, &folder.source).unwrap();
        let result = collector.scan();
        assert!(result.diagnostics.contains(&"source_read_failed".to_owned()));
        assert_eq!(collector.tokens(), 0);
    }

    #[test]
    fn locks_the_database_to_one_owner_allows_clean_restart_and_serializes_scans() {
        let folder = folder();
        // The first scan's clock blocks until released, so a second scan starts while it runs.
        let (entered, scanning) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let (calls, released) = (Arc::new(AtomicUsize::new(0)), Mutex::new(released));
        let counted = calls.clone();
        let now = Arc::new(move || {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                entered.send(()).unwrap();
                released.lock().unwrap().recv().unwrap();
            }
            OffsetDateTime::UNIX_EPOCH
        });
        let options = IngestionOptions {
            now: Some(now),
            ..Default::default()
        };
        let mut collector = open_with(&folder.database, options);
        let error = UsageStore::open(&folder.database).err().unwrap();
        assert_eq!(error.to_string(), "collector_database_locked");
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| collector.service.scan().unwrap());
            scanning.recv().unwrap();
            let second = scope.spawn(|| collector.service.scan().unwrap());
            assert!(collector.service.status().unwrap().collecting);
            // Time for the second caller to join the scan in flight before it finishes.
            std::thread::sleep(Duration::from_millis(200));
            release.send(()).unwrap();
            (first.join().unwrap(), second.join().unwrap())
        });
        assert_eq!(first, second);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "one scan, shared");
        collector.close();
        collector = open(&folder.database);
        assert_eq!(collector.store().source_statuses().unwrap().len(), TOOL_IDS.len());
    }

    #[test]
    fn automatically_recovers_lifetime_ownership_after_a_process_crashes() {
        let folder = folder();
        open(&folder.database).close();
        let mut lock = folder.database.as_os_str().to_owned();
        lock.push(".collector-lock.sqlite");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "lock_holder", "--nocapture", "--test-threads=1"])
            .env(HOLD_LOCK, &lock)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        assert!(
            output.lines().any(|line| line.unwrap().trim_end().ends_with("ready")),
            "the lock holder did not start"
        );
        let error = UsageStore::open(&folder.database).err().unwrap();
        assert_eq!(error.to_string(), "collector_database_locked");
        child.kill().unwrap();
        child.wait().unwrap();
        let collector = open(&folder.database);
        assert_eq!(collector.tokens(), 0);
    }
}

/// One Claude Code request of `input + output` tokens, a whole line.
fn request(id: &str, input: u64, output: u64) -> String {
    format!(
        r#"{{"type":"assistant","sessionId":"s","timestamp":"2026-10-20T12:00:00.000Z","message":{{"id":"{id}","model":"claude-sonnet-4-6","usage":{{"input_tokens":{input},"output_tokens":{output}}}}}}}"#
    ) + "\n"
}

mod appended_logs {
    use super::*;

    #[test]
    fn a_log_rewritten_longer_with_a_new_tail_is_read_afresh() {
        let folder = folder();
        let file = folder.source.join("session.jsonl");
        fs::write(&file, request("a", 1, 2) + &request("b", 3, 4)).unwrap();
        let collector = open(&folder.database);
        collector.grant(ToolId::Claude, &folder.source);
        collector.scan();
        assert_eq!(collector.tokens(), 10);
        // Truncated in place (same inode) and rewritten with three different, longer records.
        let rewritten = request("c-longer", 100, 200) + &request("d-longer", 300, 400) + &request("e-longer", 5, 6);
        fs::write(&file, rewritten).unwrap();
        collector.scan();
        assert_eq!(collector.tokens(), 1011);
    }
    #[test]
    fn an_appended_record_is_read_from_the_saved_offset() {
        let folder = folder();
        let file = folder.source.join("session.jsonl");
        fs::write(&file, request("a", 1, 2) + &request("b", 3, 4)).unwrap();
        let collector = open(&folder.database);
        collector.grant(ToolId::Claude, &folder.source);
        collector.scan();
        let mut log = fs::OpenOptions::new().append(true).open(&file).unwrap();
        std::io::Write::write_all(&mut log, request("c", 5, 6).as_bytes()).unwrap();
        collector.scan();
        assert_eq!(collector.tokens(), 21);
        assert_eq!(collector.store().events(&QueryOptions::default()).unwrap().len(), 3);
    }
}

const HOLD_LOCK: &str = "TOKENTRACKY_TEST_HOLD_LOCK";
/// The crashing process of `automatically_recovers_lifetime_ownership_after_a_process_crashes`: run as a child of that
/// test, it takes the lock as a collector does and holds it until killed. Otherwise it does nothing.
#[test]
fn lock_holder() {
    let Some(path) = std::env::var_os(HOLD_LOCK) else {
        return;
    };
    let db = rusqlite::Connection::open(path).unwrap();
    db.execute_batch("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS collector_owner(id INTEGER);")
        .unwrap();
    println!("ready");
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

mod stored_metadata_boundary {
    use super::*;

    /// Events are typed, so an unknown field cannot reach the store; the parser state is JSON and is allowlisted.
    #[test]
    fn strips_unknown_fields_from_checkpoints_and_rolls_back_invalid_writes() {
        let folder = folder();
        let file = folder.source.join("session.jsonl");
        fs::write(&file, claude_log()).unwrap();
        let collector = open(&folder.database);
        collector.grant(ToolId::Claude, &folder.source);
        collector.scan();
        let mut store = collector.store();
        let mut checkpoint = store.checkpoint(&text(&file), None).unwrap().unwrap();
        let event = store.events(&QueryOptions::default()).unwrap()[0].clone();
        checkpoint.state["prompt"] = json!("PRIVATE_NEW_MARKER");
        store
            .commit_file(&checkpoint, std::slice::from_ref(&event), true)
            .unwrap();
        let saved = store.checkpoint(&text(&file), None).unwrap();
        assert!(!serde_json::to_string(&saved).unwrap().contains("PRIVATE_NEW_MARKER"));
        let prior = store.events(&QueryOptions::default()).unwrap();
        let mut invalid = event;
        invalid.tokens.input = MAX_SAFE_INTEGER + 1;
        let error = store.commit_file(&checkpoint, &[invalid], true).unwrap_err();
        assert_eq!(error.to_string(), "invalid_usage_event");
        assert_eq!(store.events(&QueryOptions::default()).unwrap(), prior);
    }
}

/// One message can sit in several saved folders: two Claude Code profiles, one folder saved again through a symlink, or
/// a Codex rollout moved into `archived_sessions`. It counts once.
mod copies_across_folders {
    use super::*;

    fn save(collector: &Collector, tool: ToolId, paths: &[&Path]) -> SourceStatus {
        let configuration = SourceConfiguration {
            enabled: true,
            paths: paths.iter().map(|path| text(path)).collect(),
        };
        collector.service.configure_source(tool, &configuration).unwrap()
    }

    #[test]
    fn a_claude_session_in_two_profiles_counts_once_and_stays_counted_when_one_copy_goes() {
        let folder = folder();
        let profiles = [
            folder.source.join("work/projects"),
            folder.source.join("personal/projects"),
        ];
        for projects in &profiles {
            fs::create_dir_all(projects.join("-Users-ada-app")).unwrap();
            fs::write(projects.join("-Users-ada-app/session.jsonl"), claude_log()).unwrap();
        }
        let collector = open(&folder.database);
        save(&collector, ToolId::Claude, &[&profiles[0], &profiles[1]]);
        collector.scan();
        for projects in &profiles {
            let file = text(&projects.join("-Users-ada-app/session.jsonl"));
            assert!(
                collector.store().checkpoint(&file, None).unwrap().is_some(),
                "both profiles are read"
            );
        }
        assert_eq!(collector.tokens(), 161);
        fs::remove_file(profiles[1].join("-Users-ada-app/session.jsonl")).unwrap();
        collector.scan();
        assert_eq!(collector.tokens(), 161);
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_saved_again_through_a_symlink_or_in_other_letter_case_is_saved_once() {
        let folder = folder();
        let projects = folder.source.join("projects");
        fs::create_dir(&projects).unwrap();
        fs::write(projects.join("session.jsonl"), claude_log()).unwrap();
        let link = folder.source.join("claude-work");
        symlink(&projects, &link).unwrap();
        let mut paths = vec![projects.clone(), link];
        // Only on a volume that ignores letter case, as macOS's does by default.
        let upper = folder.source.join("PROJECTS");
        if upper.exists() {
            paths.push(upper);
        }
        let collector = open(&folder.database);
        let saved = save(
            &collector,
            ToolId::Claude,
            &paths.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
        );
        assert_eq!(saved.paths, [text(&projects)]);
        collector.scan();
        assert_eq!(collector.tokens(), 161);
    }

    #[test]
    fn a_codex_rollout_moved_into_archived_sessions_counts_once() {
        let folder = folder();
        let (sessions, archived) = (folder.source.join("sessions"), folder.source.join("archived_sessions"));
        let day = sessions.join("2026/10/25");
        fs::create_dir_all(&day).unwrap();
        fs::create_dir(&archived).unwrap();
        let rollout = "rollout-2026-10-25T09-00-00-one.jsonl";
        fs::write(day.join(rollout), fixture_text("codex/copied-rollouts/root/one.jsonl")).unwrap();
        let collector = open(&folder.database);
        save(&collector, ToolId::Codex, &[&sessions, &archived]);
        collector.scan();
        assert_eq!(collector.tokens(), 135);
        fs::rename(day.join(rollout), archived.join(rollout)).unwrap();
        collector.scan();
        let moved = text(&archived.join(rollout));
        assert!(
            collector.store().checkpoint(&moved, None).unwrap().is_some(),
            "the archived copy is read"
        );
        assert_eq!(collector.tokens(), 135);
    }

    #[test]
    fn a_saved_folder_inside_another_is_walked_once() {
        for inner_first in [false, true] {
            let folder = folder();
            let (outer, inner) = (folder.source.as_path(), folder.source.join("projects"));
            fs::create_dir(&inner).unwrap();
            fs::write(inner.join("session.jsonl"), claude_log()).unwrap();
            // One file fits the limit only if it is found once.
            let options = IngestionOptions {
                max_files: 1,
                ..Default::default()
            };
            let collector = open_with(&folder.database, options);
            let roots = if inner_first {
                [inner.as_path(), outer]
            } else {
                [outer, inner.as_path()]
            };
            save(&collector, ToolId::Claude, &roots);
            let result = collector.scan();
            assert!(!result.diagnostics.contains(&"source_read_failed".to_owned()));
            assert_eq!(collector.tokens(), 161);
        }
    }

    #[test]
    fn a_saved_folder_inside_another_stays_counted_when_the_outer_walk_fails() {
        for inner_first in [false, true] {
            let folder = folder();
            let (outer, inner) = (folder.source.as_path(), folder.source.join("a"));
            fs::create_dir(&inner).unwrap();
            fs::write(inner.join("session.jsonl"), claude_log()).unwrap();
            // The outer walk fails at `z/deep`, past the depth limit, after reaching `a`.
            fs::create_dir_all(outer.join("z/deep")).unwrap();
            let options = IngestionOptions {
                max_depth: 1,
                ..Default::default()
            };
            let collector = open_with(&folder.database, options);
            let roots = if inner_first {
                [inner.as_path(), outer]
            } else {
                [outer, inner.as_path()]
            };
            save(&collector, ToolId::Claude, &roots);
            let result = collector.scan();
            assert!(result.diagnostics.contains(&"source_read_failed".to_owned()));
            assert_eq!(collector.tokens(), 161);
        }
    }

    #[test]
    fn a_saved_document_inside_a_saved_folder_keeps_the_folder_s_sidecars() {
        for file_first in [false, true] {
            let folder = folder();
            let session = folder.source.join("s_unknown");
            fs::create_dir(&session).unwrap();
            for name in ["s_unknown.json", "s_unknown.messages.json"] {
                let fixture = format!("cline/sdk-imported-sessions/root/sessions/s_unknown/{name}");
                fs::write(session.join(name), fixture_text(&fixture)).unwrap();
            }
            let messages = session.join("s_unknown.messages.json");
            let collector = open(&folder.database);
            let roots = if file_first {
                [messages.as_path(), session.as_path()]
            } else {
                [session.as_path(), messages.as_path()]
            };
            save(&collector, ToolId::Cline, &roots);
            collector.scan();
            assert!(collector.store().checkpoint(&text(&messages), None).unwrap().is_some());
            // The manifest marks the session imported at an unknown time, so none of its usage counts.
            assert_eq!(collector.tokens(), 0);
        }
    }
}
