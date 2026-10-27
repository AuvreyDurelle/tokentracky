//! Saved totals of the counted events. `usage_counted` holds every event the summaries count (each event id once, at
//! its latest revision, mirrors and fork copies resolved, tokens not zero), priced; `usage_slots` holds their sums by
//! 15-minute UTC slot, UTC day, tool, model, session and project. A commit re-derives the rows of the event ids it
//! touches, and a new price table re-prices them all once. Queries read the sums, not every event: every zone in use is
//! a whole number of quarter hours from UTC, so local days and half hours are whole slots.
use super::allowlist::timestamp_ms;
use super::collate::locale_cmp;
use super::origins::{UsageOrigin, canonical_ids};
use super::{Pricer, Result, day, parse, priced, sum, text};
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::sync::LazyLock;
use tokentracky_core::{CostParts, TOOL_IDS, TokenCounts, ToolId, UsageEvent, total_tokens};

/// A slot's length in milliseconds.
pub(super) const SLOT: i64 = 15 * 60_000;

pub(super) const SCHEMA: &str = "
  CREATE TABLE IF NOT EXISTS usage_counted(event_id TEXT PRIMARY KEY, slot INTEGER, day TEXT, tool TEXT NOT NULL,
    model TEXT NOT NULL, session_id TEXT NOT NULL, project TEXT, occurred_at TEXT, input INTEGER NOT NULL,
    output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
    reasoning INTEGER NOT NULL, cost INTEGER, part_input INTEGER, part_output INTEGER, part_cache_read INTEGER,
    part_cache_write INTEGER, part_savings INTEGER);
  CREATE INDEX IF NOT EXISTS usage_counted_key ON usage_counted(session_id, slot);
  CREATE TABLE IF NOT EXISTS usage_slots(slot INTEGER, day TEXT, tool TEXT NOT NULL, model TEXT NOT NULL,
    session_id TEXT NOT NULL, project TEXT, events INTEGER NOT NULL, uncosted INTEGER NOT NULL,
    unparted INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, reasoning INTEGER NOT NULL, cost INTEGER NOT NULL,
    part_input INTEGER NOT NULL, part_output INTEGER NOT NULL, part_cache_read INTEGER NOT NULL,
    part_cache_write INTEGER NOT NULL, part_savings INTEGER NOT NULL, first_id TEXT NOT NULL, last_at TEXT,
    last_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS usage_slots_slot ON usage_slots(slot);
  CREATE INDEX IF NOT EXISTS usage_slots_key ON usage_slots(session_id, slot);";

/// What a slot row sums over.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct Key {
    /// The slot's first instant in UTC milliseconds; `None` for undated events.
    pub slot: Option<i64>,
    /// The event's UTC day as written (`occurredAt.slice(0, 10)`).
    pub day: Option<String>,
    pub tool: ToolId,
    pub model: String,
    pub session_id: String,
    pub project: Option<String>,
}

/// One counted event: its key, tokens and cost, priced as [`super::UsageStore::events`] prices it.
struct Counted {
    id: String,
    key: Key,
    occurred_at: Option<String>,
    tokens: TokenCounts,
    cost: Option<u64>,
    parts: Option<CostParts>,
}
fn counted(event: UsageEvent, pricer: Option<&Pricer>) -> Counted {
    let price = priced(&event, pricer);
    let at = event.occurred_at.as_deref().and_then(timestamp_ms);
    Counted {
        key: Key {
            slot: at.map(|at| at.div_euclid(SLOT) * SLOT),
            day: day(&event).map(str::to_owned),
            tool: event.tool,
            model: event.model,
            session_id: event.session_id,
            project: event.project,
        },
        id: event.event_id,
        occurred_at: event.occurred_at,
        tokens: event.tokens,
        cost: price.as_ref().map(|price| price.0).or(event.cost_microusd),
        parts: price.map(|price| price.1),
    }
}

/// The sums of one key's events.
#[derive(Debug, Clone)]
pub(super) struct Slot {
    pub key: Key,
    pub events: u64,
    /// Events without a cost, and without cost parts: any makes a total's cost (or its parts) unknown.
    pub uncosted: u64,
    pub unparted: u64,
    pub tokens: [u64; 6],
    pub cost: u64,
    pub parts: CostParts,
    /// The smallest event id, for the order of first appearance among events in id order.
    pub first_id: String,
    /// The latest event as [`later`] orders them: its time and id.
    pub last_at: Option<String>,
    pub last_id: String,
}
/// Input, output, cache read, cache write, the one-hour part of cache write, and reasoning.
fn kinds(tokens: &TokenCounts) -> [u64; 6] {
    [
        tokens.input,
        tokens.output,
        tokens.cache_read,
        tokens.cache_write,
        tokens.cache_write_1h.unwrap_or(0),
        tokens.reasoning.unwrap_or(0),
    ]
}
fn add_parts(a: CostParts, b: CostParts) -> CostParts {
    CostParts {
        input: a.input.saturating_add(b.input),
        output: a.output.saturating_add(b.output),
        cache_read: a.cache_read.saturating_add(b.cache_read),
        cache_write: a.cache_write.saturating_add(b.cache_write),
        cache_savings: a.cache_savings.saturating_add(b.cache_savings),
    }
}
/// Whether `(at, id)` comes before `(last_at, last_id)` among the latest first, as sessions order their events: by
/// time, a missing one as `""`, and on a tie the smaller id first.
fn later(at: Option<&str>, id: &str, last_at: Option<&str>, last_id: &str) -> bool {
    match locale_cmp(at.unwrap_or(""), last_at.unwrap_or("")) {
        Ordering::Greater => true,
        Ordering::Equal => id < last_id,
        Ordering::Less => false,
    }
}
impl Slot {
    fn of(event: &Counted) -> Self {
        Self {
            key: event.key.clone(),
            events: 1,
            uncosted: u64::from(event.cost.is_none()),
            unparted: u64::from(event.parts.is_none()),
            tokens: kinds(&event.tokens),
            cost: event.cost.unwrap_or(0),
            parts: event.parts.unwrap_or_default(),
            first_id: event.id.clone(),
            last_at: event.occurred_at.clone(),
            last_id: event.id.clone(),
        }
    }
    fn add(&mut self, event: &Counted) {
        self.events += 1;
        self.uncosted += u64::from(event.cost.is_none());
        self.unparted += u64::from(event.parts.is_none());
        for (total, count) in self.tokens.iter_mut().zip(kinds(&event.tokens)) {
            *total = total.saturating_add(count);
        }
        self.cost = self.cost.saturating_add(event.cost.unwrap_or(0));
        self.parts = add_parts(self.parts, event.parts.unwrap_or_default());
        if event.id < self.first_id {
            self.first_id = event.id.clone();
        }
        if later(
            event.occurred_at.as_deref(),
            &event.id,
            self.last_at.as_deref(),
            &self.last_id,
        ) {
            self.last_at = event.occurred_at.clone();
            self.last_id = event.id.clone();
        }
    }
}
/// The events folded into one row per key.
#[derive(Default)]
struct Fold(HashMap<Key, Slot>);
impl Fold {
    fn add(&mut self, event: &Counted) {
        match self.0.get_mut(&event.key) {
            Some(slot) => slot.add(event),
            None => {
                self.0.insert(event.key.clone(), Slot::of(event));
            }
        }
    }
}

fn int(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}
fn count<I: rusqlite::RowIndex>(row: &Row, column: I) -> rusqlite::Result<u64> {
    Ok(row.get::<_, i64>(column)?.max(0) as u64)
}
/// Each tool by its id, as the store writes it.
static TOOLS: LazyLock<HashMap<String, ToolId>> =
    LazyLock::new(|| TOOL_IDS.iter().map(|&tool| (text(tool), tool)).collect());
fn tool(id: String) -> Result<ToolId> {
    match TOOLS.get(&id) {
        Some(&tool) => Ok(tool),
        None => parse(id),
    }
}
/// A key from the first six columns: slot, day, tool, model, session and project.
fn key(row: &Row) -> Result<Key> {
    Ok(Key {
        slot: row.get(0)?,
        day: row.get(1)?,
        tool: tool(row.get(2)?)?,
        model: row.get(3)?,
        session_id: row.get(4)?,
        project: row.get(5)?,
    })
}
const KEY_IS: &str = "session_id=? AND slot IS ? AND day IS ? AND tool=? AND model=? AND project IS ?";
fn key_params(key: &Key) -> (String, Option<i64>, Option<String>, String, String, Option<String>) {
    (
        key.session_id.clone(),
        key.slot,
        key.day.clone(),
        text(key.tool),
        key.model.clone(),
        key.project.clone(),
    )
}
fn insert_counted(db: &Connection, event: &Counted) -> Result<()> {
    let tokens = kinds(&event.tokens);
    let parts = event.parts;
    let (session, slot, day, tool, model, project) = key_params(&event.key);
    db.prepare_cached(
        "INSERT INTO usage_counted(event_id,slot,day,tool,model,session_id,project,occurred_at,input,output,cache_read,\
         cache_write,cache_write_1h,reasoning,cost,part_input,part_output,part_cache_read,part_cache_write,part_savings) \
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )?
    .execute(params![
        event.id,
        slot,
        day,
        tool,
        model,
        session,
        project,
        event.occurred_at,
        int(tokens[0]),
        int(tokens[1]),
        int(tokens[2]),
        int(tokens[3]),
        int(tokens[4]),
        int(tokens[5]),
        event.cost.map(int),
        parts.map(|parts| int(parts.input)),
        parts.map(|parts| int(parts.output)),
        parts.map(|parts| int(parts.cache_read)),
        parts.map(|parts| int(parts.cache_write)),
        parts.map(|parts| int(parts.cache_savings)),
    ])?;
    Ok(())
}
fn read_counted(row: &Row, key: Key) -> Result<Counted> {
    let part = |column: &str| {
        row.get::<_, Option<i64>>(column)
            .map(|value| value.map(|value| value.max(0) as u64))
    };
    let parts = match (
        part("part_input")?,
        part("part_output")?,
        part("part_cache_read")?,
        part("part_cache_write")?,
        part("part_savings")?,
    ) {
        (Some(input), Some(output), Some(cache_read), Some(cache_write), Some(cache_savings)) => Some(CostParts {
            input,
            output,
            cache_read,
            cache_write,
            cache_savings,
        }),
        _ => None,
    };
    let cache_write_1h = count(row, "cache_write_1h")?;
    Ok(Counted {
        id: row.get("event_id")?,
        key,
        occurred_at: row.get("occurred_at")?,
        tokens: TokenCounts {
            input: count(row, "input")?,
            output: count(row, "output")?,
            cache_read: count(row, "cache_read")?,
            cache_write: count(row, "cache_write")?,
            reasoning: Some(count(row, "reasoning")?),
            cache_write_1h: (cache_write_1h > 0).then_some(cache_write_1h),
        },
        cost: row.get::<_, Option<i64>>("cost")?.map(|cost| cost.max(0) as u64),
        parts,
    })
}
fn insert_slot(db: &Connection, slot: &Slot) -> Result<()> {
    let (session, at, day, tool, model, project) = key_params(&slot.key);
    let [input, output, cache_read, cache_write, cache_write_1h, reasoning] = slot.tokens.map(int);
    db.prepare_cached(
        "INSERT INTO usage_slots(slot,day,tool,model,session_id,project,events,uncosted,unparted,input,output,\
         cache_read,cache_write,cache_write_1h,reasoning,cost,part_input,part_output,part_cache_read,part_cache_write,\
         part_savings,first_id,last_at,last_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )?
    .execute(params![
        at,
        day,
        tool,
        model,
        session,
        project,
        int(slot.events),
        int(slot.uncosted),
        int(slot.unparted),
        input,
        output,
        cache_read,
        cache_write,
        cache_write_1h,
        reasoning,
        int(slot.cost),
        int(slot.parts.input),
        int(slot.parts.output),
        int(slot.parts.cache_read),
        int(slot.parts.cache_write),
        int(slot.parts.cache_savings),
        slot.first_id,
        slot.last_at,
        slot.last_id,
    ])?;
    Ok(())
}
/// A `usage_slots` row, its columns in table order.
fn read_slot(row: &Row) -> Result<Slot> {
    Ok(Slot {
        key: key(row)?,
        events: count(row, 6)?,
        uncosted: count(row, 7)?,
        unparted: count(row, 8)?,
        tokens: [
            count(row, 9)?,
            count(row, 10)?,
            count(row, 11)?,
            count(row, 12)?,
            count(row, 13)?,
            count(row, 14)?,
        ],
        cost: count(row, 15)?,
        parts: CostParts {
            input: count(row, 16)?,
            output: count(row, 17)?,
            cache_read: count(row, 18)?,
            cache_write: count(row, 19)?,
            cache_savings: count(row, 20)?,
        },
        first_id: row.get(21)?,
        last_at: row.get(22)?,
        last_id: row.get(23)?,
    })
}

/// The price table version the saved totals were priced under (`Some(None)` without one), or `None` until they are
/// built.
pub(super) fn priced_under(db: &Connection) -> Result<Option<Option<String>>> {
    let value: Option<String> = db
        .query_row("SELECT value FROM metadata WHERE key='slots_priced'", [], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(value.map(|value| serde_json::from_str(&value)).transpose()?)
}
/// Leaves the saved totals to be built again before they are read.
pub(super) fn discard(db: &Connection) -> Result<()> {
    db.execute("DELETE FROM metadata WHERE key='slots_priced'", [])?;
    Ok(())
}
/// Whether a write keeps the saved totals up to date: they are built, under `pricing`. Built under other prices they
/// are discarded instead, to be built again when read.
pub(super) fn kept(db: &Connection, pricing: Option<&str>) -> Result<bool> {
    Ok(match priced_under(db)? {
        Some(version) if version.as_deref() == pricing => true,
        Some(_) => {
            discard(db)?;
            false
        }
        None => false,
    })
}
/// What every usage write advances: the newest stored event and event version, and the number of files read. A
/// version that writes usage without updating the saved totals leaves it unlike the stamp they last saved.
fn signature(db: &Connection) -> Result<String> {
    Ok(db.query_row(
        "SELECT (SELECT IFNULL(MAX(rowid),0) FROM file_events)||':'||(SELECT IFNULL(MAX(rowid),0) FROM event_versions)\
         ||':'||(SELECT COUNT(*) FROM files)",
        [],
        |row| row.get(0),
    )?)
}
/// Records that the saved totals match the stored usage.
pub(super) fn stamp(db: &Connection) -> Result<()> {
    db.execute(
        "INSERT INTO metadata(key,value) VALUES('slots_stamp',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [signature(db)?],
    )?;
    Ok(())
}
pub(super) fn stamped(db: &Connection) -> Result<bool> {
    let stamp: Option<String> = db
        .query_row("SELECT value FROM metadata WHERE key='slots_stamp'", [], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(stamp == Some(signature(db)?))
}
fn origins(db: &Connection) -> Result<Vec<UsageOrigin>> {
    Ok(db
        .prepare("SELECT event_id,node,parent FROM usage_origins")?
        .query_map([], |row| {
            Ok(UsageOrigin {
                event_id: row.get(0)?,
                node: row.get(1)?,
                parent: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
/// Each counted event among `from` (`SELECT event_id,event_json` of current events), in no particular order.
fn each_counted(
    db: &Connection,
    from: &str,
    origins: &[UsageOrigin],
    pricer: Option<&Pricer>,
    mut each: impl FnMut(Counted) -> Result<()>,
) -> Result<()> {
    let mut statement = db.prepare(from)?;
    let selected: Option<HashSet<String>> = if origins.is_empty() {
        None
    } else {
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Some(
            canonical_ids(ids.iter().map(String::as_str), origins)
                .into_iter()
                .map(str::to_owned)
                .collect(),
        )
    };
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        if selected.as_ref().is_some_and(|selected| !selected.contains(&id)) {
            continue;
        }
        let event: UsageEvent = serde_json::from_str(&row.get::<_, String>(1)?)?;
        if total_tokens(&event.tokens) != 0 {
            each(counted(event, pricer))?;
        }
    }
    Ok(())
}
/// Every slot row, folded from the events without saving anything (a read-only store whose totals are not built).
pub(super) fn fold(db: &Connection, origins: &[UsageOrigin], pricer: Option<&Pricer>) -> Result<Vec<Slot>> {
    let mut fold = Fold::default();
    each_counted(
        db,
        "SELECT event_id,event_json FROM current_events",
        origins,
        pricer,
        |event| {
            fold.add(&event);
            Ok(())
        },
    )?;
    Ok(fold.0.into_values().collect())
}
/// Builds the saved totals afresh, priced under `version`.
pub(super) fn rebuild(db: &Connection, pricer: Option<&Pricer>, version: Option<&str>) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM usage_counted; DELETE FROM usage_slots;")?;
    let mut fold = Fold::default();
    each_counted(
        &tx,
        "SELECT event_id,event_json FROM current_events",
        &origins(&tx)?,
        pricer,
        |event| {
            insert_counted(&tx, &event)?;
            fold.add(&event);
            Ok(())
        },
    )?;
    for slot in fold.0.values() {
        insert_slot(&tx, slot)?;
    }
    tx.execute(
        "INSERT INTO metadata(key,value) VALUES('slots_priced',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(&version)?],
    )?;
    stamp(&tx)?;
    tx.commit()?;
    Ok(())
}
/// The saved slot rows from `since` until before `until` (slots' first instants); all of them, undated too, without
/// either.
pub(super) fn read(db: &Connection, since: Option<i64>, until: Option<i64>) -> Result<Vec<Slot>> {
    let mut statement = db.prepare_cached(if since.is_some() || until.is_some() {
        "SELECT * FROM usage_slots WHERE slot>=? AND slot<?"
    } else {
        "SELECT * FROM usage_slots"
    })?;
    let mut rows = if since.is_some() || until.is_some() {
        statement.query([since.unwrap_or(i64::MIN), until.unwrap_or(i64::MAX)])?
    } else {
        statement.query([])?
    };
    let mut slots = Vec::new();
    while let Some(row) = rows.next()? {
        slots.push(read_slot(row)?);
    }
    Ok(slots)
}

/// The saved counted events by tool.
pub(super) fn counts(db: &Connection) -> Result<HashMap<ToolId, u64>> {
    let mut statement = db.prepare_cached("SELECT tool,SUM(events) FROM usage_slots GROUP BY tool")?;
    let mut rows = statement.query([])?;
    let mut counts = HashMap::new();
    while let Some(row) = rows.next()? {
        counts.insert(tool(row.get(0)?)?, count(row, 1)?);
    }
    Ok(counts)
}

/// The event ids a write may change the count of, gathered before and after it, inside its transaction.
pub(super) struct Touched<'a> {
    db: &'a Connection,
    lineage: bool,
}
impl<'a> Touched<'a> {
    /// Starts with `ids`, and the events they mirror as they are stored now.
    pub fn new(db: &'a Connection, ids: impl IntoIterator<Item = impl AsRef<str>>) -> Result<Self> {
        db.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS slots_touched(event_id TEXT PRIMARY KEY); DELETE FROM temp.slots_touched;",
        )?;
        let touched = Self { db, lineage: false };
        touched.add(ids)?;
        touched.add_mirrored()?;
        Ok(touched)
    }
    pub fn add(&self, ids: impl IntoIterator<Item = impl AsRef<str>>) -> Result<()> {
        let mut insert = self
            .db
            .prepare_cached("INSERT OR IGNORE INTO temp.slots_touched(event_id) VALUES(?)")?;
        for id in ids {
            insert.execute([id.as_ref()])?;
        }
        Ok(())
    }
    /// A Claude Code event is hidden while any current copy of its mirror names it.
    fn add_mirrored(&self) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO temp.slots_touched(event_id) SELECT DISTINCT json_extract(f.event_json,'$.claudeMirrorId') \
             FROM temp.slots_touched t CROSS JOIN file_events f ON f.event_id=t.event_id \
             WHERE json_extract(f.event_json,'$.claudeMirrorId') IS NOT NULL",
            [],
        )?;
        Ok(())
    }
    /// A lineage changed, so every event in one is counted again.
    pub fn lineage(&mut self) {
        self.lineage = true;
    }
    /// After the write: re-derives the touched events' rows and the slot rows they were or are now in.
    pub fn sync(self, pricer: Option<&Pricer>) -> Result<()> {
        let db = self.db;
        if priced_under(db)?.is_none() {
            return Ok(());
        }
        self.add_mirrored()?;
        let lineage = self.lineage
            || db.query_row(
                "SELECT EXISTS(SELECT 1 FROM temp.slots_touched t CROSS JOIN usage_origins o ON o.event_id=t.event_id)",
                [],
                |row| row.get(0),
            )?;
        let origins = if lineage {
            db.execute(
                "INSERT OR IGNORE INTO temp.slots_touched(event_id) SELECT event_id FROM usage_origins",
                [],
            )?;
            origins(db)?
        } else {
            Vec::new()
        };
        let mut keys: HashSet<Key> = HashSet::new();
        {
            let mut statement = db.prepare(
                "SELECT c.slot,c.day,c.tool,c.model,c.session_id,c.project FROM temp.slots_touched t \
                 CROSS JOIN usage_counted c ON c.event_id=t.event_id",
            )?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                keys.insert(key(row)?);
            }
        }
        db.execute(
            "DELETE FROM usage_counted WHERE event_id IN (SELECT event_id FROM temp.slots_touched)",
            [],
        )?;
        each_counted(
            db,
            "SELECT c.event_id,c.event_json FROM current_events c WHERE c.event_id IN (SELECT event_id FROM temp.slots_touched)",
            &origins,
            pricer,
            |event| {
                insert_counted(db, &event)?;
                keys.insert(event.key);
                Ok(())
            },
        )?;
        for key in &keys {
            let (session, slot, day, tool, model, project) = key_params(key);
            let mut fold: Option<Slot> = None;
            {
                let mut statement = db.prepare_cached(&format!("SELECT * FROM usage_counted WHERE {KEY_IS}"))?;
                let mut rows = statement.query(params![session, slot, day, tool, model, project])?;
                while let Some(row) = rows.next()? {
                    let event = read_counted(row, key.clone())?;
                    match &mut fold {
                        Some(slot) => slot.add(&event),
                        None => fold = Some(Slot::of(&event)),
                    }
                }
            }
            db.prepare_cached(&format!("DELETE FROM usage_slots WHERE {KEY_IS}"))?
                .execute(params![session, slot, day, tool, model, project])?;
            if let Some(slot) = fold {
                insert_slot(db, &slot)?;
            }
        }
        Ok(())
    }
}

/// Sums of slot rows, under the same overflow rule as summing events.
#[derive(Debug, Clone, Default)]
pub(super) struct Totals {
    events: u64,
    uncosted: u64,
    unparted: u64,
    tokens: [u64; 6],
    cost: u64,
    parts: CostParts,
    /// The smallest event id summed.
    pub first_id: Option<String>,
}
impl Totals {
    pub fn add(&mut self, slot: &Slot) -> Result<()> {
        self.events = sum([self.events, slot.events])?;
        self.uncosted += slot.uncosted;
        self.unparted += slot.unparted;
        for (total, count) in self.tokens.iter_mut().zip(slot.tokens) {
            *total = sum([*total, count])?;
        }
        self.cost = sum([self.cost, slot.cost])?;
        let part = |a: u64, b: u64| sum([a, b]);
        self.parts = CostParts {
            input: part(self.parts.input, slot.parts.input)?,
            output: part(self.parts.output, slot.parts.output)?,
            cache_read: part(self.parts.cache_read, slot.parts.cache_read)?,
            cache_write: part(self.parts.cache_write, slot.parts.cache_write)?,
            cache_savings: part(self.parts.cache_savings, slot.parts.cache_savings)?,
        };
        if self.first_id.as_ref().is_none_or(|first| slot.first_id < *first) {
            self.first_id = Some(slot.first_id.clone());
        }
        Ok(())
    }
    pub fn tokens(&self) -> Result<u64> {
        sum(self.tokens[..4].iter().copied())
    }
    /// Reasoning is always given; the one-hour cache-write part only when there is one.
    pub fn breakdown(&self) -> TokenCounts {
        let [input, output, cache_read, cache_write, cache_write_1h, reasoning] = self.tokens;
        TokenCounts {
            input,
            output,
            cache_read,
            cache_write,
            reasoning: Some(reasoning),
            cache_write_1h: (cache_write_1h > 0).then_some(cache_write_1h),
        }
    }
    /// `None` for no events or any event without a cost.
    pub fn cost(&self) -> Option<u64> {
        (self.events > 0 && self.uncosted == 0).then_some(self.cost)
    }
    /// `None` for no events or any event without cost parts.
    pub fn parts(&self) -> Option<CostParts> {
        (self.events > 0 && self.unparted == 0).then_some(self.parts)
    }
}
/// A slot row a query selected, with its day: UTC as written, or local in the query's zone; `None` undated.
pub(super) struct Dated {
    pub day: Option<String>,
    pub slot: Slot,
}
/// The rows' totals by `key`, in order of each group's first event id (as events in id order first show them).
pub(super) fn totals_by<'a, K: Eq + Hash + Clone>(
    rows: impl IntoIterator<Item = &'a Dated>,
    key: impl Fn(&Dated) -> K,
) -> Result<Vec<(K, Totals)>> {
    let mut groups: HashMap<K, Totals> = HashMap::new();
    for row in rows {
        groups.entry(key(row)).or_default().add(&row.slot)?;
    }
    let mut groups: Vec<(K, Totals)> = groups.into_iter().collect();
    groups.sort_by(|a, b| a.1.first_id.cmp(&b.1.first_id));
    Ok(groups)
}
/// The latest event among `slots` as [`later`] orders them: the slot holding it.
pub(super) fn latest<'a>(slots: impl IntoIterator<Item = &'a Slot>) -> Option<&'a Slot> {
    slots.into_iter().fold(None, |last: Option<&Slot>, slot| match last {
        Some(last)
            if !later(
                slot.last_at.as_deref(),
                &slot.last_id,
                last.last_at.as_deref(),
                &last.last_id,
            ) =>
        {
            Some(last)
        }
        _ => Some(slot),
    })
}
