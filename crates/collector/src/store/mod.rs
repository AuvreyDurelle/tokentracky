//! The SQLite usage store.
mod allowlist;
mod collate;
mod origins;
mod publication;
mod slots;
pub(crate) use origins::{UsageOrigin, complete_lineage, reconcile, relevant_lineage};

use crate::limits::{LimitReading, LimitWindow, window_names};
use allowlist::{allowlisted_checkpoint, allowlisted_event, allowlisted_limits, timestamp_ms, utf16_prefix};
use collate::locale_cmp;
use jiff::Timestamp;
use jiff::civil::{Date, Time};
use jiff::tz::TimeZone;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::time::Duration;
use time::{OffsetDateTime, UtcOffset};
use tokentracky_core::{
    BucketTool, CostParts, DayTokens, DayUsage, HourBreakdownRow, MAX_SAFE_INTEGER, ModelUsage, Period, ProjectSummary,
    PublicBucket, PublicHour, SessionSummary, SourceCapabilities, SourceState, SourceStatus, TOOL_IDS, TokenCounts,
    ToolId, ToolUsage, UsageBreakdownRow, UsageEvent, UsageSummary, activity_stats, checked_sum, is_public_model,
    is_utc_day, ranking_window, total_tokens,
};

/// `days` is a rolling window, which `offset` shifts back by that many days (e.g. the previous period); `from`/`to` are
/// inclusive days; `since`/`until` are instants in milliseconds, `[since, until)`. All exclude undated events.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryOptions {
    pub days: Option<i64>,
    /// Only with `days`.
    pub offset: Option<i64>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub since: Option<i64>,
    pub until: Option<i64>,
    /// `None` is every tool (`'all'` in TypeScript).
    pub tool: Option<ToolId>,
    pub q: Option<String>,
    pub now: Option<OffsetDateTime>,
    /// Days are local days in this zone (F3): `from`/`to`, `summary.daily` and its activity, and `breakdown`. `None`
    /// is UTC days. A rolling window is the same instants in every zone.
    pub tz: Option<TimeZone>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PublicationOptions {
    pub history_start: Option<String>,
    pub share_tools: bool,
    pub share_cost: bool,
    pub share_models: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationBatch {
    pub collector_id: String,
    pub checkpoint: u64,
    pub receipt: String,
    pub base_receipt: Option<String>,
    pub buckets: Vec<PublicBucket>,
    /// The leaderboard's 24-hour column as the batch was built. A batch saved by an older app has none.
    #[serde(default)]
    pub hours: Vec<PublicHour>,
}
/// The collector's identity and the shared revision counter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationState {
    pub collector_id: String,
    pub checkpoint: u64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicationSyncState {
    scope: String,
    acknowledged_receipt: Option<String>,
    pending: Option<PublicationBatch>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceConfiguration {
    pub enabled: bool,
    pub paths: Vec<String>,
}
/// Estimated cost, pricing version and cost by kind for one event, or `None` when its model has no known price.
pub type Pricer = Box<dyn Fn(&UsageEvent) -> Option<PricedCost> + Send>;
pub use tokentracky_pricing::PricedCost;
/// Today, this week from Monday, this month and all time in UTC or the requested local zone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodTotals {
    pub today: u64,
    pub week: u64,
    pub month: u64,
    pub all_time: u64,
    pub top_tool: Option<TopTool>,
}
/// The tool with the most tokens this week.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TopTool {
    pub tool: ToolId,
    pub tokens: u64,
}
/// A local day's tokens by half hour from its first instant (F3's chart of today): 48 slots, or 46 or 50 on a day the
/// clocks change by an hour (47 or 49 by half an hour). A slot is 30 minutes of elapsed time, so on the day the clocks
/// go back the repeated hour has its own two slots. A day whose length is not whole half hours ends with a shorter slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySeries {
    /// The day's first instant (`toISOString`).
    pub start: String,
    pub half_hours: Vec<u64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCheckpoint {
    pub path: String,
    pub tool: ToolId,
    pub identity: String,
    pub offset: u64,
    pub prefix_hash: String,
    pub parser_version: i64,
    /// The reader's parser state. Owned by `readers`; the store only bounds and allowlists its fields.
    pub state: Value,
    #[serde(default)]
    pub diagnostics: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctime_ms: Option<f64>,
}

/// Each message is the TypeScript error code, so callers and the local API map them unchanged.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("unsupported_database_version")]
    UnsupportedDatabaseVersion,
    #[error("collector_database_locked")]
    CollectorDatabaseLocked(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("unknown_source")]
    UnknownSource,
    #[error("invalid_source_configuration")]
    InvalidSourceConfiguration,
    #[error("invalid_checkpoint")]
    InvalidCheckpoint,
    #[error("invalid_usage_event")]
    InvalidUsageEvent,
    #[error("invalid_usage_limits")]
    InvalidUsageLimits,
    #[error("checkpoint_tool_mismatch")]
    CheckpointToolMismatch,
    #[error("aggregate_counter_overflow")]
    AggregateCounterOverflow,
    #[error("invalid_query_days")]
    InvalidQueryDays,
    #[error("invalid_query_range")]
    InvalidQueryRange,
    #[error("invalid_query_offset")]
    InvalidQueryOffset,
    #[error("invalid_history_start")]
    InvalidHistoryStart,
    #[error("accounting_history_incomplete")]
    AccountingHistoryIncomplete,
    #[error("publication_review_required")]
    PublicationReviewRequired,
    #[error("publication_receipt_mismatch")]
    PublicationReceiptMismatch,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
type Result<T> = std::result::Result<T, StoreError>;

const PERMISSION_REQUIRED: &str = "Permission required before reading local logs.";
const UNVERIFIED: &str = "Local usage format is not verified.";
const SCHEMA: &str = "BEGIN IMMEDIATE;
  CREATE TABLE sources(tool TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, paths TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, last_imported_at TEXT, message TEXT NOT NULL);
  CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO metadata VALUES('revision','0');
  CREATE TABLE files(path TEXT PRIMARY KEY, tool TEXT NOT NULL, checkpoint TEXT NOT NULL);
  CREATE TABLE file_events(path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, event_id TEXT NOT NULL, event_json TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(path,event_id));
  CREATE TABLE event_versions(event_id TEXT NOT NULL, event_json TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(event_id,event_json));
  CREATE INDEX file_events_identity ON file_events(event_id,revision);
  CREATE VIEW current_events AS SELECT f.event_id, f.event_json FROM file_events f
    WHERE NOT EXISTS(SELECT 1 FROM file_events newer WHERE newer.event_id=f.event_id AND (newer.revision>f.revision OR (newer.revision=f.revision AND newer.path>f.path)));
  CREATE TABLE public_buckets(scope TEXT NOT NULL, bucket_key TEXT NOT NULL, day TEXT, tool TEXT NOT NULL, tokens INTEGER NOT NULL, cost INTEGER, revision INTEGER NOT NULL, PRIMARY KEY(scope,bucket_key));
  PRAGMA user_version=1;
  COMMIT;";

/// What each adapter's records provide (`ADAPTERS[tool].capabilities`); `None` for a tool without an adapter.
fn capabilities(tool: ToolId) -> Option<SourceCapabilities> {
    crate::readers::adapter(tool).map(|adapter| adapter.capabilities)
}
/// A serde string enum (`ToolId`, `SourceState`, `BucketTool`) as its JSON text, and back.
fn text<T: Serialize>(value: T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(text)) => text,
        _ => unreachable!("string enums serialise to strings"),
    }
}
fn parse<T: for<'de> Deserialize<'de>>(text: String) -> Result<T> {
    Ok(serde_json::from_value(Value::String(text))?)
}
fn sum(values: impl IntoIterator<Item = u64>) -> Result<u64> {
    checked_sum(values).map_err(|_| StoreError::AggregateCounterOverflow)
}
fn tokens(events: &[&UsageEvent]) -> Result<u64> {
    sum(events.iter().map(|event| total_tokens(&event.tokens)))
}
/// The events' tokens by kind (`breakdown` on every summary type); `total_tokens` of it is [`tokens`]. Reasoning is
/// always given; the 1-hour cache-write part only when there is one.
fn kinds(events: &[&UsageEvent]) -> Result<TokenCounts> {
    let kind = |count: fn(&TokenCounts) -> u64| sum(events.iter().map(|event| count(&event.tokens)));
    let cache_write_1h = kind(|tokens| tokens.cache_write_1h.unwrap_or(0))?;
    Ok(TokenCounts {
        input: kind(|tokens| tokens.input)?,
        output: kind(|tokens| tokens.output)?,
        cache_read: kind(|tokens| tokens.cache_read)?,
        cache_write: kind(|tokens| tokens.cache_write)?,
        reasoning: Some(kind(|tokens| tokens.reasoning.unwrap_or(0))?),
        cache_write_1h: (cache_write_1h > 0).then_some(cache_write_1h),
    })
}
fn cost(events: &[&UsageEvent]) -> Result<Option<u64>> {
    if events.is_empty() || events.iter().any(|event| event.cost_microusd.is_none()) {
        return Ok(None);
    }
    sum(events.iter().filter_map(|event| event.cost_microusd)).map(Some)
}
/// An event's cost from the table, its parts, and the table version that priced it. Grok Build reports what xAI billed
/// each prompt, every long-context rate included: that cost stands, with no table version, split by
/// kind in the shares the table gives them (`None` where the table has no price for the model, which leaves the
/// reported cost without parts).
fn priced(event: &UsageEvent, pricer: Option<&Pricer>) -> Option<(u64, CostParts, Option<String>)> {
    let price = pricer.and_then(|pricer| pricer(event))?;
    Some(match event.cost_microusd.filter(|_| event.tool == ToolId::Grok) {
        Some(reported) => (reported, scaled(price.parts, reported), None),
        None => (price.cost_microusd, price.parts, Some(price.pricing_version)),
    })
}
/// `parts` scaled to add up to `total`, each kind keeping its share; what rounding leaves goes to the largest.
fn scaled(parts: CostParts, total: u64) -> CostParts {
    let kinds = [parts.input, parts.output, parts.cache_read, parts.cache_write].map(u128::from);
    let whole: u128 = kinds.iter().sum();
    if whole == 0 {
        return CostParts {
            input: total,
            ..CostParts::default()
        };
    }
    let share = |part: u128| u64::try_from(part * u128::from(total) / whole).unwrap_or(u64::MAX);
    let mut scaled = kinds.map(share);
    let largest = (0..4).max_by_key(|&at| (kinds[at], std::cmp::Reverse(at))).unwrap_or(0);
    scaled[largest] += total - scaled.iter().sum::<u64>();
    CostParts {
        input: scaled[0],
        output: scaled[1],
        cache_read: scaled[2],
        cache_write: scaled[3],
        cache_savings: share(u128::from(parts.cache_savings)),
    }
}
/// Groups in order of first appearance, as a JavaScript `Map` keeps them.
fn group<'a, K: Eq + Hash + Clone>(
    events: impl IntoIterator<Item = &'a UsageEvent>,
    key: impl Fn(&UsageEvent) -> K,
) -> Vec<(K, Vec<&'a UsageEvent>)> {
    let mut index = HashMap::<K, usize>::new();
    let mut groups: Vec<(K, Vec<&'a UsageEvent>)> = Vec::new();
    for event in events {
        let id = key(event);
        match index.get(&id) {
            Some(&at) => groups[at].1.push(event),
            None => {
                index.insert(id.clone(), groups.len());
                groups.push((id, vec![event]));
            }
        }
    }
    groups
}
/// Tokens per UTC hour and tool, `tool` as the day buckets name it, for the 24 whole hours before `now` and the hour
/// under way. The host sums whole hours, so the hour under way counts once it has ended.
fn public_hours(
    events: &[UsageEvent],
    now: OffsetDateTime,
    tool: impl Fn(&UsageEvent) -> BucketTool,
) -> Result<Vec<PublicHour>> {
    const HOUR: i64 = 3_600_000;
    let current = (now.unix_timestamp_nanos().div_euclid(1_000_000) as i64).div_euclid(HOUR) * HOUR;
    let hour = |event: &UsageEvent| {
        event
            .occurred_at
            .as_deref()
            .and_then(timestamp_ms)
            .map(|at| at.div_euclid(HOUR) * HOUR)
    };
    let recent = events
        .iter()
        .filter(|event| hour(event).is_some_and(|at| (current - 24 * HOUR..=current).contains(&at)));
    let mut hours = group(recent, |event| (hour(event).unwrap_or_default(), tool(event)))
        .into_iter()
        .map(|((at, tool), items)| {
            let at = Timestamp::from_millisecond(at).map_err(|_| StoreError::InvalidQueryRange)?;
            Ok(PublicHour {
                hour: format!("{at:.3}"),
                tool,
                tokens: tokens(&items)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    hours.sort_by(|a, b| {
        a.hour
            .cmp(&b.hour)
            .then_with(|| locale_cmp(&text(a.tool), &text(b.tool)))
    });
    Ok(hours)
}
/// Distinct sessions (each tool's own) among slot rows.
fn sessions_of<'a>(rows: impl Iterator<Item = &'a slots::Dated>) -> u32 {
    rows.map(|row| (row.slot.key.tool, row.slot.key.session_id.as_str()))
        .collect::<HashSet<_>>()
        .len() as u32
}
/// The UTC day of a timestamp (`occurredAt.slice(0, 10)`).
fn day(event: &UsageEvent) -> Option<&str> {
    event.occurred_at.as_deref().map(|at| utf16_prefix(at, 10))
}
fn iso_day(now: OffsetDateTime) -> String {
    now.to_offset(UtcOffset::UTC).date().to_string()
}
/// [`day`], or with a zone the local day there of the event's instant.
fn local_day<'a>(event: &'a UsageEvent, tz: Option<&TimeZone>) -> Option<Cow<'a, str>> {
    let Some(tz) = tz else {
        return day(event).map(Cow::Borrowed);
    };
    let at = event.occurred_at.as_deref().and_then(timestamp_ms)?;
    Some(Cow::Owned(local_date(at, tz)?.to_string()))
}
/// The local date in `tz` of an instant in milliseconds; `None` outside the years jiff holds (±9999).
fn local_date(ms: i64, tz: &TimeZone) -> Option<time::Date> {
    let offset = tz.to_offset(Timestamp::from_millisecond(ms).ok()?).seconds();
    let days = (ms + i64::from(offset) * 1000).div_euclid(86_400_000);
    // 1970-01-01 is Julian day 2,440,588.
    time::Date::from_julian_day(i32::try_from(days).ok()? + 2_440_588).ok()
}
fn local_today(now: OffsetDateTime, tz: &TimeZone) -> time::Date {
    let now = now.unix_timestamp_nanos().div_euclid(1_000_000) as i64;
    local_date(now, tz).expect("a clock reads a year jiff holds")
}
/// Today: the UTC day of `now`, or its local day in a zone.
fn today(now: OffsetDateTime, tz: Option<&TimeZone>) -> String {
    tz.map_or_else(|| iso_day(now), |tz| local_today(now, tz).to_string())
}
/// A query's rolling window in milliseconds, `[cutoff, end)`, either end open; the options checked first.
fn window(options: &QueryOptions) -> Result<(Option<i128>, Option<i128>)> {
    if options
        .days
        .is_some_and(|days| days <= 0 || days.unsigned_abs() > MAX_SAFE_INTEGER)
    {
        return Err(StoreError::InvalidQueryDays);
    }
    let valid = |day: &Option<String>| day.as_deref().is_none_or(is_utc_day);
    if !valid(&options.from)
        || !valid(&options.to)
        || matches!((&options.from, &options.to), (Some(from), Some(to)) if from > to)
    {
        return Err(StoreError::InvalidQueryRange);
    }
    if matches!((options.since, options.until), (Some(since), Some(until)) if since >= until) {
        return Err(StoreError::InvalidQueryRange);
    }
    if options
        .offset
        .is_some_and(|offset| offset < 0 || offset.unsigned_abs() > MAX_SAFE_INTEGER || options.days.is_none())
    {
        return Err(StoreError::InvalidQueryOffset);
    }
    let now = options.now.unwrap_or_else(OffsetDateTime::now_utc);
    let now = now.unix_timestamp_nanos().div_euclid(1_000_000);
    let offset = i128::from(options.offset.unwrap_or(0));
    let cutoff = options.days.map(|days| now - (i128::from(days) + offset) * 86_400_000);
    let end = (offset != 0).then(|| now - offset * 86_400_000);
    // `since`/`until` narrow it further.
    let cutoff = [cutoff, options.since.map(i128::from)].into_iter().flatten().max();
    let end = [end, options.until.map(i128::from)].into_iter().flatten().min();
    Ok((cutoff, end))
}
fn revision(db: &Connection) -> Result<u64> {
    let value: String = db.query_row("SELECT value FROM metadata WHERE key='revision'", [], |row| row.get(0))?;
    value.parse().map_err(|_| StoreError::AggregateCounterOverflow)
}
/// The next value of the one counter that event commits and bucket projections share.
fn next_revision(db: &Connection) -> Result<u64> {
    let next = sum([revision(db)?, 1])?;
    db.execute("UPDATE metadata SET value=? WHERE key='revision'", [next.to_string()])?;
    Ok(next)
}
/// Owner-only permissions for the database and its lock.
fn restrict(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
/// A separate SQLite exclusive transaction is an OS-released lifetime lock. Unlike PID files it cannot be stolen
/// by competing stale-lock reclaimers. Dropping the connection rolls the transaction back and releases it.
fn acquire_lock(database: &Path) -> Result<Connection> {
    if let Some(directory) = database.parent() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(directory)?;
    }
    let mut path = database.as_os_str().to_owned();
    path.push(".collector-lock.sqlite");
    let path = PathBuf::from(path);
    let owner = Connection::open(&path)?;
    restrict(&path).map_err(|error| StoreError::CollectorDatabaseLocked(error.into()))?;
    owner
        .execute_batch(
            "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS collector_owner(id INTEGER);",
        )
        .map_err(|error| StoreError::CollectorDatabaseLocked(error.into()))?;
    Ok(owner)
}

/// Reads of all history kept until usage changes (P5 Task 3.2).
#[derive(Default)]
struct Cache {
    /// `(epoch, zone, day)`, the day being UTC or local in the zone, and the totals then.
    period: Option<(u64, Option<TimeZone>, String, PeriodTotals)>,
}

/// Persisted allowlisted metadata only. Own one instance per database; close it before reopening.
pub struct UsageStore {
    db: Connection,
    /// Declared after `db`, so the database closes before the lock is released.
    _owner: Option<Connection>,
    pricer: Option<Pricer>,
    /// The price table version `pricer` prices with.
    pricing: Option<String>,
    /// Advances whenever this store writes usage or changes its prices.
    epoch: u64,
    /// `None` for a read-only store, whose usage another process writes.
    cache: Option<RefCell<Cache>>,
}

impl UsageStore {
    /// Opens or creates the database and takes the single-writer lock beside it; `":memory:"` takes no lock.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let memory = path == Path::new(":memory:");
        let owner = if memory {
            None
        } else {
            Some(acquire_lock(&std::path::absolute(path)?)?)
        };
        let mut db = Connection::open(path)?;
        if !memory {
            restrict(path)?;
        }
        db.execute_batch(
            // A memory-mapped read of all history took 0.29 s against 7–9 s through the page cache (25 Oct 2026).
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; \
             PRAGMA mmap_size = 268435456;",
        )?;
        Self::migrate(&mut db)?;
        // Another version may have written usage without updating the saved totals; they are then built again.
        if slots::priced_under(&db)?.is_some() && !slots::stamped(&db)? {
            slots::discard(&db)?;
        }
        db.execute(
            "INSERT OR IGNORE INTO metadata(key,value) VALUES('collector_id',?)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        Ok(Self {
            db,
            _owner: owner,
            pricer: None,
            pricing: None,
            epoch: 0,
            cache: Some(RefCell::default()),
        })
    }
    /// Opens an existing database without the owner lock, for status readers alongside a running collector (WAL
    /// allows concurrent readers). Every write fails in this mode.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let db = Connection::open_with_flags(path, flags)?;
        // The TypeScript reader keeps node:sqlite's default of no busy wait.
        db.busy_timeout(Duration::ZERO)?;
        db.pragma_update(None, "mmap_size", 268_435_456)?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != 1 {
            return Err(StoreError::UnsupportedDatabaseVersion);
        }
        Ok(Self {
            db,
            _owner: None,
            pricer: None,
            pricing: None,
            epoch: 0,
            cache: None,
        })
    }
    fn migrate(db: &mut Connection) -> Result<()> {
        let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 1 {
            return Err(StoreError::UnsupportedDatabaseVersion);
        }
        if version == 0 {
            db.execute_batch(SCHEMA)?;
        }
        // Additive local metadata migration: old event/checkpoint/publication revisions remain intact.
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_origins(event_id TEXT PRIMARY KEY, node TEXT NOT NULL, parent TEXT)",
        )?;
        // Local-only usage limits (F6): read by the Limits page alone, never by the upload projection.
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_limits(tool TEXT NOT NULL, name TEXT NOT NULL, used_percent REAL NOT NULL, window_minutes INTEGER, resets_at_ms INTEGER, as_of_ms INTEGER NOT NULL, PRIMARY KEY(tool,name))",
        )?;
        publication::migrate(db)?;
        db.execute_batch(slots::SCHEMA)?;
        // Resolve proven OmO/Claude mirrors in the shared projection, before source counts, local queries or public
        // totals. Latest physical copies still win, and removing the OmO record restores the Claude fallback.
        // Unary + removes the RHS column affinity so SQLite can seek the expression index rather than scan it.
        let mirrors: bool = db.query_row(
            "SELECT instr(sql, '=+f.event_id') > 0 FROM sqlite_master WHERE name='current_events'",
            [],
            |row| row.get(0),
        )?;
        if !mirrors {
            db.execute_batch("BEGIN IMMEDIATE;
                CREATE INDEX IF NOT EXISTS file_events_claude_mirror ON file_events(json_extract(event_json,'$.claudeMirrorId'));
                DROP VIEW current_events;
                CREATE VIEW current_events AS SELECT f.event_id, f.event_json FROM file_events f
                WHERE NOT EXISTS(SELECT 1 FROM file_events newer WHERE newer.event_id=f.event_id AND
                    (newer.revision>f.revision OR (newer.revision=f.revision AND newer.path>f.path)))
                AND NOT EXISTS(SELECT 1 FROM file_events mirror
                    WHERE json_extract(mirror.event_json,'$.claudeMirrorId')=+f.event_id
                    AND NOT EXISTS(SELECT 1 FROM file_events newer WHERE newer.event_id=mirror.event_id AND
                        (newer.revision>mirror.revision OR (newer.revision=mirror.revision AND newer.path>mirror.path))));
                COMMIT;")?;
        }
        // Additive: each public bucket's kinds as canonical JSON, kept beside its tokens and cost. An upgraded store
        // holds NULL kinds, so every bucket gets one new revision and is uploaded once more, now with its kinds.
        let has_kinds: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('public_buckets') WHERE name='kinds')",
            [],
            |row| row.get(0),
        )?;
        if !has_kinds {
            db.execute_batch("ALTER TABLE public_buckets ADD COLUMN kinds TEXT")?;
        }
        // Every tool has a source row. A tool that gains an adapter starts again from explicit permission.
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for &tool in TOOL_IDS {
            let supported = capabilities(tool).is_some();
            let (state, message) = if supported {
                ("permission_required", PERMISSION_REQUIRED)
            } else {
                ("unsupported", UNVERIFIED)
            };
            tx.execute(
                "INSERT OR IGNORE INTO sources(tool,state,message) VALUES(?,?,?)",
                params![text(tool), state, message],
            )?;
            if supported {
                tx.execute("UPDATE sources SET enabled=0,paths='[]',state='permission_required',message=? WHERE tool=? AND state='unsupported'", params![PERMISSION_REQUIRED, text(tool)])?;
            }
        }
        Ok(tx.commit()?)
    }

    pub fn publication_state(&self) -> Result<PublicationState> {
        let collector_id = self
            .db
            .query_row("SELECT value FROM metadata WHERE key='collector_id'", [], |row| {
                row.get(0)
            })?;
        Ok(PublicationState {
            collector_id,
            checkpoint: revision(&self.db)?,
        })
    }
    fn publication_sync_state(&self, scope: &str) -> Result<PublicationSyncState> {
        let saved: Option<String> = self
            .db
            .query_row("SELECT state FROM publication_scopes WHERE scope=?", [scope], |row| {
                row.get(0)
            })
            .optional()?;
        let saved = saved
            .map(|value| serde_json::from_str::<PublicationSyncState>(&value))
            .transpose()?;
        Ok(saved
            .filter(|saved| saved.scope == scope)
            .unwrap_or_else(|| PublicationSyncState {
                scope: scope.to_owned(),
                ..Default::default()
            }))
    }
    /// The batch to upload to `scope`: frozen until acknowledged, so every retry sends the same content.
    pub fn pending_publication(&mut self, scope: &str, options: &PublicationOptions) -> Result<PublicationBatch> {
        self.ensure_publication_scope_ready(scope)?;
        let saved = self.publication_sync_state(scope)?;
        if let Some(pending) = saved.pending {
            return Ok(pending);
        }
        let (buckets, hours) = self.project_publication(options, OffsetDateTime::now_utc())?;
        let state = self.publication_state()?;
        let pending = PublicationBatch {
            collector_id: state.collector_id,
            checkpoint: state.checkpoint,
            receipt: uuid::Uuid::new_v4().to_string(),
            base_receipt: saved.acknowledged_receipt.clone(),
            buckets,
            hours,
        };
        let value = serde_json::to_string(&PublicationSyncState {
            pending: Some(pending.clone()),
            ..saved
        })?;
        self.save_publication_sync(scope, &value)?;
        Ok(pending)
    }
    pub fn acknowledge_publication(&mut self, scope: &str, receipt: &str) -> Result<()> {
        self.ensure_publication_scope_ready(scope)?;
        let saved = self.publication_sync_state(scope)?;
        if saved.pending.as_ref().map(|pending| pending.receipt.as_str()) != Some(receipt) {
            return Err(StoreError::PublicationReceiptMismatch);
        }
        let acknowledged = PublicationSyncState {
            scope: scope.to_owned(),
            acknowledged_receipt: Some(receipt.to_owned()),
            pending: None,
        };
        self.save_publication_sync(scope, &serde_json::to_string(&acknowledged)?)?;
        Ok(())
    }

    pub fn get_source_configuration(&self, tool: ToolId) -> Result<SourceConfiguration> {
        let row: Option<(bool, String)> = self
            .db
            .query_row("SELECT enabled,paths FROM sources WHERE tool=?", [text(tool)], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        let (enabled, paths) = row.ok_or(StoreError::UnknownSource)?;
        Ok(SourceConfiguration {
            enabled,
            paths: serde_json::from_str(&paths)?,
        })
    }
    /// Low-level persistence; the ingestion service validates paths.
    pub fn save_source_configuration(&mut self, tool: ToolId, configuration: &SourceConfiguration) -> Result<()> {
        if configuration
            .paths
            .iter()
            .any(|path| path.is_empty() || path.contains('\0'))
        {
            return Err(StoreError::InvalidSourceConfiguration);
        }
        let (state, message) = match (capabilities(tool).is_some(), configuration.enabled) {
            (false, _) => (SourceState::Unsupported, UNVERIFIED),
            (true, true) => (SourceState::Detected, "Source enabled; awaiting scan."),
            (true, false) => (SourceState::Paused, "Source paused."),
        };
        self.db.execute(
            "UPDATE sources SET enabled=?,paths=?,state=?,message=? WHERE tool=?",
            params![
                configuration.enabled,
                serde_json::to_string(&configuration.paths)?,
                text(state),
                message,
                text(tool)
            ],
        )?;
        Ok(())
    }
    /// Messages are caller-owned diagnostic codes or fixed strings, never filesystem errors.
    pub fn set_source_state(
        &mut self,
        tool: ToolId,
        state: SourceState,
        message: &str,
        imported_at: Option<&str>,
    ) -> Result<()> {
        self.db.execute(
            "UPDATE sources SET state=?,message=?,last_imported_at=COALESCE(?,last_imported_at) WHERE tool=?",
            params![text(state), message, imported_at, text(tool)],
        )?;
        Ok(())
    }
    /// A number that advances whenever this store writes usage (events, withdrawals, origins, a forgotten file) or
    /// changes its pricer. Reads of all history are cached under it.
    pub fn usage_epoch(&self) -> u64 {
        self.epoch
    }
    pub fn source_statuses(&self) -> Result<Vec<SourceStatus>> {
        let unvalidated = self.unvalidated_database_tools()?;
        // Events with tokens, by tool (each lineage once where origins are known).
        let counts = self.event_counts()?;
        let local_only_kilo = self.has_local_only_kilo()?;
        let mut statement = self.db.prepare("SELECT * FROM sources ORDER BY tool")?;
        let mut rows = statement.query([])?;
        let mut statuses = Vec::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get("tool")?;
            let tool: ToolId = parse(id.clone())?;
            let state = parse(row.get("state")?)?;
            let awaiting_scan = state == SourceState::Current && unvalidated.contains(&id);
            statuses.push(SourceStatus {
                id: tool,
                name: tool.name().to_owned(),
                enabled: row.get("enabled")?,
                state: if awaiting_scan { SourceState::Stale } else { state },
                paths: serde_json::from_str(&row.get::<_, String>("paths")?)?,
                last_imported_at: row.get("last_imported_at")?,
                event_count: counts.get(&tool).copied().unwrap_or(0),
                message: if awaiting_scan {
                    "Database accounting needs a scan after upgrade. Local totals are provisional; leaderboard sync is paused until history is verified.".to_owned()
                } else if tool == ToolId::Kilo && local_only_kilo {
                    format!("{} Kilo database history is local-only because import and fork provenance cannot be verified. Local totals and CSV retain it; Roo and Kilo v5 task histories remain eligible for leaderboard sharing.", row.get::<_, String>("message")?)
                } else {
                    row.get("message")?
                },
                capabilities: capabilities(tool).unwrap_or_default(),
            });
        }
        Ok(statuses)
    }
    /// Events with tokens, by tool (each lineage once where origins are known).
    fn event_counts(&self) -> Result<HashMap<ToolId, u64>> {
        if self.saved_slots(false)? {
            return slots::counts(&self.db);
        }
        let mut counts: HashMap<ToolId, u64> = HashMap::new();
        for slot in self.slot_rows(None, None, false)? {
            *counts.entry(slot.key.tool).or_default() += slot.events;
        }
        Ok(counts)
    }
    fn unvalidated_database_tools(&self) -> Result<HashSet<String>> {
        // Parser v4 establishes the Kilo v1 publication boundary as well as v3 lineage checks. Old receipts wait
        // for revalidation, including paused sources and read-only clients opening pre-migration stores.
        Ok(self.db.prepare("SELECT DISTINCT tool FROM files WHERE tool IN ('opencode','kilo') AND json_extract(checkpoint,'$.path') LIKE '%.db' AND COALESCE(json_extract(checkpoint,'$.parserVersion'),0) < 4")?
            .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
    }
    pub fn last_scan_at(&self) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT value FROM metadata WHERE key='last_scan_at'", [], |row| {
                row.get(0)
            })
            .optional()?)
    }
    pub fn set_last_scan_at(&mut self, timestamp: &str) -> Result<()> {
        self.db.execute(
            "INSERT INTO metadata(key,value) VALUES('last_scan_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [timestamp],
        )?;
        Ok(())
    }
    /// `setupCompleted`: the first launch has turned tools on, or found a source configured before; it never turns
    /// tools on again.
    pub fn setup_completed(&self) -> Result<bool> {
        Ok(self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM metadata WHERE key='setup_completed')",
            [],
            |row| row.get(0),
        )?)
    }
    pub fn complete_setup(&mut self) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO metadata(key,value) VALUES('setup_completed','true')",
            [],
        )?;
        Ok(())
    }
    /// Folders detection has given an enabled source, so one removed by hand is not given again.
    pub fn offered_folders(&self) -> Result<Vec<String>> {
        let value: Option<String> = self
            .db
            .query_row("SELECT value FROM metadata WHERE key='offered_folders'", [], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(value
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or_default())
    }
    pub fn set_offered_folders(&mut self, folders: &[String]) -> Result<()> {
        self.db.execute(
            "INSERT INTO metadata(key,value) VALUES('offered_folders',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(folders)?],
        )?;
        Ok(())
    }
    /// The checkpoint of `path` as read for `tool`, or for any tool (the first by id) when `tool` is `None`.
    pub fn checkpoint(&self, path: &str, tool: Option<ToolId>) -> Result<Option<FileCheckpoint>> {
        let row: Option<String> = match tool {
            Some(tool) => self
                .db
                .query_row(
                    "SELECT checkpoint FROM files WHERE path=?",
                    [format!("{}:{path}", text(tool))],
                    |row| row.get(0),
                )
                .optional()?,
            None => self
                .db
                .query_row(
                    "SELECT checkpoint FROM files WHERE json_extract(checkpoint,'$.path')=? ORDER BY tool LIMIT 1",
                    [path],
                    |row| row.get(0),
                )
                .optional()?,
        };
        Ok(row.map(|checkpoint| serde_json::from_str(&checkpoint)).transpose()?)
    }
    /// `fileEvents`: events stored for one file, including those it no longer contains but still counts.
    pub fn file_events(&self, path: &str, tool: ToolId) -> Result<Vec<UsageEvent>> {
        let mut statement = self.db.prepare("SELECT event_json FROM file_events WHERE path=?")?;
        let rows = statement
            .query_map([format!("{}:{path}", text(tool))], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows
            .iter()
            .map(|event| serde_json::from_str(event))
            .collect::<serde_json::Result<_>>()?)
    }
    /// The current events of one tool, from every file: each event id once, at its latest revision.
    pub fn tool_events(&self, tool: ToolId) -> Result<Vec<UsageEvent>> {
        let mut statement = self
            .db
            .prepare("SELECT event_json FROM current_events WHERE json_extract(event_json,'$.tool')=?")?;
        let rows = statement
            .query_map([text(tool)], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows
            .iter()
            .map(|event| serde_json::from_str(event))
            .collect::<serde_json::Result<_>>()?)
    }
    /// Withdraws a file's events and checkpoint, so the file is read afresh if it is needed again.
    pub fn forget_file(&mut self, path: &str, tool: ToolId) -> Result<()> {
        let file_key = format!("{}:{path}", text(tool));
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let touched = if slots::kept(&tx, self.pricing.as_deref())? {
            let ids = tx
                .prepare("SELECT event_id FROM file_events WHERE path=?")?
                .query_map([&file_key], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Some(slots::Touched::new(&tx, ids)?)
        } else {
            None
        };
        tx.execute("DELETE FROM files WHERE path=?", [&file_key])?;
        if let Some(touched) = touched {
            touched.sync(self.pricer.as_ref())?;
            slots::stamp(&tx)?;
        }
        tx.commit()?;
        self.epoch += 1;
        Ok(())
    }
    /// Events and checkpoint commit together. Replacements remove records lost to edits or truncation.
    pub fn commit_file(&mut self, checkpoint: &FileCheckpoint, events: &[UsageEvent], replace: bool) -> Result<()> {
        self.commit_file_withdrawing(checkpoint, events, replace, &[])
    }
    /// `commitFile` with its `withdrawn` argument: those event ids are removed from the file in any case, even where a
    /// ledger otherwise keeps usage it has seen.
    pub fn commit_file_withdrawing(
        &mut self,
        checkpoint: &FileCheckpoint,
        events: &[UsageEvent],
        replace: bool,
        withdrawn: &[String],
    ) -> Result<()> {
        self.commit_with_origins(checkpoint, events, replace, withdrawn, &[])
    }
    pub(crate) fn commit_with_origins(
        &mut self,
        checkpoint: &FileCheckpoint,
        events: &[UsageEvent],
        replace: bool,
        withdrawn: &[String],
        origins: &[UsageOrigin],
    ) -> Result<()> {
        let safe_checkpoint = allowlisted_checkpoint(checkpoint)?;
        let file_key = format!("{}:{}", text(checkpoint.tool), checkpoint.path);
        // The last copy of an event id wins, at the position of its first.
        let mut normalized: Vec<UsageEvent> = Vec::new();
        let mut index = HashMap::new();
        for event in events.iter().map(allowlisted_event) {
            let event = event?;
            match index.get(&event.event_id) {
                Some(&at) => normalized[at] = event,
                None => {
                    index.insert(event.event_id.clone(), normalized.len());
                    normalized.push(event);
                }
            }
        }
        if normalized.iter().any(|event| event.tool != checkpoint.tool) {
            return Err(StoreError::CheckpointToolMismatch);
        }
        // Whether usage changed, so cached reads of all history stay valid otherwise.
        let mut written = replace || !withdrawn.is_empty() || !origins.is_empty();
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut touched = None;
        {
            let mut statement = tx.prepare("SELECT event_id,event_json,revision FROM file_events WHERE path=?")?;
            let previous = statement
                .query_map([&file_key], |row| {
                    Ok((row.get::<_, String>(0)?, (row.get::<_, String>(1)?, row.get(2)?)))
                })?
                .collect::<rusqlite::Result<HashMap<String, (String, i64)>>>()?;
            let jsons = normalized
                .iter()
                .map(serde_json::to_string)
                .collect::<serde_json::Result<Vec<_>>>()?;
            // The events whose stored rows this write adds, changes or removes, for the saved totals.
            if slots::kept(&tx, self.pricing.as_deref())? {
                let changed = normalized
                    .iter()
                    .zip(&jsons)
                    .filter(|(event, json)| previous.get(&event.event_id).is_none_or(|(old, _)| old != *json))
                    .map(|(event, _)| event.event_id.as_str());
                let removed = previous
                    .keys()
                    .filter(|id| replace && !index.contains_key(*id))
                    .map(String::as_str);
                let ids = changed.chain(removed).chain(withdrawn.iter().map(String::as_str));
                touched = Some(slots::Touched::new(&tx, ids)?);
            }
            tx.execute(
                "INSERT INTO files(path,tool,checkpoint) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET tool=excluded.tool,checkpoint=excluded.checkpoint",
                params![file_key, text(checkpoint.tool), serde_json::to_string(&safe_checkpoint)?],
            )?;
            publication::exclude(&tx, &file_key, checkpoint, previous.keys(), normalized.iter())?;
            if replace {
                tx.execute("DELETE FROM file_events WHERE path=?", [&file_key])?;
            }
            let mut withdraw = tx.prepare("DELETE FROM file_events WHERE path=? AND event_id=?")?;
            for id in withdrawn {
                withdraw.execute(params![file_key, id])?;
            }
            let mut put = tx.prepare("INSERT INTO file_events(path,event_id,event_json,revision) VALUES(?,?,?,?) ON CONFLICT(path,event_id) DO UPDATE SET event_json=excluded.event_json,revision=excluded.revision")?;
            let mut known = tx.prepare("SELECT revision FROM event_versions WHERE event_id=? AND event_json=?")?;
            let mut version = tx.prepare("INSERT INTO event_versions(event_id,event_json,revision) VALUES(?,?,?) ON CONFLICT(event_id,event_json) DO UPDATE SET revision=excluded.revision")?;
            for (event, json) in normalized.iter().zip(jsons) {
                let old = previous.get(&event.event_id);
                let unchanged = old.filter(|(old, _)| *old == json).map(|&(_, revision)| revision);
                // Whole sources (documents, databases) are re-read in full; an unchanged event needs no write.
                if !replace && unchanged.is_some() {
                    continue;
                }
                let known: Option<i64> = known
                    .query_row(params![event.event_id, json], |row| row.get(0))
                    .optional()?;
                // A second physical copy of the same record must not supersede a correction.
                let revision = match (unchanged, old, known) {
                    (Some(revision), _, _) | (None, None, Some(revision)) => revision,
                    _ => next_revision(&tx)? as i64,
                };
                version.execute(params![event.event_id, json, revision])?;
                put.execute(params![file_key, event.event_id, json, revision])?;
                written = true;
            }
        }
        for origin in origins {
            // Only bounded hashes and the already allowlisted event id reach this local table.
            let hash = |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
            if !hash(&origin.node)
                || !origin.parent.as_deref().is_none_or(hash)
                || !index.contains_key(&origin.event_id)
            {
                return Err(StoreError::InvalidUsageEvent);
            }
            let changed = tx.execute(
                "INSERT INTO usage_origins(event_id,node,parent) VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET node=excluded.node,parent=excluded.parent WHERE node IS NOT excluded.node OR parent IS NOT excluded.parent",
                params![origin.event_id, origin.node, origin.parent],
            )?;
            if changed > 0
                && let Some(touched) = &mut touched
            {
                touched.lineage();
            }
        }
        if let Some(touched) = touched {
            if written {
                touched.sync(self.pricer.as_ref())?;
            }
            slots::stamp(&tx)?;
        }
        tx.commit()?;
        self.epoch += u64::from(written);
        Ok(())
    }
    fn canonical_events(&self) -> Result<Vec<UsageEvent>> {
        let mut statement = self
            .db
            .prepare("SELECT event_json FROM current_events ORDER BY event_id")?;
        let events = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<Vec<_>>>()?;
        Ok(reconcile(events, &self.usage_origins()?))
    }
    pub(crate) fn usage_origins(&self) -> Result<Vec<UsageOrigin>> {
        // Read-only clients may open a pre-migration store alongside an older collector.
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='usage_origins')",
            [],
            |row| row.get(0),
        )?;
        Ok(if exists {
            self.db
                .prepare("SELECT event_id,node,parent FROM usage_origins")?
                .query_map([], |row| {
                    Ok(UsageOrigin {
                        event_id: row.get(0)?,
                        node: row.get(1)?,
                        parent: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            Vec::new()
        })
    }
    /// The latest usage-limit reading of each tool that has one (F6), in tool order, each window in its tool's order.
    /// Local only: no upload or publication reads it.
    pub fn limits(&self) -> Result<Vec<LimitReading>> {
        // Read-only clients may open a store an older collector wrote.
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='usage_limits')",
            [],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(Vec::new());
        }
        let mut statement = self.db.prepare(
            "SELECT tool,name,used_percent,window_minutes,resets_at_ms,as_of_ms FROM usage_limits ORDER BY tool",
        )?;
        let rows = statement
            .query_map([], |row| {
                let window = LimitWindow {
                    name: row.get(1)?,
                    used_percent: row.get(2)?,
                    window_minutes: row.get::<_, Option<i64>>(3)?.map(|minutes| minutes as u64),
                    resets_at_ms: row.get(4)?,
                };
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(5)?, window))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut readings: Vec<LimitReading> = Vec::new();
        for (tool, as_of_ms, window) in rows {
            let tool: ToolId = parse(tool)?;
            match readings.last_mut().filter(|reading| reading.tool == tool) {
                Some(reading) => reading.windows.push(window),
                None => readings.push(LimitReading {
                    tool,
                    as_of_ms,
                    windows: vec![window],
                }),
            }
        }
        for reading in &mut readings {
            let names = window_names(reading.tool);
            reading
                .windows
                .sort_by_key(|window| names.iter().position(|name| *name == window.name));
        }
        Ok(readings)
    }
    /// Replaces `tool`'s usage-limit reading; `None` clears it (Claude Code's: whatever its file holds now).
    pub fn replace_limits(&mut self, tool: ToolId, reading: Option<&LimitReading>) -> Result<()> {
        let reading = reading.map(allowlisted_limits).transpose()?;
        if reading.as_ref().is_some_and(|reading| reading.tool != tool) {
            return Err(StoreError::InvalidUsageLimits);
        }
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM usage_limits WHERE tool=?", [text(tool)])?;
        if let Some(reading) = &reading {
            let mut put = tx.prepare("INSERT INTO usage_limits(tool,name,used_percent,window_minutes,resets_at_ms,as_of_ms) VALUES(?,?,?,?,?,?)")?;
            for window in &reading.windows {
                put.execute(params![
                    text(tool),
                    window.name,
                    window.used_percent,
                    window.window_minutes.map(|minutes| minutes as i64),
                    window.resets_at_ms,
                    reading.as_of_ms
                ])?;
            }
        }
        Ok(tx.commit()?)
    }
    /// Keeps `reading` unless the tool's stored one was taken later (Codex: the latest snapshot of any rollout).
    pub fn update_limits(&mut self, reading: &LimitReading) -> Result<()> {
        let reading = allowlisted_limits(reading)?;
        let stored: Option<i64> = self.db.query_row(
            "SELECT MAX(as_of_ms) FROM usage_limits WHERE tool=?",
            [text(reading.tool)],
            |row| row.get(0),
        )?;
        if stored.is_some_and(|stored| stored > reading.as_of_ms) {
            return Ok(());
        }
        self.replace_limits(reading.tool, Some(&reading))
    }
    /// Preserve local provisional data and pending receipts, but never upload unresolved lineage.
    pub fn ensure_publication_ready(&self) -> Result<()> {
        let sql = if self.has_publication_provenance()? {
            "SELECT EXISTS(SELECT 1 FROM files, json_each(files.checkpoint,'$.diagnostics') d WHERE d.value='fork_lineage_unavailable' AND files.path NOT IN (SELECT path FROM local_only_files))"
        } else {
            "SELECT EXISTS(SELECT 1 FROM files, json_each(files.checkpoint,'$.diagnostics') d WHERE d.value='fork_lineage_unavailable')"
        };
        let incomplete: bool = self.db.query_row(sql, [], |r| r.get(0))?;
        if incomplete || !self.unvalidated_database_tools()?.is_empty() || !self.complete_public_lineage()? {
            return Err(StoreError::AccountingHistoryIncomplete);
        }
        Ok(())
    }
    /// Prices are applied when events are read, so every summary, projection and export uses the current table
    /// and a table change re-prices history without rewriting stored events. A price from the table wins over a
    /// source-reported cost, except Grok Build's (see `priced`); without either, cost stays `None`.
    /// The saved totals are priced under `version`, the price table's: a table of another version re-prices them once,
    /// when they are next read.
    pub fn set_pricer(&mut self, pricer: Option<Pricer>, version: Option<&str>) {
        self.pricer = pricer;
        self.pricing = version.map(str::to_owned);
        self.epoch += 1;
    }
    /// Current events in event-id byte order, filtered by `options` and priced.
    pub fn events(&self, options: &QueryOptions) -> Result<Vec<UsageEvent>> {
        let (cutoff, end) = window(options)?;
        let query = options.q.as_deref().filter(|q| !q.is_empty()).map(str::to_lowercase);
        let ranged = options.from.is_some() || options.to.is_some();
        let mut events = Vec::new();
        for mut event in self.canonical_events()? {
            let in_range = !ranged
                || local_day(&event, options.tz.as_ref()).is_some_and(|day| {
                    options.from.as_deref().is_none_or(|from| *day >= *from)
                        && options.to.as_deref().is_none_or(|to| *day <= *to)
                });
            let at = event.occurred_at.as_deref().and_then(timestamp_ms).map(i128::from);
            let recent = cutoff.is_none_or(|cutoff| at.is_some_and(|at| at >= cutoff))
                && end.is_none_or(|end| at.is_some_and(|at| at < end));
            let matches = query.as_ref().is_none_or(|query| {
                let haystack = format!(
                    "{} {} {}",
                    event.session_id,
                    event.project.as_deref().unwrap_or(""),
                    event.model
                );
                haystack.to_lowercase().contains(query.as_str())
            });
            if options.tool.is_some_and(|tool| tool != event.tool) || !recent || !in_range || !matches {
                continue;
            }
            if let Some((cost, _, version)) = priced(&event, self.pricer.as_ref()) {
                event.cost_microusd = Some(cost);
                event.pricing_version = version;
            }
            events.push(event);
        }
        Ok(events)
    }
    pub fn summary(&self, options: &QueryOptions) -> Result<UsageSummary> {
        let rows = self.slots(options, true)?;
        let mut all = slots::Totals::default();
        for row in &rows {
            all.add(&row.slot)?;
        }
        let breakdown = all.breakdown();
        let input = sum([breakdown.input, breakdown.cache_read, breakdown.cache_write])?;
        let mut daily = slots::totals_by(rows.iter().filter(|row| row.day.is_some()), |row| {
            row.day.clone().unwrap_or_default()
        })?
        .into_iter()
        .map(|(day, totals)| {
            Ok(DayUsage {
                day,
                tokens: totals.tokens()?,
                breakdown: totals.breakdown(),
                cost_microusd: totals.cost(),
                cost_parts: totals.parts(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
        daily.sort_by(|a, b| locale_cmp(&a.day, &b.day));
        let days: Vec<DayTokens> = daily
            .iter()
            .map(|day| DayTokens {
                day: day.day.clone(),
                tokens: day.tokens,
            })
            .collect();
        let tz = options.tz.as_ref();
        Ok(UsageSummary {
            tokens: all.tokens()?,
            breakdown: breakdown.clone(),
            cost_microusd: all.cost(),
            cost_parts: all.parts(),
            activity: activity_stats(&days, &today(options.now.unwrap_or_else(OffsetDateTime::now_utc), tz)),
            sessions: sessions_of(rows.iter()),
            cache_rate: if input == 0 {
                0.0
            } else {
                breakdown.cache_read as f64 / input as f64
            },
            by_tool: slots::totals_by(&rows, |row| row.slot.key.tool)?
                .into_iter()
                .map(|(tool, totals)| {
                    Ok(ToolUsage {
                        tool,
                        tokens: totals.tokens()?,
                        breakdown: totals.breakdown(),
                        cost_microusd: totals.cost(),
                        cost_parts: totals.parts(),
                    })
                })
                .collect::<Result<_>>()?,
            by_model: slots::totals_by(&rows, |row| row.slot.key.model.clone())?
                .into_iter()
                .map(|(model, totals)| {
                    Ok(ModelUsage {
                        model,
                        tokens: totals.tokens()?,
                        breakdown: totals.breakdown(),
                        cost_microusd: totals.cost(),
                        cost_parts: totals.parts(),
                    })
                })
                .collect::<Result<_>>()?,
            daily,
        })
    }
    /// In UTC days, or local days in `tz` (the menu-bar title and `tokentracky status`). Cached until usage changes,
    /// or the zone or its day does.
    pub fn period_totals(&self, now: OffsetDateTime, tz: Option<&TimeZone>) -> Result<PeriodTotals> {
        let today = today(now, tz);
        if let Some(cache) = &self.cache
            && let Some((epoch, zone, day, totals)) = &cache.borrow().period
            && (*epoch, zone.as_ref(), day) == (self.epoch, tz, &today)
        {
            return Ok(totals.clone());
        }
        let (week, month) = match tz {
            None => {
                let start = |period| ranking_window(period, now).map(|window| utf16_prefix(&window, 10).to_owned());
                (
                    start(Period::Week).unwrap_or_default(),
                    start(Period::Month).unwrap_or_default(),
                )
            }
            // As `ranking_window` counts back, from the local date.
            Some(tz) => {
                let date = local_today(now, tz);
                let start = |back: u8| (date - time::Duration::days(back.into())).to_string();
                (start(date.weekday().number_days_from_monday()), start(date.day() - 1))
            }
        };
        let mut totals = PeriodTotals {
            today: 0,
            week: 0,
            month: 0,
            all_time: 0,
            top_tool: None,
        };
        let mut tools: Vec<(ToolId, u64)> = Vec::new();
        let everything = QueryOptions {
            tz: tz.cloned(),
            ..QueryOptions::default()
        };
        for row in self.slots(&everything, false)? {
            let tokens = sum(row.slot.tokens[..4].iter().copied())?;
            totals.all_time = sum([totals.all_time, tokens])?;
            let Some(day) = row.day else { continue };
            if day >= month {
                totals.month = sum([totals.month, tokens])?;
            }
            if day >= week {
                totals.week = sum([totals.week, tokens])?;
                match tools.iter_mut().find(|(tool, _)| *tool == row.slot.key.tool) {
                    Some((_, total)) => *total = sum([*total, tokens])?,
                    None => tools.push((row.slot.key.tool, tokens)),
                }
            }
            if day == today {
                totals.today = sum([totals.today, tokens])?;
            }
        }
        tools.retain(|&(_, tokens)| tokens > 0);
        tools.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_cmp(&text(a.0), &text(b.0))));
        totals.top_tool = tools.first().map(|&(tool, tokens)| TopTool { tool, tokens });
        if let Some(cache) = &self.cache {
            cache.borrow_mut().period = Some((self.epoch, tz.cloned(), today, totals.clone()));
        }
        Ok(totals)
    }
    /// The events of `day` in `tz` by half hour; they sum to that day's [`Self::summary`] total in the zone.
    pub fn day_series(&self, day: &str, tz: &TimeZone) -> Result<DaySeries> {
        const SLOT: i64 = 30 * 60_000;
        let options = QueryOptions {
            from: Some(day.to_owned()),
            to: Some(day.to_owned()),
            tz: Some(tz.clone()),
            ..QueryOptions::default()
        };
        // First, so a `day` that is not a date is refused as a range is.
        let rows = self.slots(&options, false)?;
        // A local date's first instant: its midnight (the first, where the clocks repeat it), or the end of a gap that
        // skips it.
        let first = |date: Date| {
            tz.to_ambiguous_timestamp(date.to_datetime(Time::midnight()))
                .compatible()
        };
        // `rows` has accepted `day`, so it is a `YYYY-MM-DD` date.
        let number = |at: usize, width: usize| day[at..at + width].parse::<i16>().unwrap_or_default();
        let range = Date::new(number(0, 4), number(5, 2) as i8, number(8, 2) as i8)
            .and_then(|date| Ok((first(date)?, first(date.tomorrow()?)?)));
        let Ok((start, end)) = range else {
            return Err(StoreError::InvalidQueryRange);
        };
        let (from, to) = (start.as_millisecond(), end.as_millisecond());
        let mut half_hours = vec![0; ((to - from + SLOT - 1) / SLOT) as usize];
        let last = half_hours.len() - 1;
        for row in &rows {
            // A quarter hour lies in one half hour: the day starts on a quarter hour in every zone in use.
            let Some(at) = row.slot.key.slot else {
                continue;
            };
            // A day that the clocks leave and re-enter across midnight runs on past the next day's start.
            let slot = &mut half_hours[(((at - from) / SLOT) as usize).min(last)];
            *slot = sum([*slot, sum(row.slot.tokens[..4].iter().copied())?])?;
        }
        Ok(DaySeries {
            start: format!("{start:.3}"),
            half_hours,
        })
    }
    /// Sessions, most recently used first.
    pub fn sessions(&self, options: &QueryOptions) -> Result<Vec<SessionSummary>> {
        let rows = self.slots(options, true)?;
        let mut by_session: HashMap<(ToolId, &str), Vec<&slots::Slot>> = HashMap::new();
        for row in &rows {
            by_session
                .entry((row.slot.key.tool, row.slot.key.session_id.as_str()))
                .or_default()
                .push(&row.slot);
        }
        let mut sessions = by_session
            .into_values()
            .map(|session| {
                let mut totals = slots::Totals::default();
                let mut models: Vec<(String, u64)> = Vec::new();
                for slot in &session {
                    totals.add(slot)?;
                    let tokens = sum(slot.tokens[..4].iter().copied())?;
                    match models.iter_mut().find(|(model, _)| *model == slot.key.model) {
                        Some((_, total)) => *total = sum([*total, tokens])?,
                        None => models.push((slot.key.model.clone(), tokens)),
                    }
                }
                models.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_cmp(&a.0, &b.0)));
                let last = slots::latest(session.iter().copied()).expect("a session has a slot row");
                Ok((
                    totals.first_id.clone(),
                    SessionSummary {
                        id: last.key.session_id.clone(),
                        project: last.key.project.clone(),
                        tool: last.key.tool,
                        model: last.key.model.clone(),
                        models: models.into_iter().map(|(model, _)| model).collect(),
                        tokens: totals.tokens()?,
                        breakdown: totals.breakdown(),
                        cost_microusd: totals.cost(),
                        last_used_at: last.last_at.clone(),
                    },
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        // In order of first appearance among events in id order, then the latest first.
        sessions.sort_by(|a, b| a.0.cmp(&b.0));
        let mut sessions: Vec<SessionSummary> = sessions.into_iter().map(|(_, session)| session).collect();
        sessions.sort_by(|a, b| {
            locale_cmp(
                b.last_used_at.as_deref().unwrap_or(""),
                a.last_used_at.as_deref().unwrap_or(""),
            )
        });
        Ok(sessions)
    }
    /// Day × tool × model totals for dated events, ordered by day, tool, then model.
    pub fn breakdown(&self, options: &QueryOptions) -> Result<Vec<UsageBreakdownRow>> {
        let rows = self.slots(options, true)?;
        let mut rows = slots::totals_by(rows.iter().filter(|row| row.day.is_some()), |row| {
            (
                row.day.clone().unwrap_or_default(),
                row.slot.key.tool,
                row.slot.key.model.clone(),
            )
        })?
        .into_iter()
        .map(|((day, tool, model), totals)| {
            Ok(UsageBreakdownRow {
                day,
                tool,
                model,
                tokens: totals.tokens()?,
                breakdown: totals.breakdown(),
                cost_microusd: totals.cost(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
        rows.sort_by(|a, b| {
            locale_cmp(&a.day, &b.day)
                .then_with(|| locale_cmp(&text(a.tool), &text(b.tool)))
                .then_with(|| locale_cmp(&a.model, &b.model))
        });
        Ok(rows)
    }
    /// The window by hour × tool × model, oldest first: hours are counted from `since`, so they keep its minutes (the
    /// Tokens page's bars of the last 24 hours, on the hour in the viewer's zone), or are UTC hours without it.
    pub fn hours(&self, options: &QueryOptions) -> Result<Vec<HourBreakdownRow>> {
        const HOUR: i64 = 3_600_000;
        let since = options.since.unwrap_or(0);
        let rows = self.slots(options, true)?;
        let dated = rows.iter().filter(|row| row.slot.key.slot.is_some());
        let mut rows = slots::totals_by(dated, |row| {
            let at = row.slot.key.slot.unwrap_or_default();
            (
                since + (at - since).div_euclid(HOUR) * HOUR,
                row.slot.key.tool,
                row.slot.key.model.clone(),
            )
        })?
        .into_iter()
        .map(|((hour, tool, model), totals)| {
            let hour = Timestamp::from_millisecond(hour).map_err(|_| StoreError::InvalidQueryRange)?;
            Ok(HourBreakdownRow {
                hour: format!("{hour:.3}"),
                tool,
                model,
                tokens: totals.tokens()?,
                breakdown: totals.breakdown(),
                cost_microusd: totals.cost(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
        rows.sort_by(|a, b| {
            a.hour
                .cmp(&b.hour)
                .then_with(|| locale_cmp(&text(a.tool), &text(b.tool)))
                .then_with(|| locale_cmp(&a.model, &b.model))
        });
        Ok(rows)
    }
    /// Projects (events with a project), largest first.
    pub fn projects(&self, options: &QueryOptions) -> Result<Vec<ProjectSummary>> {
        let rows = self.slots(options, true)?;
        let named = || rows.iter().filter(|row| row.slot.key.project.is_some());
        let mut projects = slots::totals_by(named(), |row| row.slot.key.project.clone())?
            .into_iter()
            .map(|(name, totals)| {
                Ok(ProjectSummary {
                    sessions: sessions_of(named().filter(|row| row.slot.key.project == name)),
                    name: name.unwrap_or_default(),
                    repository: None,
                    tokens: totals.tokens()?,
                    breakdown: totals.breakdown(),
                    cost_microusd: totals.cost(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        projects.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| locale_cmp(&a.name, &b.name)));
        Ok(projects)
    }
    /// The slot rows `options` selects, each with its day: UTC as written, or local in `options.tz`. A rolling window
    /// starts and ends at the quarter hour at or before its instants. `priced` reads costs of this store's prices.
    fn slots(&self, options: &QueryOptions, priced: bool) -> Result<Vec<slots::Dated>> {
        let (cutoff, end) = window(options)?;
        // A slot's first instant at or before an instant; one before every event when out of range.
        let edge = |at: i128| {
            i64::try_from(at.div_euclid(i128::from(slots::SLOT)) * i128::from(slots::SLOT)).unwrap_or(i64::MIN)
        };
        let (since, until) = (cutoff.map(edge), end.map(edge));
        let query = options.q.as_deref().filter(|q| !q.is_empty()).map(str::to_lowercase);
        let ranged = options.from.is_some() || options.to.is_some();
        // Days are read with two days to spare either side: local days are within 14 hours of UTC ones, and a written
        // UTC day within a day of its instant.
        let day = |day: &Option<String>, spare: i64| {
            day.as_deref()
                .and_then(timestamp_ms)
                .map(|midnight| midnight + spare * 86_400_000)
        };
        let bound = |a: Option<i64>, b: Option<i64>, pick: fn(i64, i64) -> i64| match (a, b) {
            (Some(a), Some(b)) => Some(pick(a, b)),
            (a, b) => a.or(b),
        };
        let first = bound(since, day(&options.from, -2), i64::max);
        let last = bound(until, day(&options.to, 3), i64::min);
        let mut rows = Vec::new();
        for slot in self.slot_rows(first, last, priced)? {
            let key = &slot.key;
            let at = key.slot;
            let recent = since.is_none_or(|since| at.is_some_and(|at| at >= since))
                && until.is_none_or(|until| at.is_some_and(|at| at < until));
            let matches = query.as_ref().is_none_or(|query| {
                let haystack = format!(
                    "{} {} {}",
                    key.session_id,
                    key.project.as_deref().unwrap_or(""),
                    key.model
                );
                haystack.to_lowercase().contains(query.as_str())
            });
            if options.tool.is_some_and(|tool| tool != key.tool) || !recent || !matches {
                continue;
            }
            let day = match &options.tz {
                None => key.day.clone(),
                Some(tz) => at.and_then(|at| local_date(at, tz)).map(|date| date.to_string()),
            };
            let in_range = !ranged
                || day.as_deref().is_some_and(|day| {
                    options.from.as_deref().is_none_or(|from| day >= from)
                        && options.to.as_deref().is_none_or(|to| day <= to)
                });
            if in_range {
                rows.push(slots::Dated { day, slot });
            }
        }
        Ok(rows)
    }
    /// Whether the saved totals can be read: built first where they are not saved, or (for `priced` reads) were
    /// priced under other prices. Not for a read-only store that finds none, which cannot save them.
    fn saved_slots(&self, priced: bool) -> Result<bool> {
        let writable = self.cache.is_some();
        if slots::priced_under(&self.db)?.is_some_and(|version| !writable || !priced || version == self.pricing) {
            return Ok(true);
        }
        if writable {
            slots::rebuild(&self.db, self.pricer.as_ref(), self.pricing.as_deref())?;
        }
        Ok(writable)
    }
    /// The slot rows from `since` until before `until` (all, undated too, without either): saved, or folded from the
    /// events where they cannot be saved.
    fn slot_rows(&self, since: Option<i64>, until: Option<i64>, priced: bool) -> Result<Vec<slots::Slot>> {
        if self.saved_slots(priced)? {
            return slots::read(&self.db, since, until);
        }
        let bounded = since.is_some() || until.is_some();
        let slots = slots::fold(&self.db, &self.usage_origins()?, self.pricer.as_ref())?;
        Ok(slots
            .into_iter()
            .filter(|slot| {
                !bounded
                    || slot
                        .key
                        .slot
                        .is_some_and(|at| since.is_none_or(|since| at >= since) && until.is_none_or(|until| at < until))
            })
            .collect())
    }
    /// Local candidate buckets, per tool. Contains no private identifiers.
    pub fn public_buckets(&mut self) -> Result<Vec<PublicBucket>> {
        self.project_public_buckets(&PublicationOptions {
            history_start: None,
            share_tools: true,
            share_cost: true,
            share_models: false,
        })
    }
    /// Explicit consent projection: only day, tool, model, tokens, their kinds, cost and revision leave the store.
    /// Revision state (and the zero tombstones that replace an uploaded total after a correction or deletion) is kept
    /// per scope.
    pub fn project_public_buckets(&mut self, options: &PublicationOptions) -> Result<Vec<PublicBucket>> {
        Ok(self.project_publication(options, OffsetDateTime::now_utc())?.0)
    }
    /// The day buckets and, from the same events, the hours for the leaderboard's 24-hour column as of `now`.
    fn project_publication(
        &mut self,
        options: &PublicationOptions,
        now: OffsetDateTime,
    ) -> Result<(Vec<PublicBucket>, Vec<PublicHour>)> {
        if options.history_start.as_deref().is_some_and(|start| !is_utc_day(start)) {
            return Err(StoreError::InvalidHistoryStart);
        }
        self.ensure_publication_ready()?;
        let excluded = self.publication_exclusions()?;
        let start = options.history_start.as_deref();
        let events: Vec<UsageEvent> = self
            .events(&QueryOptions::default())?
            .into_iter()
            .filter(|event| !excluded.contains(&event.event_id))
            .filter(|event| start.is_none_or(|start| day(event).is_some_and(|day| day >= start)))
            .collect();
        let models = options.share_models;
        // Without model sharing the scope (and so every revision) is what it was before models existed.
        let scope = serde_json::to_string(&if models {
            json!([start, options.share_tools, options.share_cost, true])
        } else {
            json!([start, options.share_tools, options.share_cost])
        })?;
        // A model id that is not publishable as logged (free text, separators) is published as `other`.
        let model = |event: &UsageEvent| {
            if is_public_model(&event.model) {
                event.model.clone()
            } else {
                "other".to_owned()
            }
        };
        let tool = |event: &UsageEvent| {
            if options.share_tools {
                BucketTool::Tool(event.tool)
            } else {
                BucketTool::All
            }
        };
        let hours = public_hours(&events, now, tool)?;
        let key = |event: &UsageEvent| {
            let model = if models {
                format!("|{}", model(event))
            } else {
                String::new()
            };
            format!("{}|{}{model}", day(event).unwrap_or("unknown"), text(tool(event)))
        };
        let mut drafts = group(&events, key)
            .into_iter()
            .map(|(key, items)| {
                let bucket = PublicBucket {
                    day: day(items[0]).map(str::to_owned),
                    tool: tool(items[0]),
                    model: models.then(|| model(items[0])),
                    tokens: tokens(&items)?,
                    cost_microusd: if options.share_cost { cost(&items)? } else { None },
                    revision: 0,
                    breakdown: Some(TokenCounts {
                        cache_write_1h: None,
                        ..kinds(&items)?
                    }),
                };
                Ok((key, bucket))
            })
            .collect::<Result<Vec<_>>>()?;
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut buckets = Vec::new();
        {
            let mut statement =
                tx.prepare("SELECT bucket_key,day,tool,tokens,cost,revision,kinds FROM public_buckets WHERE scope=?")?;
            let previous = statement
                .query_map([&scope], |row| {
                    let count = |index| {
                        row.get::<_, Option<i64>>(index)
                            .map(|count| count.map(|count| count as u64))
                    };
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        count(3)?.unwrap_or(0),
                        count(4)?,
                        count(5)?.unwrap_or(0),
                        row.get::<_, Option<String>>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let keys: HashSet<String> = drafts.iter().map(|(key, _)| key.clone()).collect();
            // Persist zero tombstones so a correction or deletion replaces an uploaded total.
            for (old_key, old_day, old_tool, ..) in &previous {
                if !keys.contains(old_key) {
                    let bucket = PublicBucket {
                        day: old_day.clone(),
                        tool: parse(old_tool.clone())?,
                        model: if models {
                            old_key.split('|').nth(2).map(str::to_owned)
                        } else {
                            None
                        },
                        tokens: 0,
                        cost_microusd: None,
                        revision: 0,
                        breakdown: Some(kinds(&[])?),
                    };
                    drafts.push((old_key.clone(), bucket));
                }
            }
            let mut put = tx.prepare("INSERT INTO public_buckets(scope,bucket_key,day,tool,tokens,cost,revision,kinds) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,bucket_key) DO UPDATE SET tokens=excluded.tokens,cost=excluded.cost,revision=excluded.revision,kinds=excluded.kinds")?;
            for (key, mut bucket) in drafts {
                let old = previous.iter().find(|old| old.0 == key);
                // A change of kinds alone (same total) is a new revision too, so the host learns it.
                let breakdown = serde_json::to_string(&bucket.breakdown)?;
                bucket.revision = match old {
                    Some(old)
                        if old.3 == bucket.tokens
                            && old.4 == bucket.cost_microusd
                            && old.6.as_deref() == Some(breakdown.as_str()) =>
                    {
                        old.5
                    }
                    _ => next_revision(&tx)?,
                };
                let (tokens, cost, revision) = (
                    bucket.tokens as i64,
                    bucket.cost_microusd.map(|cost| cost as i64),
                    bucket.revision as i64,
                );
                put.execute(params![
                    scope,
                    key,
                    bucket.day,
                    text(bucket.tool),
                    tokens,
                    cost,
                    revision,
                    breakdown
                ])?;
                buckets.push(bucket);
            }
        }
        tx.commit()?;
        let order = |bucket: &PublicBucket| {
            let (day, model) = (
                bucket.day.as_deref().unwrap_or(""),
                bucket.model.as_deref().unwrap_or(""),
            );
            format!("{day}:{}:{model}", text(bucket.tool))
        };
        buckets.sort_by(|a, b| locale_cmp(&order(a), &order(b)));
        Ok((buckets, hours))
    }
    pub fn export_data(&self, options: &QueryOptions) -> Result<Vec<UsageEvent>> {
        self.events(options)
    }
    /// CSV with CRLF line ends and every cell quoted; text that a spreadsheet would run as a formula is prefixed
    /// with an apostrophe.
    pub fn export_csv(&self, options: &QueryOptions) -> Result<String> {
        let mut rows = vec![
            [
                "tool",
                "model",
                "timestamp",
                "project",
                "session",
                "input",
                "output",
                "cache_read",
                "cache_write",
                "reasoning",
                "total",
                "cost_microusd",
            ]
            .map(cell),
        ];
        for event in self.events(options)? {
            let tokens = &event.tokens;
            let count = |count: u64| cell(&count.to_string());
            rows.push([
                cell(&text(event.tool)),
                cell(&event.model),
                cell(event.occurred_at.as_deref().unwrap_or("")),
                cell(event.project.as_deref().unwrap_or("")),
                cell(&event.session_id),
                count(tokens.input),
                count(tokens.output),
                count(tokens.cache_read),
                count(tokens.cache_write),
                count(tokens.reasoning.unwrap_or(0)),
                count(total_tokens(tokens)),
                cell(&event.cost_microusd.map(|cost| cost.to_string()).unwrap_or_default()),
            ]);
        }
        Ok(rows.iter().map(|row| row.join(",") + "\r\n").collect())
    }
    /// Closes the database, then releases the owner lock.
    pub fn close(self) -> Result<()> {
        let Self { db, _owner, .. } = self;
        db.close().map_err(|(_, error)| error)?;
        Ok(())
    }
}

/// White space as JavaScript's `\s` matches it.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}
/// One quoted CSV cell (`/^(?:\s*[=+\-@]|[\t\r\n])/` gets the apostrophe).
fn cell(value: &str) -> String {
    let formula =
        value.trim_start_matches(js_space).starts_with(['=', '+', '-', '@']) || value.starts_with(['\t', '\r', '\n']);
    let safe = if formula { format!("'{value}") } else { value.to_owned() };
    format!("\"{}\"", safe.replace('"', "\"\""))
}
