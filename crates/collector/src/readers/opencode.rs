//! OpenCode-format stores: the SQLite databases of OpenCode, Kilo Code and the OpenCode-based Mimo Code and DuMate,
//! and OpenCode's pre-1.2 message files.
use super::adapters::Sidecars;
use super::parser::{
    Counted, EventMap, Invalid, TEXT_LIMIT, counter, digest, epoch, field, file_name, keep, note, object, optional,
    parent_name, parse_json, safe_sum, text, tool_id, usage_record,
};
use super::{dumate, mimo};
use crate::store::{UsageOrigin, reconcile};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Row};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use tokentracky_core::{MAX_SAFE_INTEGER, ParseResult, TokenCounts, ToolId, UsageEvent};

/// Allowlisted fields of one assistant message (`Null` when absent); `tokens` is the message's JSON token object.
struct Message {
    id: Value,
    session: Value,
    created: Value,
    model: Value,
    tokens: Value,
    cwd: Value,
}

/// What an OpenCode-based tool changes: which rows are its own and how its counters add up.
pub(crate) struct Dialect {
    /// Only rows of these providers are read; the others are history the tool imported or mirrors. `None` reads all.
    pub(crate) providers: Option<&'static [&'static str]>,
    pub(crate) reasoning: Reasoning,
    /// A completed v1 message copied into a fork (same times, model, provider and counters) counts once.
    pub(crate) forks: bool,
}
/// How a record's reasoning relates to its output. Input always excludes both caches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reasoning {
    /// Outside output, so it is added to it; `tokens.total` is not read.
    Separate,
    /// Outside output; a `tokens.total` must equal input, output, both caches and reasoning.
    SeparateChecked,
    /// Each record's `tokens.total` shows it: input, output and both caches alone (inside), or plus reasoning (outside).
    FromTotal,
}
const OPENCODE: Dialect = Dialect {
    providers: None,
    reasoning: Reasoning::Separate,
    forks: true,
};
/// Kilo Code: rows are never merged by counters.
const OTHER: Dialect = Dialect {
    providers: None,
    reasoning: Reasoning::Separate,
    forks: false,
};
fn dialect(tool: ToolId) -> &'static Dialect {
    match tool {
        ToolId::OpenCode => &OPENCODE,
        ToolId::Mimo => &mimo::DIALECT,
        ToolId::DuMate => &dumate::DIALECT,
        _ => &OTHER,
    }
}
/// Whether reasoning is already inside output. `kinds` are input, output and both caches as stored.
pub(crate) fn reasoning_inside(
    rule: Reasoning,
    total: Option<&Value>,
    kinds: [u64; 4],
    reasoning: u64,
) -> Counted<bool> {
    if rule == Reasoning::Separate {
        return Ok(false);
    }
    let kinds = safe_sum(&kinds)?;
    let total = total.filter(|total| !total.is_null());
    match total.map(|total| counter(Some(total), false)).transpose()? {
        Some(total) if total == kinds && rule == Reasoning::FromTotal => Ok(true),
        Some(total) if total == safe_sum(&[kinds, reasoning])? => Ok(false),
        None if rule == Reasoning::SeparateChecked || reasoning == 0 => Ok(false),
        _ => Err(Invalid),
    }
}

/// Disjoint since OpenCode 1.3.16 (assumed for every record): input excludes both caches and output excludes reasoning,
/// unless `rule` says otherwise.
fn message_event(tool: ToolId, rule: Reasoning, message: &Message) -> Result<Option<UsageEvent>, Invalid> {
    let parsed = match &message.tokens {
        Value::String(tokens) => Some(parse_json(tokens).ok_or(Invalid)?),
        _ => None,
    };
    let tokens = parsed.as_ref().unwrap_or(&message.tokens).as_object();
    let (Some(tokens), Some(id), Some(session)) =
        (tokens, text(Some(&message.id), 512), text(Some(&message.session), 512))
    else {
        return Ok(None);
    };
    let cache = object(tokens.get("cache"));
    let reasoning = optional(tokens.get("reasoning"))?;
    let (input, output) = (optional(tokens.get("input"))?, optional(tokens.get("output"))?);
    let (cache_read, cache_write) = (optional(field(cache, "read"))?, optional(field(cache, "write"))?);
    let inside = reasoning_inside(
        rule,
        tokens.get("total"),
        [input, output, cache_read, cache_write],
        reasoning,
    )?;
    let counts = TokenCounts {
        input,
        output: if inside {
            output
        } else {
            safe_sum(&[output, reasoning])?
        },
        cache_read,
        cache_write,
        reasoning: Some(reasoning),
        cache_write_1h: None,
    };
    let model = text(Some(&message.model), 256).unwrap_or("unknown");
    let cwd = text(Some(&message.cwd), TEXT_LIMIT);
    // Keep zero corrections as local tombstones so a fork snapshot cannot revive them.
    usage_record(
        tool,
        &format!("{session}|{id}"),
        session,
        cwd,
        model,
        epoch(Some(&message.created)),
        counts,
    )
    .map(Some)
}

/// OpenCode up to 1.1.65 kept each message as `storage/message/<sessionID>/<messageID>.json`, rewritten while streaming.
pub(crate) fn parse_opencode_message(path: &Path, document: &Value, _: &Sidecars) -> ParseResult {
    let Some(message) = document
        .as_object()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
    else {
        return ParseResult::default();
    };
    let name = file_name(path);
    let stem = name
        .strip_suffix(".json")
        .filter(|stem| !stem.is_empty())
        .unwrap_or(&name);
    let owned = |value: Option<&Value>| value.cloned().unwrap_or(Value::Null);
    let message = Message {
        id: Value::from(text(message.get("id"), 512).unwrap_or(stem)),
        session: Value::from(
            text(message.get("sessionID"), 512).map_or_else(|| parent_name(path).into_owned(), Into::into),
        ),
        created: owned(field(object(message.get("time")), "created")),
        model: owned(message.get("modelID")),
        tokens: owned(message.get("tokens")),
        cwd: owned(field(object(message.get("path")), "cwd")),
    };
    let (mut events, mut diagnostics) = (Vec::new(), Vec::new());
    keep(
        message_event(ToolId::OpenCode, Reasoning::Separate, &message),
        &mut events,
        &mut diagnostics,
    );
    events.retain(|event| tokentracky_core::total_tokens(&event.tokens) != 0);
    ParseResult {
        events,
        diagnostics,
        withdrawn: None,
    }
}

fn fields(data: &str, model: &str, provider: &str) -> String {
    format!(
        "json_extract({data}, '$.time.created') AS created, json_extract({data}, '$.time.completed') AS completed,
  {model} AS model, {provider} AS provider, json_extract({data}, '$.tokens') AS tokens"
    )
}
/// v1 rows (OpenCode 1.2 to 1.19, Kilo Code 7). Only usage fields leave SQLite, never content.
fn v1() -> String {
    format!(
        "SELECT id, session_id AS session, {}, json_extract(data, '$.path.cwd') AS cwd
  FROM message WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END = 'assistant' ORDER BY time_created, id",
        fields("data", "json_extract(data, '$.modelID')", "json_extract(data, '$.providerID')")
    )
}
/// OpenCode 2 rows. Copy provenance is projected separately from token counters.
fn v2(directory: bool, sessions: bool, lineage: bool) -> String {
    format!(
        "SELECT m.id, m.session_id AS session, {}, {} AS cwd, {} AS seq, {} AS fork_session
  FROM session_message m {}
  WHERE m.type IN ('assistant', 'compaction') AND json_valid(m.data) ORDER BY m.time_created, m.id",
        fields(
            "m.data",
            "json_extract(m.data, '$.model.id')",
            "json_extract(m.data, '$.model.providerID')"
        ),
        if directory { "s.directory" } else { "NULL" },
        if lineage { "m.seq" } else { "NULL" },
        if sessions { "s.fork_session_id" } else { "NULL" },
        if directory || sessions {
            "LEFT JOIN session_v2 s ON s.id = m.session_id"
        } else {
            ""
        },
    )
}

/// A column as `node:sqlite` returns it: an integer beyond the safe range fails the read, a blob carries no usage.
fn column(row: &Row, name: &str) -> rusqlite::Result<Value> {
    let index = row.as_ref().column_index(name)?;
    Ok(match row.get_ref(index)? {
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
        ValueRef::Integer(n) if n.unsigned_abs() <= MAX_SAFE_INTEGER => Value::from(n),
        ValueRef::Integer(n) => return Err(rusqlite::Error::IntegralValueOutOfRange(index, n)),
        // A JavaScript number: integral values read as integers, so `1.0` and `1` are the same.
        ValueRef::Real(n) if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64 => Value::from(n as i64),
        ValueRef::Real(n) => Value::from(n),
        ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text)),
    })
}
pub(crate) fn has(db: &Connection, table: &str, names: &[&str]) -> rusqlite::Result<bool> {
    let mut statement = db.prepare("SELECT name FROM pragma_table_info(?)")?;
    let columns = statement
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(names.iter().all(|name| columns.contains(*name)))
}

/// `copyPrint`: what a fork's copy of a message shares with the stored original: its start time, model and counters.
fn copy_print(event: &UsageEvent) -> String {
    let tokens = &event.tokens;
    json!([
        event.occurred_at,
        event.model,
        tokens.input,
        tokens.output,
        tokens.cache_read,
        tokens.cache_write,
        tokens.reasoning.unwrap_or(0)
    ])
    .to_string()
}

#[derive(Default)]
struct Reading {
    events: EventMap,
    origins: Vec<UsageOrigin>,
    diagnostics: Vec<String>,
    /// Session of the first completed v1 message with each print (times, model, provider and counters).
    forks: HashMap<String, String>,
    /// Session of each event already counted from this database, by its `copy_print` (`counted`).
    counted: HashMap<String, String>,
    /// Ids of the events already counted from this database (`knownIds`).
    known_ids: HashSet<String>,
    known_origins: HashMap<String, UsageOrigin>,
}
impl Reading {
    fn rows(&mut self, db: &Connection, tool: ToolId, sql: &str, v1: bool) -> rusqlite::Result<()> {
        let dialect = dialect(tool);
        let mut statement = db.prepare(sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let completed = column(row, "completed")?;
            let provider = column(row, "provider")?;
            if let Some(own) = dialect.providers
                && !provider.as_str().is_some_and(|provider| own.contains(&provider))
            {
                continue;
            }
            let message = Message {
                id: column(row, "id")?,
                session: column(row, "session")?,
                created: column(row, "created")?,
                model: column(row, "model")?,
                tokens: column(row, "tokens")?,
                cwd: column(row, "cwd")?,
            };
            let event = match message_event(tool, dialect.reasoning, &message) {
                Ok(Some(event)) => event,
                Ok(None) => continue,
                Err(Invalid) => {
                    note(&mut self.diagnostics, "invalid_counters");
                    continue;
                }
            };
            if !v1 {
                // Identify the copy encoding independently of seq/schema availability. Missing metadata must never
                // turn an inherited snapshot into an observed original (or erase a previously observed edge).
                let copy_seq = message.id.as_str().and_then(|id| {
                    let (event, suffix) = id.strip_prefix("msg_")?.rsplit_once('_')?;
                    (!event.is_empty() && !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()))
                        .then_some(suffix)
                });
                if let (Some(session), Some(seq)) = (message.session.as_str(), column(row, "seq")?.as_u64()) {
                    let node = |session: &str| digest(format!("{}|v2|{session}|{seq}", tool_id(tool)));
                    let fork = column(row, "fork_session")?;
                    // Pinned projector: `${Message.ID.fromEvent(forkEvent.id)}_${parentRow.seq}`.
                    // Ordinary IDs contain no underscore after `msg_`; copies preserve parent sequence numbers.
                    let parent = copy_seq.and_then(|_| text(Some(&fork), 512)).map(node);
                    let origin = UsageOrigin {
                        event_id: event.event_id.clone(),
                        node: node(session),
                        parent,
                    };
                    if copy_seq.is_some_and(|suffix| suffix != seq.to_string() || origin.parent.is_none())
                        || self.known_origins.get(&event.event_id).is_some_and(|old| {
                            // Older readers incorrectly recorded copies with unavailable session metadata as roots.
                            // The pinned copy encoding can repair that missing edge, never replace an observed one.
                            old != &origin && !(old.node == origin.node && old.parent.is_none() && copy_seq.is_some())
                        })
                    {
                        note(&mut self.diagnostics, "fork_lineage_unavailable");
                    } else {
                        self.origins.push(origin);
                    }
                } else {
                    note(&mut self.diagnostics, "fork_lineage_unavailable");
                }
            }
            if v1 && dialect.forks && !completed.is_null() {
                let print = json!([message.created, completed, message.model, provider, event.tokens]).to_string();
                if self
                    .forks
                    .get(&print)
                    .is_some_and(|session| *session != event.session_id)
                {
                    continue;
                }
                if !self.known_ids.contains(&event.event_id)
                    && self
                        .counted
                        .get(&copy_print(&event))
                        .is_some_and(|session| *session != event.session_id)
                {
                    continue;
                }
                self.forks.insert(print, event.session_id.clone());
            }
            self.events.insert(event);
        }
        Ok(())
    }
}

/// OpenCode-format SQLite stores (OpenCode's `opencode.db`, Kilo Code's `kilo.db`, Mimo Code's `mimocode.db`, DuMate's
/// `opencode.db`), opened read-only (never written; WAL contents are visible). The same message in the v1 and v2
/// tables, or in flat JSON files, has the same identity. Each tool's `Dialect` says which rows are its own.
/// OpenCode v1 retains its legacy fingerprint approximation; Kilo rows are never merged by counters.
/// A v1 fork copies earlier messages into a new session with new ids, so a completed message whose times, counters and
/// model match one already read from another session is skipped. `known` (events already counted from this database)
/// extends that across scans, so deleting the original session does not count its copies again.
/// V2 copies use sequence lineage. The ingestion service commits that lineage with the raw snapshots, so an original
/// correction outranks its copies across deletion/restart. This standalone reader reconciles only the current snapshot.
pub fn read_opencode_database(tool: ToolId, path: &Path, known: &[UsageEvent]) -> rusqlite::Result<ParseResult> {
    let (mut result, origins) = read_database_with_origins(tool, path, known, &[])?;
    result.events = reconcile(result.events, &origins);
    Ok(result)
}

pub(crate) fn read_database_with_origins(
    tool: ToolId,
    path: &Path,
    known: &[UsageEvent],
    known_origins: &[UsageOrigin],
) -> rusqlite::Result<(ParseResult, Vec<UsageOrigin>)> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    db.busy_timeout(Duration::from_millis(500))?;
    db.execute_batch("BEGIN DEFERRED")?;
    let mut reading = Reading {
        counted: known
            .iter()
            .map(|event| (copy_print(event), event.session_id.clone()))
            .collect(),
        known_ids: known.iter().map(|event| event.event_id.clone()).collect(),
        known_origins: known_origins
            .iter()
            .map(|origin| (origin.event_id.clone(), origin.clone()))
            .collect(),
        ..Reading::default()
    };
    if has(&db, "message", &["id", "session_id", "time_created", "data"])? {
        if tool == ToolId::Kilo {
            // The schema carries no durable import/fork provenance. Exclude the entire physical
            // database, including v2 rows in a mixed store and rows retained from earlier scans.
            note(&mut reading.diagnostics, "kilo_history_local_only");
        }
        reading.rows(&db, tool, &v1(), true)?;
    }
    let v2_table: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='session_message')",
        [],
        |row| row.get(0),
    )?;
    if has(
        &db,
        "session_message",
        &["id", "session_id", "type", "time_created", "data"],
    )? {
        let directory = has(&db, "session_v2", &["id", "directory"])?;
        let sessions = has(&db, "session_v2", &["id", "fork_session_id"])?;
        let lineage = has(&db, "session_message", &["seq"])?;
        reading.rows(&db, tool, &v2(directory, sessions, lineage), false)?;
    } else if v2_table {
        note(&mut reading.diagnostics, "fork_lineage_unavailable");
    }
    let mut combined: HashMap<_, _> = known_origins.iter().map(|o| (o.event_id.as_str(), o.clone())).collect();
    combined.extend(reading.origins.iter().map(|o| (o.event_id.as_str(), o.clone())));
    // An upgraded/replaced database may have removed its v1 table as well as its rows. A retained Kilo ledger
    // record without observed v2 lineage cannot become eligible merely because that table disappeared.
    if tool == ToolId::Kilo
        && known
            .iter()
            .any(|event| !combined.contains_key(event.event_id.as_str()))
    {
        note(&mut reading.diagnostics, "kilo_history_local_only");
    }
    let events = reading.events.into_events();
    let relevant = crate::store::relevant_lineage(
        &combined.into_values().collect::<Vec<_>>(),
        events.iter().chain(known).map(|event| event.event_id.as_str()),
    );
    if !crate::store::complete_lineage(&relevant) {
        note(&mut reading.diagnostics, "fork_lineage_unavailable");
    }
    Ok((
        ParseResult {
            events,
            diagnostics: reading.diagnostics,
            withdrawn: None,
        },
        reading.origins,
    ))
}
