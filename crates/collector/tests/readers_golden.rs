//! The pure readers over the golden fixtures: an oracle that reads the document and database cases through the
//! adapters, and a privacy check over every input.
mod support;

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use support::{Case, SqlDatabases, Step, cases, files_below, fixture_text, target};
use tokentracky_collector::readers::{Sidecars, SourceKind, adapter, parse_document, parse_usage_file, source_kind};
use tokentracky_core::{ParseResult, TOOL_IDS, ToolId};

const LINE_TOOLS: [ToolId; 3] = [ToolId::Claude, ToolId::Codex, ToolId::Gemini];

/// A file of a step that a tool reads: where it sits in the fixture, its path below `root/` once materialised
/// (`X.db.sql` is the database `X.db`), and how the tool reads it.
struct Input {
    file: String,
    path: String,
    kind: SourceKind,
}
/// The files of `step` that `tool` classifies, inside `scope` (granted paths relative to `root/`; `.` is all of it).
fn inputs(step: &Step, tool: ToolId, scope: &[String]) -> Vec<Input> {
    let granted = |path: &str| {
        scope
            .iter()
            .any(|root| root == "." || path == root || path.starts_with(&format!("{root}/")))
    };
    files_below(&step.root())
        .into_iter()
        .filter_map(|file| {
            let path = target(&file).to_owned();
            let kind = source_kind(tool, &Path::new("/allowed").join(&path)).filter(|_| granted(&path))?;
            Some(Input { file, path, kind })
        })
        .collect()
}
fn text(step: &Step, input: &Input) -> String {
    String::from_utf8_lossy(&fs::read(step.root().join(&input.file)).unwrap()).into_owned()
}
/// Runs the step's `X.db.sql` scripts against databases below `scratch`, whose writer keeps them open.
fn materialise(step: &Step, databases: &mut SqlDatabases, scratch: &Path) {
    for file in files_below(&step.root())
        .into_iter()
        .filter(|file| target(file) != file)
    {
        let database = scratch.join(target(&file));
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        databases.apply(&step.root().join(&file), &database);
    }
}
/// Reads one input as a scan would: a log line by line, a document with the sidecars beside it, a database where
/// `materialise` put it. `Err` is a database that cannot be read.
fn read(tool: ToolId, step: &Step, input: &Input, scratch: &Path) -> rusqlite::Result<ParseResult> {
    let real = step.root().join(&input.file);
    Ok(match input.kind {
        SourceKind::Jsonl => parse_usage_file(tool, &text(step, input), &real),
        SourceKind::Json => {
            let roles = adapter(tool)
                .and_then(|adapter| adapter.sidecars)
                .map_or_else(Vec::new, |sidecars| sidecars(&real));
            let sidecars: Sidecars = roles
                .into_iter()
                .map(|(role, path)| {
                    (
                        role,
                        fs::read(path)
                            .ok()
                            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
                    )
                })
                .collect();
            parse_document(tool, &real, &text(step, input), &sidecars)
        }
        SourceKind::Sqlite => (adapter(tool).unwrap().database.unwrap())(&scratch.join(&input.path), &[])?,
        // The lines that decompress; ingestion reads them as a stream with the same parser.
        SourceKind::CompressedJsonl => {
            let mut lines = Vec::new();
            let archive = fs::read(&real).unwrap();
            if let Ok(mut decoder) = ruzstd::decoding::StreamingDecoder::new(&archive[..]) {
                let _ = std::io::Read::read_to_end(&mut decoder, &mut lines);
            }
            parse_usage_file(tool, &String::from_utf8_lossy(&lines), &real)
        }
    })
}
/// Results merged as the TypeScript tests merge them: events by id (a later copy replaces an earlier one) and each code
/// once; as JSON, events in id order and codes sorted.
fn merged(results: impl IntoIterator<Item = ParseResult>) -> (Value, Value) {
    let (mut events, mut codes) = (BTreeMap::new(), BTreeSet::new());
    for result in results {
        events.extend(result.events.into_iter().map(|event| (event.event_id.clone(), event)));
        codes.extend(result.diagnostics);
    }
    (
        serde_json::to_value(events.into_values().collect::<Vec<_>>()).unwrap(),
        json!(codes),
    )
}
fn assert_golden(case: &Case, results: Vec<ParseResult>) {
    let (events, diagnostics) = merged(results);
    assert_eq!(events, case.steps[0].expected("events.json"), "{} events", case.name);
    assert_eq!(
        diagnostics,
        case.steps[0].expected("diagnostics.json"),
        "{} diagnostics",
        case.name
    );
}
fn complete(step: &Step, inputs: &[Input]) -> bool {
    inputs.iter().all(|input| {
        input.kind != SourceKind::Jsonl || text(step, input).is_empty() || text(step, input).ends_with('\n')
    })
}

// The line parser and the ingestion service are separate code paths; on complete logs they must agree, so the golden
// events of every single-step, unpriced Claude Code, Codex and Gemini CLI case whose classified files are all
// newline-terminated logs are also the result of parsing its files directly.
#[test]
fn line_parser_gives_the_golden_events_and_diagnostics() {
    let mut covered = BTreeSet::new();
    for case in cases() {
        let Some(tool) = case.tool_id().filter(|tool| LINE_TOOLS.contains(tool)) else {
            continue;
        };
        let step = &case.steps[0];
        let inputs = inputs(step, tool, &[".".into()]);
        if case.steps.len() != 1
            || case.config.price.is_some()
            || inputs.iter().any(|input| input.kind != SourceKind::Jsonl)
        {
            continue;
        }
        if !complete(step, &inputs) {
            continue;
        }
        let results = inputs
            .iter()
            .map(|input| parse_usage_file(tool, &text(step, input), &Path::new("/allowed").join(&input.path)));
        assert_golden(&case, results.collect());
        covered.insert(case.tool.clone());
    }
    // A run limited by `TOKENTRACKY_CASES` covers only its cases.
    if std::env::var_os("TOKENTRACKY_CASES").is_none() {
        assert_eq!(covered, BTreeSet::from(["claude", "codex", "gemini"].map(String::from)));
    }
}

// The other adapters read whole documents and databases. Their golden events are also the result of reading each
// classified file of a case once, for every single-step, unpriced Cline, Roo Code, Kilo Code and OpenCode case, and
// every Gemini CLI one with a legacy session document. Excluded, because a scan changes the event set there:
// multi-step cases (later steps are the store's ledger, rewrite, rename and superseding rules; the OpenCode live
// database is followed step by step in `readers_opencode.rs`), cases with ops, a Kilo Code database next to the tasks
// it supersedes, logs with a partial final line, and `multi-tool` cases (locks and scan order across tools).
#[test]
fn document_and_database_readers_give_the_golden_events_and_diagnostics() {
    let mut covered: BTreeMap<ToolId, BTreeSet<&str>> = BTreeMap::new();
    for case in cases() {
        let Some(tool) = case
            .tool_id()
            .filter(|tool| !matches!(tool, ToolId::Claude | ToolId::Codex))
        else {
            continue;
        };
        let step = &case.steps[0];
        let inputs = inputs(step, tool, case.sources().get(&tool).map_or(&[][..], Vec::as_slice));
        let has = |kind| inputs.iter().any(|input| input.kind == kind);
        let superseded = adapter(tool).is_some_and(|adapter| adapter.database_supersedes_documents)
            && has(SourceKind::Sqlite)
            && has(SourceKind::Json);
        if case.steps.len() != 1
            || case.config.price.is_some()
            || !step.config.ops.is_empty()
            || superseded
            || (tool == ToolId::Gemini && !has(SourceKind::Json))
            || !complete(step, &inputs)
        {
            continue;
        }
        let scratch = tempfile::tempdir().unwrap();
        let mut databases = SqlDatabases::default();
        materialise(step, &mut databases, scratch.path());
        let results = inputs.iter().map(|input| {
            read(tool, step, input, scratch.path()).unwrap_or_else(|error| panic!("{}: {error}", case.name))
        });
        assert_golden(&case, results.collect());
        let kinds = covered.entry(tool).or_default();
        kinds.extend(inputs.iter().map(|input| {
            if input.kind == SourceKind::Sqlite {
                "database"
            } else {
                "document"
            }
        }));
    }
    let expected = [
        (ToolId::Gemini, &["document"][..]),
        (ToolId::Cline, &["document"]),
        (ToolId::Roo, &["document"]),
        (ToolId::Kilo, &["database", "document"]),
        (ToolId::OpenCode, &["database", "document"]),
        (ToolId::Mimo, &["database"]),
        (ToolId::DuMate, &["database"]),
        (ToolId::Pi, &["document"]),
        (ToolId::Omo, &["document"]),
        (ToolId::ZCode, &["database"]),
        (ToolId::EveryCode, &["document"]),
        (ToolId::Kimi, &["document"]),
        (ToolId::CommandCode, &["document"]),
        (ToolId::CodeBuddy, &["document"]),
        (ToolId::DeepSeek, &["document"]),
        (ToolId::LmStudio, &["document"]),
        (ToolId::Copilot, &["document"]),
        (ToolId::Unsloth, &["database"]),
        (ToolId::OpenClaw, &["database", "document"]),
    ];
    if std::env::var_os("TOKENTRACKY_CASES").is_none() {
        assert_eq!(
            covered,
            expected
                .into_iter()
                .map(|(tool, kinds)| (tool, kinds.iter().copied().collect()))
                .collect()
        );
    }
}

#[test]
fn reads_a_valid_final_line_that_has_no_newline_which_ingestion_leaves_pending() {
    let log = fixture_text("claude/cache-categories-disjoint/root/session.jsonl");
    let result = parse_usage_file(ToolId::Claude, log.trim_end(), Path::new("/allowed/session.jsonl"));
    assert_eq!(
        result.events.iter().map(|event| event.tool).collect::<Vec<_>>(),
        [ToolId::Claude]
    );
    assert!(result.diagnostics.is_empty());
}

#[test]
fn continues_after_malformed_and_oversized_records_and_never_retains_raw_data() {
    // The ingestion service reads these files with the same outcome; its golden is claude/malformed-and-invalid-records
    // and claude/oversized-record.
    let file = Path::new("file.jsonl");
    let malformed = parse_usage_file(
        ToolId::Claude,
        &fixture_text("claude/malformed-and-invalid-records/steps/01-scan/root/session.jsonl"),
        file,
    );
    assert_eq!(malformed.events.len(), 1);
    assert_eq!(malformed.diagnostics, ["malformed_json", "invalid_record"]);
    let oversized = parse_usage_file(
        ToolId::Claude,
        &fixture_text("claude/oversized-record/steps/01-scan/root/large.jsonl"),
        file,
    );
    assert_eq!(oversized.events.len(), 2);
    // Its long line holds no usage key, so skipping it loses nothing and is not reported.
    assert_eq!(oversized.diagnostics, Vec::<String>::new());
    assert!(
        !serde_json::to_string(&[malformed, oversized])
            .unwrap()
            .contains("PRIVATE_")
    );
}

#[test]
fn reports_other_tools_as_unsupported_by_the_line_parser() {
    let log = fixture_text("claude/cache-categories-disjoint/root/session.jsonl");
    for tool in [
        ToolId::Cursor,
        ToolId::Cline,
        ToolId::Roo,
        ToolId::Kilo,
        ToolId::OpenCode,
    ] {
        let unsupported = ParseResult {
            events: vec![],
            diagnostics: vec!["unsupported_source".into()],
            withdrawn: None,
        };
        assert_eq!(
            parse_usage_file(tool, &log, Path::new("file.jsonl")),
            unsupported,
            "{tool:?}"
        );
    }
}

// Prompt, response and path text in the fixtures is marked `PRIVATE_`. Every reader is run over every input of every
// step of every case (whichever tool the case belongs to), and nothing it returns may hold that marker, a case's
// `forbidden` text or a path, and diagnostics must be bare codes.
#[test]
fn no_reader_output_holds_private_text_forbidden_text_or_paths() {
    let mut outputs = 0;
    for case in cases() {
        let scratch = tempfile::tempdir().unwrap();
        let mut databases = SqlDatabases::default();
        for step in &case.steps {
            let root = step.root();
            materialise(step, &mut databases, scratch.path());
            for &tool in TOOL_IDS.iter().filter(|tool| adapter(**tool).is_some()) {
                for input in inputs(step, tool, &[".".into()]) {
                    // A database whose writer holds a lock cannot be read; ingestion reports `file_read_failed`.
                    let Ok(result) = read(tool, step, &input, scratch.path()) else {
                        continue;
                    };
                    let output = serde_json::to_string(&result).unwrap();
                    let paths = [scratch.path().to_str().unwrap(), root.to_str().unwrap()];
                    for marker in ["PRIVATE_"]
                        .iter()
                        .chain(&paths)
                        .copied()
                        .chain(case.config.forbidden.iter().map(String::as_str))
                    {
                        assert!(
                            !output.contains(marker),
                            "{} {}: {tool:?} returned {marker}",
                            case.name,
                            input.file
                        );
                    }
                    for code in &result.diagnostics {
                        assert!(
                            !code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
                            "{code}"
                        );
                    }
                    outputs += 1;
                }
            }
        }
    }
    assert!(
        outputs > 100 || std::env::var_os("TOKENTRACKY_CASES").is_some(),
        "{outputs}"
    );
}
