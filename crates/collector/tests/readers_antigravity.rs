//! Antigravity: TokenTracker's accounting cases (MIT, `xiufengsun/TokenTracker@3f72861`, `test/rollout-parser.test.js`)
//! against the pure reader, over a real install layout; the scan itself is in `fixtures/antigravity/*`.
use rusqlite::Connection;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use tokentracky_collector::readers::{PENDING, Sidecars, parse_document};
use tokentracky_core::{ParseResult, TokenCounts, ToolId, UsageEvent};

/// An install with one conversation, `conv-123`.
struct Install {
    _dir: tempfile::TempDir,
    root: PathBuf,
}
impl Install {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("antigravity");
        fs::create_dir_all(root.join("brain/conv-123/.system_generated/logs")).unwrap();
        Self { _dir: dir, root }
    }
    fn transcript(&self) -> PathBuf {
        self.root.join("brain/conv-123/.system_generated/logs/transcript.jsonl")
    }
    fn database(&self) -> PathBuf {
        self.root.join("conversations/conv-123.db")
    }
    fn settings(self, settings: &Value) -> Self {
        fs::write(self.root.join("settings.json"), settings.to_string()).unwrap();
        self
    }
    fn generations(self, rows: &[Vec<u8>]) -> Self {
        fs::create_dir_all(self.root.join("conversations")).unwrap();
        let db = Connection::open(self.database()).unwrap();
        db.execute("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)", [])
            .unwrap();
        for (idx, row) in rows.iter().enumerate() {
            db.execute("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", (idx as i64, row))
                .unwrap();
        }
        self
    }
    /// Reads `lines` as the transcript, with the sidecars a scan would pass.
    fn read(&self, lines: &[Value]) -> ParseResult {
        let content = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        self.read_text(&content)
    }
    fn read_text(&self, content: &str) -> ParseResult {
        fs::write(self.transcript(), content).unwrap();
        let mut sidecars = Sidecars::new();
        sidecars.insert("settings", fs::read_to_string(self.root.join("settings.json")).ok());
        sidecars.insert("database", self.database().exists().then(String::new));
        parse_document(ToolId::Antigravity, &self.transcript(), content, &sidecars)
    }
}

fn line(kind: &str, step: Option<u64>, at: &str, content: &str) -> Value {
    let mut line = json!({"type": kind, "created_at": at, "content": content});
    if let Some(step) = step {
        line["step_index"] = json!(step);
    }
    line
}
fn planner(step: Option<u64>, at: &str, content: &str, thinking: &str) -> Value {
    let mut line = line("PLANNER_RESPONSE", step, at, content);
    line["thinking"] = json!(thinking);
    line
}
/// `antigravityPlannerLines`: a prompt and a reply per turn, steps 0 and 1, 2 and 3, ...
fn turns(turns: &[(&str, &str, &str)]) -> Vec<Value> {
    let mut lines = Vec::new();
    for (at, (prompt, reply, thinking)) in turns.iter().enumerate() {
        let step = 2 * at as u64;
        lines.push(line(
            "USER_INPUT",
            Some(step),
            &format!("2026-04-05T14:0{step}:00.000Z"),
            prompt,
        ));
        lines.push(planner(
            Some(step + 1),
            &format!("2026-04-05T14:0{}:00.000Z", step + 1),
            reply,
            thinking,
        ));
    }
    lines
}
/// Four ASCII characters to a token.
fn ascii(text: &str) -> u64 {
    (text.len() as u64).div_ceil(4)
}
fn sum(events: &[UsageEvent]) -> TokenCounts {
    let mut total = TokenCounts::default();
    for event in events {
        total.input += event.tokens.input;
        total.output += event.tokens.output;
        total.cache_read += event.tokens.cache_read;
        total.reasoning = Some(total.reasoning.unwrap_or(0) + event.tokens.reasoning.unwrap_or(0));
    }
    total
}
fn models(events: &[UsageEvent]) -> Vec<&str> {
    events.iter().map(|event| event.model.as_str()).collect()
}

fn encode(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    while value >= 0x80 {
        bytes.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    bytes.push(value as u8);
    bytes
}
fn vi(number: u64, value: u64) -> Vec<u8> {
    [encode(number << 3), encode(value)].concat()
}
fn ld(number: u64, bytes: &[u8]) -> Vec<u8> {
    [encode((number << 3) | 2), encode(bytes.len() as u64), bytes.to_vec()].concat()
}
/// `buildAntigravityTestProto`: usage is `[system, prompt, output, cached, text, reasoning]`, `None` to leave one out.
fn generation(model: &str, step: u64, context: Option<u64>, usage: Option<[Option<u64>; 6]>) -> Vec<u8> {
    let mut parts = vec![ld(19, model.as_bytes())];
    if let Some(context) = context {
        parts.push(ld(9, &ld(10, &vi(1, context))));
    }
    if let Some(usage) = usage {
        let four: Vec<u8> = [1, 2, 3, 5, 9, 10]
            .into_iter()
            .zip(usage)
            .filter_map(|(number, value)| value.map(|value| vi(number, value)))
            .flatten()
            .collect();
        parts.push(ld(4, &four));
    }
    parts.push(ld(
        20,
        &[ld(1, b"last_step_index"), ld(2, step.to_string().as_bytes())].concat(),
    ));
    ld(1, &parts.concat())
}

#[test]
fn bills_only_the_context_added_since_the_previous_turn() {
    let selection = "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n";
    let prompt_a = format!("{selection}{}", "u".repeat(40));
    let (tool_result, answer_a, prompt_b) = ("r".repeat(80), "a".repeat(20), "b".repeat(40));
    let result = Install::new().read(&[
        line("USER_INPUT", None, "2026-04-05T14:00:00.000Z", &prompt_a),
        line("TOOL_RESULT", None, "2026-04-05T14:01:00.000Z", &tool_result),
        planner(None, "2026-04-05T14:02:00.000Z", &answer_a, &"t".repeat(12)),
        line("USER_INPUT", None, "2026-04-05T14:03:00.000Z", &prompt_b),
        planner(None, "2026-04-05T14:04:00.000Z", &"c".repeat(20), &"d".repeat(12)),
    ]);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(models(&result.events), ["gemini-3.5-flash", "gemini-3.5-flash"]);
    let first = ascii(&prompt_a) + ascii(&tool_result);
    // The second turn reads the first reply and the new prompt, not the whole history again.
    let second = ascii(&answer_a) + ascii(&prompt_b);
    let total = sum(&result.events);
    assert_eq!(total.input, first + second);
    // Replies of 5 tokens and reasoning of 3, each turn; reasoning is part of output.
    assert_eq!((total.output, total.reasoning), (16, Some(6)));
    assert_eq!(total.cache_read, 0);
}

#[test]
fn estimates_cjk_characters_as_a_token_each() {
    let prompt = "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n检查本项目对 antigravity 的用量";
    let result = Install::new().read(&[
        line("USER_INPUT", None, "2026-04-05T14:00:00.000Z", prompt),
        line("PLANNER_RESPONSE", None, "2026-04-05T14:02:00.000Z", "完成检查"),
    ]);
    // Nine CJK characters, and 78 others in four-character tokens.
    let total = sum(&result.events);
    assert_eq!((total.input, total.output), (9 + 20, 4));
}

#[test]
fn keeps_usage_of_an_unknown_model_visible() {
    let result = Install::new().read(&[
        line(
            "USER_INPUT",
            None,
            "2026-04-05T14:00:00.000Z",
            "regular prompt without model settings",
        ),
        line("PLANNER_RESPONSE", None, "2026-04-05T14:02:00.000Z", "answer"),
    ]);
    assert_eq!(models(&result.events), ["antigravity-unknown"]);
    assert!(sum(&result.events).input > 0);
}

#[test]
fn takes_the_model_from_settings_unless_the_transcript_changes_it() {
    let install = Install::new().settings(&json!({"model": "Claude Sonnet 4"}));
    let plain = install.read(&[
        line("USER_INPUT", None, "2026-04-05T14:00:00.000Z", "a regular prompt"),
        line("PLANNER_RESPONSE", None, "2026-04-05T14:02:00.000Z", "the answer"),
    ]);
    assert_eq!(models(&plain.events), ["claude-sonnet-4"]);
    for kind in ["USER_INPUT", "USER_SETTINGS_CHANGE"] {
        let changed = install.read(&[
            line(
                kind,
                None,
                "2026-04-05T14:00:00.000Z",
                "changed setting `Model Selection` from Auto to Claude Haiku 4.6 (Thinking).",
            ),
            line("PLANNER_RESPONSE", None, "2026-04-05T14:02:00.000Z", "answer"),
        ]);
        assert_eq!(models(&changed.events), ["claude-haiku-4.6"], "{kind}");
    }
}

#[test]
fn records_cached_input_and_reasoning_from_the_database() {
    let install = Install::new().generations(&[
        generation(
            "gemini-3.8-flash",
            0,
            None,
            Some([None, Some(18_239), Some(1366), Some(0), Some(1286), Some(80)]),
        ),
        generation(
            "gemini-3.8-flash",
            2,
            None,
            Some([None, Some(4583), Some(151), Some(16_319), Some(82), Some(69)]),
        ),
    ]);
    let result = install.read(&turns(&[("hello", "hi", "think1"), ("next prompt", "done", "think2")]));
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(models(&result.events), ["gemini-3.8-flash", "gemini-3.8-flash"]);
    let total = sum(&result.events);
    assert_eq!(total.input, 18_239 + 4583);
    assert_eq!(total.cache_read, 16_319);
    assert_eq!(total.output, 1286 + 80 + 82 + 69);
    assert_eq!(total.reasoning, Some(80 + 69));
}

#[test]
fn takes_output_less_reasoning_when_text_output_is_absent_never_below_zero() {
    let install = Install::new().generations(&[
        generation(
            "gemini-3.8-flash",
            0,
            None,
            Some([None, Some(1000), Some(300), Some(2000), None, Some(100)]),
        ),
        generation(
            "gemini-3.8-flash",
            2,
            None,
            Some([None, Some(500), Some(50), Some(2500), None, Some(80)]),
        ),
    ]);
    let result = install.read(&turns(&[
        ("turn 1", "resp 1", "think 1"),
        ("turn 2", "resp 2", "think 2"),
    ]));
    let total = sum(&result.events);
    // Replies of 300 - 100 and max(0, 50 - 80), with their reasoning.
    assert_eq!((total.output, total.reasoning), (200 + 100 + 80, Some(180)));
    assert_eq!((total.input, total.cache_read), (1500, 4500));
}

#[test]
fn bills_the_growth_of_the_recorded_context_without_inventing_cache_hits() {
    let install = Install::new().generations(&[
        generation("gemini-3.8-flash", 0, Some(25_000), None),
        generation("gemini-3.8-flash", 2, Some(30_000), None),
    ]);
    let result = install.read(&turns(&[("hello", "hi", "think1"), ("next prompt", "done", "think2")]));
    let total = sum(&result.events);
    assert_eq!((total.input, total.cache_read), (30_000, 0));
}

#[test]
fn measures_an_estimated_turn_against_the_recorded_context_of_the_one_before() {
    let install = Install::new().generations(&[
        generation(
            "gemini-3.8-flash",
            0,
            Some(25_000),
            Some([None, Some(1000), Some(200), Some(2000), Some(150), Some(50)]),
        ),
        generation("gemini-3.8-flash", 2, Some(26_000), None),
    ]);
    let result = install.read(&turns(&[
        ("turn 1", "reply 1", "think 1"),
        ("turn 2", "reply 2", "think 2"),
    ]));
    // 1000 recorded, then 26000 - 25000: not 26000 - 3000.
    assert_eq!(sum(&result.events).input, 2000);
}

#[test]
fn bills_the_whole_context_after_a_model_switch() {
    let install = Install::new().generations(&[
        generation("gemini-3.8-flash", 0, Some(25_000), None),
        generation("claude-sonnet-4-6", 2, Some(40_000), None),
    ]);
    let result = install.read(&turns(&[("hello", "hi", "think1"), ("switch", "ok", "think2")]));
    let by_model: Vec<(&str, u64, u64)> = result
        .events
        .iter()
        .map(|event| (event.model.as_str(), event.tokens.input, event.tokens.cache_read))
        .collect();
    assert_eq!(
        by_model,
        [("gemini-3.8-flash", 25_000, 0), ("claude-sonnet-4-6", 40_000, 0)]
    );
}

#[test]
fn waits_while_antigravity_holds_its_database_and_estimates_from_one_it_cannot_read() {
    let install = Install::new().generations(&[generation("gemini-3.8-flash", 0, Some(25_000), None)]);
    let lines = turns(&[("hello", "hi", "think1")]);
    let writer = Connection::open(install.database()).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert_eq!(install.read(&lines).diagnostics, [PENDING]);
    writer.execute_batch("COMMIT").unwrap();
    assert_eq!(sum(&install.read(&lines).events).input, 25_000);

    writer.execute_batch("DROP TABLE gen_metadata").unwrap();
    let unreadable = install.read(&lines);
    assert_eq!(unreadable.diagnostics, ["database_unreadable"]);
    assert_eq!(sum(&unreadable.events).input, ascii("hello"));
}

#[test]
fn stops_at_a_malformed_line_and_waits_for_a_last_line_being_written() {
    let install = Install::new();
    let lines = turns(&[("hello", "hi", "think1")]);
    let complete: String = lines.iter().map(|line| format!("{line}\n")).collect();
    let writing = install.read_text(&format!("{complete}{{\"type\": \"PLANNER_RES"));
    assert!(writing.diagnostics.is_empty(), "{:?}", writing.diagnostics);
    assert_eq!(writing.events.len(), 1);
    let malformed = install.read_text(&format!("{{not json\n{complete}"));
    assert_eq!(malformed.diagnostics, ["malformed_json"]);
    assert!(malformed.events.is_empty());
}

#[test]
fn keys_a_turn_by_conversation_and_step_so_copies_in_two_installs_count_once() {
    let lines = turns(&[("hello", "hi", "think1"), ("next prompt", "done", "think2")]);
    let app = Install::new().read(&lines);
    let ide = Install::new().read(&lines);
    assert_eq!(app.events.len(), 2);
    assert_eq!(app.events, ide.events);
    assert!(
        app.events
            .iter()
            .all(|event| event.session_id == "conv-123" && event.project.is_none())
    );
}

#[test]
fn reads_only_transcripts_in_an_install_layout() {
    let outside = parse_document(
        ToolId::Antigravity,
        Path::new("/tmp/transcript.jsonl"),
        "{}",
        &Sidecars::new(),
    );
    assert_eq!(outside.diagnostics, ["unsupported_source"]);
}

#[test]
fn reads_the_transcript_again_rather_than_estimate_over_a_database_it_could_not_open() {
    let install = Install::new();
    // Present, but SQLite cannot open it this scan.
    fs::create_dir_all(install.database()).unwrap();
    assert_eq!(
        install.read(&turns(&[("hello", "hi", "think1")])).diagnostics,
        [PENDING]
    );
}

#[test]
fn keeps_the_database_closed_when_the_service_rejected_its_wal() {
    let install = Install::new().generations(&[generation("gemini-3.8-flash", 0, Some(25_000), None)]);
    let writer = Connection::open(install.database()).unwrap();
    writer
        .execute_batch("PRAGMA journal_mode=WAL; UPDATE gen_metadata SET idx = idx")
        .unwrap();
    let mut wal = install.database().into_os_string();
    wal.push("-wal");
    assert!(Path::new(&wal).exists());
    let lines = turns(&[("hello", "hi", "think1")]);
    let content = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    fs::write(install.transcript(), &content).unwrap();
    let read = |wal: Option<String>| {
        let mut sidecars = Sidecars::new();
        sidecars.insert("database", Some(String::new()));
        sidecars.insert("wal", wal);
        parse_document(ToolId::Antigravity, &install.transcript(), &content, &sidecars)
    };
    assert_eq!(sum(&read(Some(String::new())).events).input, 25_000);
    let rejected = read(None);
    assert_eq!(rejected.diagnostics, ["database_unreadable"]);
    assert_eq!(sum(&rejected.events).input, ascii("hello"));
}
