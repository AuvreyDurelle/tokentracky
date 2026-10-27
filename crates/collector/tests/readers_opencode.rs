//! OpenCode checks that cannot be expressed as output files;
//! the accounting itself is in `fixtures/opencode/*`. Following a live database through a scan is ingestion's test.
mod support;

use std::fs;
use std::path::Path;
use support::{SqlDatabases, fixture_text, fixtures, read_json};
use tokentracky_collector::readers::{Sidecars, parse_document, read_opencode_database};
use tokentracky_core::{ParseResult, ToolId, UsageEvent, total_tokens};

fn tokens(result: &ParseResult) -> u64 {
    result.events.iter().map(|event| total_tokens(&event.tokens)).sum()
}

#[test]
fn reads_a_pre_1_2_message_file_and_nothing_else_under_storage() {
    let message = fixture_text("opencode/flat-message-file/root/storage/message/ses_01TEST/msg_01TEST.json");
    let read = parse_document(
        ToolId::OpenCode,
        Path::new("/x/storage/message/ses_01TEST/msg_01TEST.json"),
        &message,
        &Sidecars::new(),
    );
    assert_eq!(read.events.len(), 1);
    let session = parse_document(
        ToolId::OpenCode,
        Path::new("/x/storage/session/ses_01TEST.json"),
        &message,
        &Sidecars::new(),
    );
    assert_eq!(session.diagnostics, ["unsupported_source"]);
}

#[test]
fn follows_a_live_database_without_ever_writing_to_it_only_the_writers_wal_changes() {
    let live = fixtures().join("opencode/live-wal-database/steps");
    let golden = |step: &str| read_json::<Vec<UsageEvent>>(&live.join(step).join("expected/events.json")).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("opencode.db");
    let mut databases = SqlDatabases::default();
    databases.apply(&live.join("01-first-row/root/opencode.db.sql"), &path);
    let first = read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap();
    assert_eq!((tokens(&first), &first.events), (110, &golden("01-first-row")));
    let before = fs::read(&path).unwrap();
    databases.apply(&live.join("02-updated-and-new-row/root/opencode.db.sql"), &path);
    let updated = read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap();
    assert_eq!(
        (tokens(&updated), &updated.events),
        (3500, &golden("02-updated-and-new-row"))
    );
    assert_eq!(read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap(), updated);
    databases.apply(&live.join("04-row-deleted/root/opencode.db.sql"), &path);
    // The reader sees the new row gone and the first one as updated; keeping the usage is the store's ledger rule.
    let deleted = read_opencode_database(ToolId::OpenCode, &path, &[]).unwrap();
    let kept: Vec<_> = golden("04-row-deleted")
        .into_iter()
        .filter(|event| event.event_id == first.events[0].event_id)
        .collect();
    assert_eq!((deleted.events.len(), &deleted.events), (1, &kept));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(scratch.path().join("opencode.db-wal").exists());
}

#[test]
fn fails_on_a_missing_or_unreadable_database_instead_of_creating_one() {
    let scratch = tempfile::tempdir().unwrap();
    let missing = scratch.path().join("opencode.db");
    assert!(read_opencode_database(ToolId::OpenCode, &missing, &[]).is_err());
    assert!(!missing.exists());
    fs::write(&missing, "PRIVATE_not a database").unwrap();
    assert!(read_opencode_database(ToolId::OpenCode, &missing, &[]).is_err());
}
