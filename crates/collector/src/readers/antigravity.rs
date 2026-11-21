//! Antigravity, Google's agent IDE and its `agy` CLI: each conversation's
//! `brain/<id>/.system_generated/logs/transcript.jsonl` below `~/.gemini/antigravity` (or `antigravity-ide`,
//! `antigravity-insiders`, `antigravity-cli`) or a T3 Code profile's `antigravity-acp`. Ported from TokenTracker
//! (MIT, `xiufengsun/TokenTracker@3f72861`, `src/lib/rollout.js`), whose accounting it keeps:
//!
//! - A planner turn (`PLANNER_RESPONSE`) is one event, keyed by the conversation and its `step_index`, so the same
//!   conversation found in two installs counts once.
//! - Its usage comes from `conversations/<id>.db` beside `brain/` when Antigravity recorded it there: the table
//!   `gen_metadata` holds one protobuf per generation, matched to the turn whose `step_index` is the generation's
//!   `last_step_index + 1`. Field 1 is the generation: `.19` its model, `.9.10.1` its context size, `.20` key/value
//!   pairs (`last_step_index`), and `.4` its usage: `.1` system prefix and `.2` prompt (input), `.5` cached prompt, `.3`
//!   all output, `.9` text output and `.10` reasoning. Google publishes no schema; TokenTracker read these from the bytes.
//! - Otherwise the turn's usage is estimated from the transcript's text, one token per CJK character and per four
//!   other characters: input is the context added since the previous turn (all of it after a model change), output is
//!   the reply, its tool calls and its reasoning. The text is counted and dropped.
//! - The model is the generation's own, else the one named by the last "changed setting `Model Selection`" line, else
//!   `model` in `settings.json` beside `brain/`, normalised to `gemini-…`, `claude-…` or `gpt-…` (otherwise
//!   `antigravity-<name>`), or `antigravity-unknown`.
//!
//! Antigravity 2.x desktop releases keep conversations in encrypted `conversations/<id>.pb` files, which are never
//! opened; only the transcripts they write are counted.
use super::adapters::{Adapter, SidecarPaths, Sidecars, SourceKind, sidecar};
use super::parser::{
    PENDING, date, file_name, is_metadata_text, keep, note, only, parse_json, safe_integer, usage_event,
};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tokentracky_core::{MAX_SAFE_INTEGER, ParseResult, SourceCapabilities, TokenCounts, ToolId, is_js_space};

static ANTIGRAVITY: Adapter = Adapter {
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: false,
        costs: false,
        quotas: false,
    },
    kind: |path| conversation(path).is_some().then_some(SourceKind::Json),
    ledger: true,
    document: None,
    sidecars: Some(|path| {
        conversation(path).map_or_else(Vec::new, |(root, _)| vec![("settings", root.join("settings.json"))])
    }),
    database: None,
    incremental: None,
    line: None,
    text: Some(read_transcript),
    database_supersedes_documents: false,
};

/// The tool's adapter.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&ANTIGRAVITY)
}

/// `<root>/brain/<id>/.system_generated/logs/transcript.jsonl`: the install's root and the conversation id.
fn conversation(path: &Path) -> Option<(&Path, String)> {
    let logs = path.parent()?;
    let generated = logs.parent()?;
    let id = generated.parent()?;
    let brain = id.parent()?;
    let layout = file_name(path) == "transcript.jsonl"
        && file_name(logs) == "logs"
        && file_name(generated) == ".system_generated"
        && file_name(brain) == "brain";
    layout.then(|| brain.parent().map(|root| (root, file_name(id).into_owned())))?
}

fn database(root: &Path, id: &str) -> PathBuf {
    root.join("conversations").join(format!("{id}.db"))
}

/// The conversation's database and its WAL, which the reader opens itself: a change to either reads the transcript
/// again.
pub(crate) fn database_files(path: &Path) -> SidecarPaths {
    conversation(path).map_or_else(Vec::new, |(root, id)| {
        let database = database(root, &id);
        let mut wal = database.clone().into_os_string();
        wal.push("-wal");
        vec![("database", database), ("wal", wal.into())]
    })
}

fn read_transcript(path: &Path, content: &str, sidecars: &Sidecars) -> ParseResult {
    let Some((root, id)) = conversation(path) else {
        return only("unsupported_source");
    };
    if !is_metadata_text(&id, 512) {
        return only("missing_stable_identity");
    }
    let mut diagnostics = Vec::new();
    // The service hands the reader the database's role only when it is present inside the authorised folder.
    let generations = if sidecar(sidecars, "database").is_some() {
        match read_database(&database(root, &id)) {
            Ok(generations) => generations,
            // Antigravity is writing it: read the transcript again next scan rather than estimating its turns.
            Err(error) if busy(&error) => return only(PENDING),
            Err(_) => {
                note(&mut diagnostics, "database_unreadable");
                BTreeMap::new()
            }
        }
    } else {
        BTreeMap::new()
    };
    let settings = sidecar(sidecars, "settings").and_then(parse_json);
    let default_model = settings
        .as_ref()
        .and_then(|settings| settings.get("model")?.as_str())
        .and_then(normalize_model);
    let mut result = walk(&id, content, &generations, default_model);
    for code in diagnostics {
        note(&mut result.diagnostics, &code);
    }
    result
}

fn busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

/// The generations with a step, by the transcript step they answer (`last_step_index + 1`); a later row replaces an
/// earlier one for the same step.
fn read_database(path: &Path) -> rusqlite::Result<BTreeMap<u64, Generation>> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let mut statement = db.prepare("SELECT data FROM gen_metadata ORDER BY idx")?;
    let mut rows = statement.query([])?;
    let mut generations = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let ValueRef::Blob(bytes) = row.get_ref(0)? else {
            continue;
        };
        if let Some(generation) = generation(bytes)
            && let Some(step) = generation.last_step_index
            && (generation.usage.is_some() || generation.context > 0)
        {
            generations.insert(step + 1, generation);
        }
    }
    Ok(generations)
}

/// Walks the transcript, keeping the context it has seen so far.
fn walk(
    id: &str,
    content: &str,
    generations: &BTreeMap<u64, Generation>,
    default_model: Option<String>,
) -> ParseResult {
    let (mut events, mut diagnostics) = (Vec::new(), Vec::new());
    let mut current_model = default_model;
    let mut last_planner_model: Option<String> = None;
    // Context seen so far, and its size at the last turn counted: a turn's estimated input is what was added since.
    let (mut context, mut previous) = (0u64, 0u64);
    let lines: Vec<&str> = content
        .split('\n')
        .map(|line| line.trim_matches(is_js_space))
        .filter(|line| !line.is_empty())
        .collect();
    for (at, line) in lines.iter().enumerate() {
        let Some(record) = parse_json(line) else {
            // A last line still being written is read again once it changes; any other stops the walk.
            if at + 1 < lines.len() || content.ends_with('\n') {
                note(&mut diagnostics, "malformed_json");
            }
            break;
        };
        let Some(record) = record.as_object() else {
            continue;
        };
        let kind = record.get("type").and_then(Value::as_str);
        if matches!(kind, Some("USER_INPUT" | "USER_SETTINGS_CHANGE"))
            && let Some(model) = record
                .get("content")
                .and_then(Value::as_str)
                .and_then(model_selection)
                .and_then(normalize_model)
        {
            current_model = Some(model);
        }
        let planner = kind == Some("PLANNER_RESPONSE");
        let tool_calls = record.get("tool_calls");
        let mut added = value_tokens(record.get("content"));
        if planner && truthy(tool_calls) {
            added += value_tokens(tool_calls);
        }
        let step = record.get("step_index").and_then(safe_integer);
        let generation = step
            .and_then(|step| u64::try_from(step).ok())
            .and_then(|step| generations.get(&step))
            .filter(|_| planner);
        let generation_context = generation.map_or(0, |generation| generation.context);
        if let Some(model) = generation
            .and_then(|generation| generation.model.as_deref())
            .and_then(normalize_model)
        {
            current_model = Some(model);
        }
        let Some(occurred_at) = date(record.get("created_at")) else {
            context += added;
            continue;
        };
        let model = current_model
            .clone()
            .unwrap_or_else(|| "antigravity-unknown".to_owned());
        let tokens = if !planner {
            None
        } else if let Some(usage) = generation.and_then(|generation| generation.usage) {
            context = if generation_context > 0 {
                generation_context
            } else {
                usage.uncached + usage.cached
            };
            let reply = if usage.text > 0 {
                usage.text
            } else {
                usage.output.saturating_sub(usage.reasoning)
            };
            Some(counts(usage.uncached, reply, usage.cached, usage.reasoning))
        } else {
            if generation_context > 0 {
                context = generation_context;
            }
            if last_planner_model.as_ref().is_some_and(|last| *last != model) {
                previous = 0;
            }
            let reply = string_tokens(record.get("content")) + value_tokens(tool_calls);
            let reasoning = string_tokens(record.get("thinking"));
            Some(counts(context.saturating_sub(previous), reply, 0, reasoning))
        };
        let Some(tokens) = tokens.filter(|tokens| tokentracky_core::total_tokens(tokens) > 0) else {
            context += added;
            continue;
        };
        let key = match step {
            Some(step) => format!("{id}|{step}"),
            None => format!("{id}|line {at}"),
        };
        keep(
            usage_event(ToolId::Antigravity, &key, id, None, &model, Some(occurred_at), tokens),
            &mut events,
            &mut diagnostics,
        );
        // The turn's own reply and tool calls are history the next turn reads, so they come after the snapshot.
        previous = context;
        last_planner_model = Some(model);
        context += added;
    }
    ParseResult {
        events,
        diagnostics,
        withdrawn: None,
    }
}

/// Disjoint counts with reasoning inside output.
fn counts(input: u64, reply: u64, cached: u64, reasoning: u64) -> TokenCounts {
    TokenCounts {
        input,
        output: reply + reasoning,
        cache_read: cached,
        cache_write: 0,
        reasoning: Some(reasoning),
        cache_write_1h: None,
    }
}

/// One token per CJK character and per four other characters.
fn estimate(text: &str) -> u64 {
    let cjk = text
        .chars()
        .filter(|c| matches!(u32::from(*c), 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0x3040..=0x30ff))
        .count() as u64;
    cjk + (text.chars().count() as u64 - cjk).div_ceil(4)
}
/// A text's estimate, or the estimate of any other value written as JSON.
fn value_tokens(value: Option<&Value>) -> u64 {
    match value {
        None | Some(Value::Null) => 0,
        Some(Value::String(text)) => estimate(text),
        Some(other) => estimate(&other.to_string()),
    }
}
/// A text's estimate; 0 for any other value.
fn string_tokens(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_str).map_or(0, estimate)
}
/// JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(on)) => *on,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// The model a "changed setting `Model Selection` from X to Y." line names: TokenTracker's
/// ``/changed setting `Model Selection` from .*? to ([^`\n]+?)(?:\s*\([^)]*\))?\.(?:\s+|$)/i``.
fn model_selection(content: &str) -> Option<&str> {
    const SETTING: &str = "changed setting `model selection` from ";
    let lower = content.to_ascii_lowercase();
    for (start, _) in lower.match_indices(SETTING) {
        let from = start + SETTING.len();
        // `.*?` stays on its line.
        let line_end = content[from..]
            .find(['\n', '\r', '\u{2028}', '\u{2029}'])
            .map_or(content.len(), |at| from + at);
        for to in (from..line_end).filter(|at| lower.as_bytes()[*at..].starts_with(b" to ")) {
            let name = to + 4;
            let name_end = content[name..].find(['`', '\n']).map_or(content.len(), |at| name + at);
            if let Some(end) = (name + 1..=name_end)
                .filter(|at| content.is_char_boundary(*at))
                .find(|end| selection_ends(&content[*end..]))
            {
                return Some(&content[name..end]);
            }
        }
    }
    None
}
/// `(?:\s*\([^)]*\))?\.(?:\s+|$)` at the start of `rest`.
fn selection_ends(rest: &str) -> bool {
    let full_stop = |rest: &str| {
        rest.strip_prefix('.')
            .is_some_and(|after| after.is_empty() || after.starts_with(is_js_space))
    };
    let qualified = rest
        .trim_start_matches(is_js_space)
        .strip_prefix('(')
        .and_then(|inside| inside.find(')').map(|close| &inside[close + 1..]))
        .is_some_and(full_stop);
    qualified || full_stop(rest)
}

/// TokenTracker's model slug: qualifiers in brackets and effort words (`thinking`, `high`, `fast` and so on) dropped,
/// lower case, every other run of characters a dash, cut to start at `gemini`, `claude` or `gpt`.
fn normalize_model(name: &str) -> Option<String> {
    let mut slug = String::new();
    let mut rest = name.trim_matches(is_js_space);
    // `/\([^)]*\)/g` → " ".
    while let Some(open) = rest.find('(') {
        let Some(close) = rest[open..].find(')') else {
            break;
        };
        slug.push_str(&rest[..open]);
        slug.push(' ');
        rest = &rest[open + close + 1..];
    }
    slug.push_str(rest);
    let slug = without_effort_words(&slug).to_lowercase();
    let mut dashed = String::new();
    for c in slug.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' {
            dashed.push(c);
        } else if !dashed.ends_with('-') {
            dashed.push('-');
        }
    }
    let slug = dashed.trim_matches('-');
    if slug.is_empty() {
        return None;
    }
    let slug = ["gemini", "claude", "gpt"]
        .iter()
        .find_map(|marker| slug.find(marker))
        .map_or(slug, |at| &slug[at..]);
    if ["gemini-", "claude-", "gpt-"]
        .iter()
        .any(|family| slug.starts_with(family))
    {
        Some(slug.to_owned())
    } else {
        Some(format!("antigravity-{slug}"))
    }
}
/// `/\b(thinking|xhigh|high|medium|low|fast)\b/gi` → " ".
fn without_effort_words(text: &str) -> String {
    const WORDS: [&str; 6] = ["thinking", "xhigh", "high", "medium", "low", "fast"];
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut at = 0;
    while at < text.len() {
        let starts = !text[..at].ends_with(word);
        let found = WORDS.iter().find(|candidate| {
            text.get(at..at + candidate.len())
                .is_some_and(|slice| slice.eq_ignore_ascii_case(candidate))
                && !text[at + candidate.len()..].starts_with(word)
        });
        match found {
            Some(candidate) if starts => {
                out.push(' ');
                at += candidate.len();
            }
            _ => {
                let c = text[at..].chars().next().unwrap_or(' ');
                out.push(c);
                at += c.len_utf8();
            }
        }
    }
    out
}

/// One `gen_metadata` row.
#[derive(Debug, Default, Clone, PartialEq)]
struct Generation {
    model: Option<String>,
    context: u64,
    last_step_index: Option<u64>,
    usage: Option<Usage>,
}
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Usage {
    /// System prefix and prompt.
    uncached: u64,
    cached: u64,
    /// All output, text and reasoning.
    output: u64,
    text: u64,
    reasoning: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}
/// A base-128 varint of at most 64 bits.
fn varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for count in 0..10 {
        let byte = *bytes.get(*at)?;
        *at += 1;
        if count == 9 && byte > 1 {
            return None;
        }
        value |= u64::from(byte & 0x7f) << (count * 7);
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}
/// A message's varint and length-delimited fields in order (fixed-width ones are skipped); `None` when malformed.
fn fields(bytes: &[u8]) -> Option<Vec<(u64, Field<'_>)>> {
    let (mut fields, mut at) = (Vec::new(), 0);
    while at < bytes.len() {
        let tag = varint(bytes, &mut at).filter(|tag| *tag <= MAX_SAFE_INTEGER && *tag >> 3 > 0)?;
        match tag & 7 {
            0 => fields.push((tag >> 3, Field::Varint(varint(bytes, &mut at)?))),
            2 => {
                let length = varint(bytes, &mut at)
                    .and_then(|length| usize::try_from(length).ok())
                    .filter(|length| *length <= bytes.len() - at)?;
                fields.push((tag >> 3, Field::Bytes(&bytes[at..at + length])));
                at += length;
            }
            1 if bytes.len() - at >= 8 => at += 8,
            5 if bytes.len() - at >= 4 => at += 4,
            _ => return None,
        }
    }
    Some(fields)
}
fn first<'a>(fields: &[(u64, Field<'a>)], number: u64) -> Option<Field<'a>> {
    fields.iter().find(|(at, _)| *at == number).map(|(_, field)| *field)
}
/// A nested message or text: `Ok(None)` when absent or a zero varint, `Err` when another varint.
fn message(field: Option<Field<'_>>) -> Result<Option<&[u8]>, ()> {
    match field {
        None | Some(Field::Varint(0)) => Ok(None),
        Some(Field::Bytes(bytes)) => Ok(Some(bytes)),
        Some(Field::Varint(_)) => Err(()),
    }
}
/// A token count that JavaScript holds exactly.
fn count(field: Option<Field<'_>>) -> Option<u64> {
    match field {
        Some(Field::Varint(value)) if value <= MAX_SAFE_INTEGER => Some(value),
        _ => None,
    }
}
fn utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_matches(is_js_space).to_owned()
}
/// The generation in a `gen_metadata` row; `None` when the row is malformed.
fn generation(bytes: &[u8]) -> Option<Generation> {
    let root = fields(bytes)?;
    let inner = fields(message(first(&root, 1)).ok()??)?;
    let model = message(first(&inner, 19)).ok()?.map(utf8);
    let mut context = 0;
    if let Some(nine) = message(first(&inner, 9)).ok()?
        && let Some(ten) = message(first(&fields(nine)?, 10)).ok()?
    {
        context = count(first(&fields(ten)?, 1)).unwrap_or(0);
    }
    let mut last_step_index = None;
    for (_, pair) in inner.iter().filter(|(number, _)| *number == 20) {
        let Some(pair) = message(Some(*pair)).ok()? else {
            continue;
        };
        let pair = fields(pair)?;
        let (key, value) = (message(first(&pair, 1)).ok()?, message(first(&pair, 2)).ok()?);
        if let (Some(b"last_step_index"), Some(value)) = (key, value) {
            let value = utf8(value);
            if !value.is_empty()
                && value.bytes().all(|b| b.is_ascii_digit())
                && let Ok(step) = value.parse::<u64>()
                && step <= MAX_SAFE_INTEGER
            {
                last_step_index = Some(step);
            }
        }
    }
    let usage = match message(first(&inner, 4)).ok()? {
        None => None,
        Some(four) => {
            let four = fields(four)?;
            let read = |number| count(first(&four, number));
            let (system, prompt, output, cached, text, reasoning) =
                (read(1), read(2), read(3), read(5), read(9), read(10));
            [system, prompt, output, cached, text, reasoning]
                .iter()
                .any(Option::is_some)
                .then(|| Usage {
                    uncached: system.unwrap_or(0) + prompt.unwrap_or(0),
                    cached: cached.unwrap_or(0),
                    output: output.unwrap_or(0),
                    text: text.unwrap_or(0),
                    reasoning: reasoning.unwrap_or(0),
                })
        }
    };
    Some(Generation {
        model,
        context,
        last_step_index,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(number: u64, wire: u64) -> Vec<u8> {
        encode((number << 3) | wire)
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
        [tag(number, 0), encode(value)].concat()
    }
    fn ld(number: u64, bytes: &[u8]) -> Vec<u8> {
        [tag(number, 2), encode(bytes.len() as u64), bytes.to_vec()].concat()
    }
    fn step(index: u64) -> Vec<u8> {
        ld(
            20,
            &[ld(1, b"last_step_index"), ld(2, index.to_string().as_bytes())].concat(),
        )
    }
    const UINT64_MAX: [u8; 10] = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];

    #[test]
    fn reads_model_context_and_step_from_a_generation() {
        let context = ld(9, &ld(10, &vi(1, 25_000)));
        let row = ld(1, &[ld(19, b"gemini-3.8-flash"), context, step(0)].concat());
        assert_eq!(
            generation(&row),
            Some(Generation {
                model: Some("gemini-3.8-flash".into()),
                context: 25_000,
                last_step_index: Some(0),
                usage: None,
            })
        );
    }

    #[test]
    fn reads_usage_with_the_system_prefix_as_input_and_text_output_absent_as_zero() {
        let usage = ld(
            4,
            &[vi(1, 1016), vi(2, 2000), vi(3, 300), vi(5, 5000), vi(10, 100)].concat(),
        );
        let row = ld(1, &[ld(19, b"gemini-3.8-flash"), usage, step(0)].concat());
        assert_eq!(
            generation(&row).unwrap().usage,
            Some(Usage {
                uncached: 3016,
                cached: 5000,
                output: 300,
                text: 0,
                reasoning: 100,
            })
        );
    }

    #[test]
    fn keeps_a_row_whose_unread_field_holds_a_64_bit_value_but_never_bills_one() {
        let nine = ld(9, &[tag(2, 0), UINT64_MAX.to_vec(), ld(10, &vi(1, 25_000))].concat());
        let four = ld(4, &[vi(1, 100), tag(2, 0), UINT64_MAX.to_vec(), vi(5, 16_319)].concat());
        let row = ld(1, &[ld(19, b"gemini-3.8-flash"), nine, four, step(7)].concat());
        let read = generation(&row).expect("a valid 64-bit value must not discard the row");
        assert_eq!((read.context, read.last_step_index), (25_000, Some(7)));
        let usage = read.usage.unwrap();
        assert_eq!((usage.uncached, usage.cached), (100, 16_319));
    }

    #[test]
    fn rejects_malformed_rows() {
        // A length whose varint never ends.
        assert_eq!(generation(&[0x0a, 0x80, 0x80, 0x80]), None);
        // A varint wider than 64 bits.
        let wide = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02];
        let row = ld(1, &[ld(19, b"m"), ld(4, &[tag(2, 0), wide.to_vec()].concat())].concat());
        assert_eq!(generation(&row), None);
        // Field number 0, a group wire type, a length past the end, a message that is a varint.
        assert_eq!(generation(&ld(1, &vi(0, 1))), None);
        assert_eq!(generation(&ld(1, &tag(3, 3))), None);
        assert_eq!(generation(&[0x0a, 0x05, 0x01]), None);
        assert_eq!(generation(&vi(1, 5)), None);
        assert_eq!(generation(&ld(1, &vi(4, 7))), None);
    }

    #[test]
    fn skips_fixed_width_fields_and_ignores_unreadable_steps() {
        let row = ld(
            1,
            &[
                [tag(2, 1), vec![0; 8]].concat(),
                [tag(3, 5), vec![0; 4]].concat(),
                ld(20, &[ld(1, b"last_step_index"), ld(2, b"3a")].concat()),
                ld(20, &[ld(1, b"other"), ld(2, b"9")].concat()),
            ]
            .concat(),
        );
        assert_eq!(generation(&row), Some(Generation::default()));
    }

    #[test]
    fn estimates_a_token_per_cjk_character_and_per_four_others() {
        assert_eq!(estimate(""), 0);
        assert_eq!(estimate("abcde"), 2);
        assert_eq!(estimate("你好世界"), 4);
        assert_eq!(estimate("ひらがなabc"), 5);
        assert_eq!(value_tokens(Some(&serde_json::json!([{"a": 1}]))), 3);
        assert_eq!(value_tokens(Some(&Value::Null)), 0);
        assert_eq!(string_tokens(Some(&serde_json::json!(5))), 0);
    }

    #[test]
    fn finds_the_selected_model_as_tokentracker_does() {
        let line = "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\nhello";
        assert_eq!(model_selection(line), Some("Gemini 3.5 Flash"));
        assert_eq!(
            model_selection(
                "User changed setting `Model Selection` from Gemini 3 Pro (High) to Claude Sonnet 4.5 (Thinking). Next"
            ),
            Some("Claude Sonnet 4.5")
        );
        assert_eq!(
            model_selection("CHANGED SETTING `model selection` FROM a to GPT-OSS 120B (Medium)."),
            Some("GPT-OSS 120B")
        );
        assert_eq!(model_selection("changed setting `Model Selection` from a to b"), None);
        assert_eq!(
            model_selection("changed setting `Model Selection` from a\n to b."),
            None
        );
    }

    #[test]
    fn normalises_model_names_as_tokentracker_does() {
        let cases = [
            ("Gemini 3.5 Flash", Some("gemini-3.5-flash")),
            ("Gemini 3 Pro (High)", Some("gemini-3-pro")),
            ("Claude Sonnet 4.5 (Thinking)", Some("claude-sonnet-4.5")),
            ("Claude Opus 4.6 Thinking", Some("claude-opus-4.6")),
            ("GPT-OSS 120B (Medium)", Some("gpt-oss-120b")),
            ("models/gemini-3-pro-preview", Some("gemini-3-pro-preview")),
            ("Gemini 3 Flash Fast", Some("gemini-3-flash")),
            ("Highland", Some("antigravity-highland")),
            ("Auto", Some("antigravity-auto")),
            ("(High)", None),
            ("  ", None),
        ];
        for (name, slug) in cases {
            assert_eq!(normalize_model(name).as_deref(), slug, "{name}");
        }
    }

    #[test]
    fn finds_the_database_beside_brain() {
        let transcript = Path::new("/u/.gemini/antigravity/brain/abc/.system_generated/logs/transcript.jsonl");
        assert_eq!(
            database_files(transcript),
            vec![
                ("database", PathBuf::from("/u/.gemini/antigravity/conversations/abc.db")),
                ("wal", PathBuf::from("/u/.gemini/antigravity/conversations/abc.db-wal")),
            ]
        );
        assert!(database_files(Path::new("/u/.gemini/antigravity/brain/abc/transcript.jsonl")).is_empty());
        assert!(conversation(Path::new("/brain/abc/.system_generated/logs/other.jsonl")).is_none());
    }
}
