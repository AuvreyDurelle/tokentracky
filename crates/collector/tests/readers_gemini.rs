//! Gemini CLI checks that need the pure readers rather than a scan;
//! the accounting itself is in `fixtures/gemini/*`.
mod support;

use serde_json::Value;
use std::path::Path;
use support::{fixture_text, read_json};
use tokentracky_collector::readers::{PENDING, Sidecars, parse_document, parse_usage_file};
use tokentracky_core::ToolId;

const CHAT: &str = "project-slug/chats/session-2026-10-23T09-00-abcd1234";

fn golden(case: &str) -> Value {
    read_json(&support::fixtures().join(case).join("expected/events.json")).unwrap()
}
fn ids(events: &Value) -> Vec<&str> {
    events
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["eventId"].as_str().unwrap())
        .collect()
}

#[test]
fn reads_a_legacy_session_json_with_the_identity_of_its_jsonl_form_and_no_project() {
    let legacy = fixture_text(format!("gemini/legacy-session-json/root/{CHAT}.json"));
    let result = parse_document(
        ToolId::Gemini,
        Path::new(&format!("/tmp/{CHAT}.json")),
        &legacy,
        &Sidecars::new(),
    );
    assert!(result.diagnostics.is_empty());
    let read: Vec<&str> = result.events.iter().map(|event| event.event_id.as_str()).collect();
    assert_eq!(read, ids(&golden("gemini/research-fixture-rewind")));
    assert_eq!(read, ids(&golden("gemini/legacy-session-json")));
    assert!(result.events.iter().all(|event| event.project.is_none()));
    let log = fixture_text(format!("gemini/research-fixture-rewind/root/{CHAT}.jsonl"));
    assert_eq!(
        result.events,
        parse_usage_file(ToolId::Gemini, &log, Path::new(&format!("{CHAT}.jsonl"))).events
    );
}

#[test]
fn waits_for_a_conversation_being_written_and_ignores_documents_outside_a_chats_folder() {
    let legacy = fixture_text(format!("gemini/legacy-session-json/root/{CHAT}.json"));
    let partial = parse_document(
        ToolId::Gemini,
        Path::new("/tmp/project-slug/chats/session-x.json"),
        &legacy[..40],
        &Sidecars::new(),
    );
    assert_eq!(partial.diagnostics, [PENDING]);
    let outside = parse_document(
        ToolId::Gemini,
        Path::new("/tmp/project-slug/logs.json"),
        &legacy,
        &Sidecars::new(),
    );
    assert_eq!(outside.diagnostics, ["unsupported_source"]);
}

#[test]
fn keeps_no_folder_name_or_project_hash_in_an_event() {
    let log = fixture_text(format!("gemini/research-fixture-rewind/root/{CHAT}.jsonl"));
    let read = parse_usage_file(ToolId::Gemini, &log, Path::new(&format!("/allowed/{CHAT}.jsonl")));
    for stored in [
        golden("gemini/research-fixture-rewind").to_string(),
        serde_json::to_string(&read).unwrap(),
    ] {
        for marker in ["project-slug".to_owned(), "0".repeat(64)] {
            assert!(!stored.contains(&marker), "{marker}");
        }
    }
}
