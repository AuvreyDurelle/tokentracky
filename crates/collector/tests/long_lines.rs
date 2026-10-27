//! A line too long to read is reported (`record_too_large`, which leaves the source stale) only where it may have held
//! usage: it holds the tool's usage key. Other long lines, such as a large tool result, are skipped without a word.
use std::fs;
use std::sync::{Arc, Mutex};
use tokentracky_collector::store::{SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService};
use tokentracky_core::{SourceState, ToolId};

/// A Claude Code assistant line of `text`'s length, with usage.
fn assistant(id: &str, text: &str) -> String {
    format!(
        r#"{{"type":"assistant","sessionId":"s","timestamp":"2026-10-20T12:00:00.000Z","requestId":"r-{id}","message":{{"id":"{id}","model":"claude-sonnet-4-6","content":[{{"type":"text","text":"{text}"}}],"usage":{{"input_tokens":10,"output_tokens":2}}}}}}"#
    )
}
fn user(text: &str) -> String {
    format!(
        r#"{{"type":"user","sessionId":"s","timestamp":"2026-10-20T12:00:00.000Z","message":{{"content":"{text}"}}}}"#
    )
}
/// One scan of a Claude Code folder holding `log`: its diagnostics and the source's state.
fn scan(log: &str) -> (Vec<String>, SourceState) {
    let folder = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(folder.path()).unwrap().join("projects");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("session.jsonl"), log).unwrap();
    let store = Arc::new(Mutex::new(UsageStore::open(":memory:").unwrap()));
    let service = IngestionService::new(store.clone(), IngestionOptions::default()).unwrap();
    let paths = vec![root.to_string_lossy().into_owned()];
    service
        .configure_source(ToolId::Claude, &SourceConfiguration { enabled: true, paths })
        .unwrap();
    let diagnostics = service.scan().unwrap().diagnostics;
    let sources = store.lock().unwrap().source_statuses().unwrap();
    let claude = sources.into_iter().find(|source| source.id == ToolId::Claude).unwrap();
    (diagnostics, claude.state)
}

#[test]
fn a_long_line_without_usage_leaves_the_source_current() {
    let long = "x".repeat(1_200_000);
    let log = format!(
        "{}\n{}\n{}\n",
        assistant("a", "short"),
        user(&long),
        assistant("b", "short")
    );
    assert_eq!(scan(&log), (vec![], SourceState::Current));
}

#[test]
fn a_long_line_with_usage_is_reported_even_past_the_limit() {
    // The usage key comes after the first megabyte.
    let long = "x".repeat(1_200_000);
    let log = format!("{}\n{}\n", assistant("a", "short"), assistant("b", &long));
    assert_eq!(scan(&log), (vec!["record_too_large".to_owned()], SourceState::Stale));
}
