//! The ingestion service: reads the authorised paths of every enabled source and commits what the readers return.
//! File I/O is synchronous (`std::fs`), so async callers run it on a
//! blocking thread; a scan locks the store per operation, so queries interleave with it between writes.
use crate::limits::{LimitReading, MAX_CLAUDE_CONFIG_BYTES, claude_reading, read_claude_config};
use crate::readers::{
    MAX_DOCUMENT_BYTES, MayHoldUsage, PARSER_VERSION, PENDING, Parents, ParserState, RateLimits, RawCounts, Sidecars,
    SourceKind, adapter, codex_total, digest, is_supported, line_limit, parse_document, parse_usage_line, source_kind,
};
use crate::store::{FileCheckpoint, SourceConfiguration, StoreError, UsageStore};
use crate::{Clock, resolve};
use ruzstd::decoding::StreamingDecoder;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
#[cfg(unix)]
use std::fs::OpenOptions;
use std::fs::{self, DirEntry, File, Metadata};
use std::io::{self, BufRead, BufReader, Read};
#[cfg(unix)]
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use time::OffsetDateTime;
use tokentracky_core::{ParseResult, SourceState, SourceStatus, TOOL_IDS, ToolId, UsageEvent, iso_timestamp};
#[cfg(windows)]
use windows::FileExt;

#[cfg(windows)]
mod windows;

/// Line logs are read in chunks of this size.
const CHUNK: usize = 64 * 1024;
/// An appended log is checked by this many bytes before its saved offset (t3code's rule).
const TAIL: u64 = 64;
/// An archive that decompresses to more is skipped as `record_too_large`.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorStatus {
    pub sources: Vec<SourceStatus>,
    pub collecting: bool,
    pub last_scan_at: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScanResult {
    #[serde(flatten)]
    pub status: CollectorStatus,
    /// Sorted diagnostic codes of every source.
    pub diagnostics: Vec<String>,
}
#[derive(Clone)]
pub struct IngestionOptions {
    pub max_files: usize,
    pub max_depth: usize,
    /// Decompressed bytes read from one archive before it is skipped.
    pub max_archive_bytes: u64,
    /// Defaults to the system clock.
    pub now: Option<Clock>,
    /// Claude Code's own settings file (`limits::claude_config_file`), whose cached usage-limit reading each scan takes
    /// while Claude Code is enabled (F6). `None` reads none.
    pub claude_config_file: Option<PathBuf>,
}
impl Default for IngestionOptions {
    fn default() -> Self {
        Self {
            max_files: 100_000,
            max_depth: 32,
            max_archive_bytes: MAX_ARCHIVE_BYTES,
            now: None,
            claude_config_file: None,
        }
    }
}

/// Each message is the TypeScript error code. A scan reports the scope, limit and change codes as diagnostics
/// (`source_read_failed`, `file_read_failed`) and returns only store errors; it is `Clone` so callers that join an
/// in-flight scan receive its result.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ServiceError {
    #[error("invalid_ingestion_options")]
    InvalidOptions,
    #[error("invalid_source_configuration")]
    InvalidSourceConfiguration,
    #[error("enabled_source_requires_paths")]
    EnabledSourceRequiresPaths,
    #[error("invalid_source_path")]
    InvalidSourcePath,
    #[error("unsupported_source_file")]
    UnsupportedSourceFile,
    #[error("source_scope_changed")]
    SourceScopeChanged,
    #[error("source_file_limit")]
    SourceFileLimit,
    #[error("source_depth_limit")]
    SourceDepthLimit,
    #[error("file_changed_during_scan")]
    FileChangedDuringScan,
    #[error(transparent)]
    Io(Arc<io::Error>),
    #[error(transparent)]
    Database(Arc<rusqlite::Error>),
    #[error(transparent)]
    Store(Arc<StoreError>),
}
impl From<io::Error> for ServiceError {
    fn from(error: io::Error) -> Self {
        Self::Io(Arc::new(error))
    }
}
impl From<rusqlite::Error> for ServiceError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(Arc::new(error))
    }
}
impl From<StoreError> for ServiceError {
    fn from(error: StoreError) -> Self {
        Self::Store(Arc::new(error))
    }
}
type Result<T> = std::result::Result<T, ServiceError>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
/// `relative(root, candidate)` stays below `root` (or is `root`).
fn inside(root: &Path, candidate: &Path) -> bool {
    resolve(candidate).starts_with(resolve(root))
}
/// The store keys files by their path as text.
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
/// Adds a code once, in first-seen order (a JavaScript `Set`).
fn add(codes: &mut Vec<String>, code: &str) {
    if !codes.iter().any(|seen| seen == code) {
        codes.push(code.to_owned());
    }
}
fn new_parser_state() -> Result<Value> {
    Ok(serde_json::to_value(ParserState::default()).map_err(StoreError::Json)?)
}

/// What `lstat` and `fstat` report, with times in milliseconds as Node computes `mtimeMs` and `ctimeMs`.
#[derive(PartialEq)]
struct Stat {
    identity: String,
    size: u64,
    mtime_ms: f64,
    ctime_ms: f64,
}
impl Stat {
    #[cfg(unix)]
    fn of(metadata: &Metadata) -> Self {
        let ms = |seconds: i64, nanoseconds: i64| seconds as f64 * 1000.0 + nanoseconds as f64 / 1e6;
        Self {
            identity: format!("{}:{}", metadata.dev(), metadata.ino()),
            size: metadata.size(),
            mtime_ms: ms(metadata.mtime(), metadata.mtime_nsec()),
            ctime_ms: ms(metadata.ctime(), metadata.ctime_nsec()),
        }
    }
    /// `fstat`.
    fn of_file(file: &File) -> io::Result<Self> {
        #[cfg(unix)]
        return Ok(Self::of(&file.metadata()?));
        #[cfg(windows)]
        windows::stat(file)
    }
    /// `lstat`: `path` itself, a link included.
    fn of_path(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        return Ok(Self::of(&fs::symlink_metadata(path)?));
        #[cfg(windows)]
        windows::lstat(path)
    }
    /// `lstat` of `path`, whose `symlink_metadata` is `metadata`: all Unix needs.
    #[cfg(unix)]
    fn of_link(_: &Path, metadata: &Metadata) -> io::Result<Self> {
        Ok(Self::of(metadata))
    }
    #[cfg(windows)]
    fn of_link(path: &Path, _: &Metadata) -> io::Result<Self> {
        windows::lstat(path)
    }
    /// The checkpoint was taken of this very file, unchanged since.
    fn matches(&self, previous: &FileCheckpoint) -> bool {
        previous.identity == self.identity
            && previous.parser_version == i64::from(PARSER_VERSION)
            && previous.file_size == Some(self.size)
            && previous.mtime_ms == Some(self.mtime_ms)
            && previous.ctime_ms == Some(self.ctime_ms)
    }
}
/// SHA-256 of the (at most) 64 bytes before `offset`. A log that only grew still has them there.
fn tail_hash(file: &File, offset: u64) -> Result<String> {
    let start = offset.saturating_sub(TAIL);
    let mut bytes = vec![0u8; (offset - start) as usize];
    file.read_exact_at(&mut bytes, start)?;
    Ok(digest(&bytes))
}
/// A line log may grow while it is read: only bytes up to `before.size` were read and the checkpoint keeps
/// `before`'s times, so the next scan reads the rest. A shrink, a replacement or a same-size rewrite is a change.
fn changed_during_read(before: &Stat, after: &Stat) -> bool {
    after.identity != before.identity
        || after.size < before.size
        || (after.size == before.size && (after.mtime_ms != before.mtime_ms || after.ctime_ms != before.ctime_ms))
}
struct Opened {
    file: File,
    stat: Stat,
}
/// Opens a regular file inside an authorized root without following links; any swap fails closed.
fn open_inside(path: &Path, root: &Path) -> Result<Opened> {
    if !inside(root, &fs::canonicalize(path)?) {
        return Err(ServiceError::SourceScopeChanged);
    }
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() {
        return Err(ServiceError::SourceScopeChanged);
    }
    #[cfg(unix)]
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    #[cfg(windows)]
    let file = windows::open_no_follow(path)?;
    let stat = Stat::of_file(&file)?;
    if stat.identity != Stat::of_link(path, &before)?.identity {
        return Err(ServiceError::SourceScopeChanged);
    }
    // A parent-directory symlink inserted between traversal and open must fail closed.
    if !inside(root, &fs::canonicalize(path)?) {
        return Err(ServiceError::SourceScopeChanged);
    }
    Ok(Opened { file, stat })
}
/// Reads a whole document without trusting an earlier metadata size.
fn read_document_bytes(reader: impl Read, limit: u64) -> io::Result<Option<Vec<u8>>> {
    // SECURITY: Authorized logs can grow after fstat. Cap actual reads, including sidecars, before parsing
    // (VULN-004). Do not remove.
    let mut bytes = Vec::new();
    reader.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}
/// A sibling document under the same scope checks; `None` when absent, out of scope or too large.
fn read_sidecar(path: &Path, root: &Path) -> Result<Option<String>> {
    if !inside(root, path) {
        return Ok(None);
    }
    let Ok(Opened { mut file, stat }) = open_inside(path, root) else {
        return Ok(None);
    };
    if stat.size > MAX_DOCUMENT_BYTES {
        return Ok(None);
    }
    Ok(read_document_bytes(&mut file, MAX_DOCUMENT_BYTES)?.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}
/// A number as `JSON.stringify` writes it.
fn js_number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}
/// `sidecarVersion`: identity, size and times of each sidecar (null when absent), so one written after its document
/// still updates it.
fn sidecar_version(tool: ToolId, path: &Path, root: &Path) -> String {
    let siblings = adapter(tool).and_then(|adapter| adapter.sidecars);
    // `JSON.stringify([[role, [dev, ino, size, mtimeMs, ctimeMs] or null], ...])`.
    let stamps: Vec<String> = siblings
        .map_or_else(Vec::new, |sidecars| sidecars(path))
        .into_iter()
        .map(|(role, sibling)| {
            let stat = if inside(root, &sibling) {
                Stat::of_path(&sibling).ok()
            } else {
                None
            };
            let stamp = stat.map_or_else(
                || "null".to_owned(),
                |stat| {
                    let (mtime, ctime) = (js_number(stat.mtime_ms), js_number(stat.ctime_ms));
                    // `dev,ino`.
                    let identity = stat.identity.replace(':', ",");
                    format!("[{identity},{},{mtime},{ctime}]", stat.size)
                },
            );
            format!("[{},{stamp}]", Value::from(role))
        })
        .collect();
    digest(format!("[{}]", stamps.join(",")))
}

/// What an archive holds: its events, its diagnostic codes and its last rate-limit snapshot.
type Archive = (Vec<UsageEvent>, Vec<String>, Option<RateLimits>);

/// Splits bytes into a tool's lines without their newlines, each passed on as it ends: `None` for one too long to read
/// that may have held usage. A long one that cannot have is skipped.
struct Lines {
    line: Vec<u8>,
    oversized: bool,
    limit: usize,
    usage: MayHoldUsage,
}
impl Lines {
    fn new(tool: ToolId) -> Self {
        Self {
            line: Vec::new(),
            oversized: false,
            limit: line_limit(tool),
            usage: MayHoldUsage::new(tool),
        }
    }
    fn push(&mut self, bytes: &[u8], each: &mut impl FnMut(Option<&[u8]>)) {
        for piece in bytes.split_inclusive(|&byte| byte == b'\n') {
            let (content, ends) = match piece.split_last() {
                Some((b'\n', content)) => (content, true),
                _ => (piece, false),
            };
            if self.oversized || self.line.len() + content.len() > self.limit {
                if !self.oversized {
                    self.usage.feed(&self.line);
                }
                self.usage.feed(content);
                self.oversized = true;
                self.line.clear();
            } else {
                self.line.extend_from_slice(content);
            }
            if ends {
                self.end(each);
            }
        }
    }
    fn end(&mut self, each: &mut impl FnMut(Option<&[u8]>)) {
        if !self.oversized {
            each(Some(&self.line));
        } else if self.usage.take() {
            each(None);
        }
        self.line.clear();
        self.oversized = false;
    }
    /// A last line without a newline.
    fn finish(mut self, each: &mut impl FnMut(Option<&[u8]>)) {
        if self.oversized || !self.line.is_empty() {
            self.end(each);
        }
    }
}
/// A zstd archive's bytes, frame after frame, as they decompress: `archive_unreadable` for anything but frames, and
/// `record_too_large` past `limit` bytes.
fn decompress(file: &File, limit: u64, mut each: impl FnMut(&[u8])) -> std::result::Result<(), &'static str> {
    const UNREADABLE: &str = "archive_unreadable";
    let mut source = BufReader::new(file);
    let (mut chunk, mut decompressed) = (vec![0u8; CHUNK], 0u64);
    // At least one frame, then frames until the input ends; anything else after a frame makes it unreadable.
    let mut first = true;
    while first || !source.fill_buf().map_err(|_| UNREADABLE)?.is_empty() {
        first = false;
        let mut decoder = StreamingDecoder::new(&mut source).map_err(|_| UNREADABLE)?;
        loop {
            let read = decoder.read(&mut chunk).map_err(|_| UNREADABLE)?;
            if read == 0 {
                break;
            }
            decompressed += read as u64;
            if decompressed > limit {
                return Err("record_too_large");
            }
            each(&chunk[..read]);
        }
    }
    Ok(())
}
/// The thread a Codex rollout's name ends with: `rollout-<time>-<thread>.jsonl`, or `.jsonl.zst`.
fn rollout_thread(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    let stem = name
        .strip_suffix(".jsonl.zst")
        .or_else(|| name.strip_suffix(".jsonl"))?;
    let thread = stem.get(stem.len().checked_sub(36)?..)?;
    let uuid = thread.bytes().enumerate().all(|(at, byte)| match at {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    });
    (name.starts_with("rollout-") && uuid).then_some(thread)
}
/// Every running total a Codex rollout wrote, a log or an archive; `None` when it cannot be read.
fn rollout_totals(tool: ToolId, path: &Path, root: &Path, max_archive_bytes: u64) -> Option<HashSet<RawCounts>> {
    let Opened { file, .. } = open_inside(path, root).ok()?;
    let mut totals = HashSet::new();
    let mut each = |line: Option<&[u8]>| {
        if let Some(line) = line.filter(|line| line.windows(11).any(|word| word == b"token_count"))
            && let Some(total) = codex_total(tool, &String::from_utf8_lossy(line))
        {
            totals.insert(total);
        }
    };
    let mut lines = Lines::new(tool);
    if source_kind(tool, path) == Some(SourceKind::CompressedJsonl) {
        decompress(&file, max_archive_bytes, |bytes| lines.push(bytes, &mut each)).ok()?;
    } else {
        let mut reader = BufReader::with_capacity(CHUNK, &file);
        loop {
            let bytes = reader.fill_buf().ok()?;
            if bytes.is_empty() {
                break;
            }
            let read = bytes.len();
            lines.push(bytes, &mut each);
            reader.consume(read);
        }
    }
    lines.finish(&mut each);
    Some(totals)
}
/// A file found under a root, and how its tool reads it.
struct Found {
    root: PathBuf,
    path: PathBuf,
    kind: SourceKind,
}
#[derive(Default)]
struct Progress {
    active: bool,
    /// Scans admitted by [`IngestionService::admit`] that have not started yet; `stop` waits for them too.
    pending: usize,
    finished: u64,
    last: Option<Result<ScanResult>>,
}

/// A scan admitted before it runs ([`IngestionService::admit`]): from admission, `stop` waits for it as it waits for
/// a running scan. Dropping the ticket without scanning withdraws the admission.
pub struct ScanTicket {
    service: Arc<IngestionService>,
    spent: bool,
}

impl ScanTicket {
    /// Runs the admitted scan, or joins the one in flight, as [`IngestionService::scan`] does.
    pub fn scan(mut self) -> Result<ScanResult> {
        self.spent = true;
        self.service.scan_admitted()
    }
}

impl Drop for ScanTicket {
    fn drop(&mut self) {
        if !self.spent {
            lock(&self.service.progress).pending -= 1;
            self.service.settled.notify_all();
        }
    }
}

/// No discovery or default paths: only `configure_source` with `enabled` and paths grants read scope.
pub struct IngestionService {
    store: Arc<Mutex<UsageStore>>,
    max_files: usize,
    max_depth: usize,
    max_archive_bytes: u64,
    now: Clock,
    claude_config_file: Option<PathBuf>,
    /// Claude Code's settings file as last read for its reading (`None` when there was none); unset until then.
    claude_config_seen: Mutex<Option<Option<Stat>>>,
    /// Held by a scan and by a configuration change, so a scan never reads beyond a scope revoked meanwhile.
    gate: Mutex<()>,
    progress: Mutex<Progress>,
    settled: Condvar,
}

impl IngestionService {
    pub fn new(store: Arc<Mutex<UsageStore>>, options: IngestionOptions) -> Result<Self> {
        let safe = |value: usize| value as u64 <= tokentracky_core::MAX_SAFE_INTEGER;
        if options.max_files < 1 || !safe(options.max_files) || !safe(options.max_depth) {
            return Err(ServiceError::InvalidOptions);
        }
        Ok(Self {
            store,
            max_files: options.max_files,
            max_depth: options.max_depth,
            max_archive_bytes: options.max_archive_bytes,
            now: options.now.unwrap_or_else(|| Arc::new(OffsetDateTime::now_utc)),
            claude_config_file: options.claude_config_file,
            claude_config_seen: Mutex::new(None),
            gate: Mutex::new(()),
            progress: Mutex::default(),
            settled: Condvar::new(),
        })
    }
    pub fn store(&self) -> &Arc<Mutex<UsageStore>> {
        &self.store
    }
    /// Enables, pauses or re-scopes a source. Enabled paths are pinned to their canonical form and must exist.
    /// Waits for an in-flight scan first.
    pub fn configure_source(&self, tool: ToolId, configuration: &SourceConfiguration) -> Result<SourceStatus> {
        if configuration
            .paths
            .iter()
            .any(|path| !Path::new(path).is_absolute() || path.contains('\0'))
        {
            return Err(ServiceError::InvalidSourceConfiguration);
        }
        // Prevent an in-flight scan from reading beyond a revoked scope after this returns.
        let _gate = lock(&self.gate);
        let mut paths = Vec::new();
        if configuration.enabled && is_supported(tool) {
            if configuration.paths.is_empty() {
                return Err(ServiceError::EnabledSourceRequiresPaths);
            }
            for path in &configuration.paths {
                let canonical = fs::canonicalize(path)?;
                let stat = fs::symlink_metadata(&canonical)?;
                if !stat.is_dir() && !stat.is_file() {
                    return Err(ServiceError::InvalidSourcePath);
                }
                if stat.is_file() && source_kind(tool, &canonical).is_none() {
                    return Err(ServiceError::UnsupportedSourceFile);
                }
                paths.push(text(&canonical));
            }
        } else {
            paths.extend(configuration.paths.iter().map(|path| text(&resolve(Path::new(path)))));
        }
        let mut unique: Vec<String> = Vec::new();
        for path in paths {
            if !unique.contains(&path) {
                unique.push(path);
            }
        }
        let configuration = SourceConfiguration {
            enabled: configuration.enabled,
            paths: unique,
        };
        lock(&self.store).save_source_configuration(tool, &configuration)?;
        let status = self.status()?;
        Ok(status
            .sources
            .into_iter()
            .find(|source| source.id == tool)
            .expect("the store has a row for every tool"))
    }
    pub fn status(&self) -> std::result::Result<CollectorStatus, StoreError> {
        let collecting = {
            let progress = lock(&self.progress);
            progress.active || progress.pending > 0
        };
        let store = lock(&self.store);
        Ok(CollectorStatus {
            sources: store.source_statuses()?,
            collecting,
            last_scan_at: store.last_scan_at()?,
        })
    }
    /// Admits a scan that runs later (`ScanTicket::scan`), counting it as in flight from now. In TypeScript `scan()`
    /// sets its `active` promise synchronously, before the first await, so a pause or close that follows waits for
    /// it; a scan handed to another thread needs the same admission before it is dispatched.
    pub fn admit(self: &Arc<Self>) -> ScanTicket {
        lock(&self.progress).pending += 1;
        ScanTicket {
            service: self.clone(),
            spent: false,
        }
    }
    /// Concurrent callers share the same scan; no competing checkpoint writers.
    pub fn scan(&self) -> Result<ScanResult> {
        self.run_scan(lock(&self.progress))
    }
    fn scan_admitted(&self) -> Result<ScanResult> {
        let mut progress = lock(&self.progress);
        progress.pending -= 1;
        self.run_scan(progress)
    }
    fn run_scan(&self, mut progress: MutexGuard<'_, Progress>) -> Result<ScanResult> {
        if progress.active {
            let finished = progress.finished;
            while progress.finished == finished {
                progress = self.settled.wait(progress).unwrap_or_else(PoisonError::into_inner);
            }
            return progress.last.clone().expect("a finished scan leaves its result");
        }
        progress.active = true;
        drop(progress);
        let result = {
            let _gate = lock(&self.gate);
            self.scan_sources()
        };
        let mut progress = lock(&self.progress);
        progress.active = false;
        progress.finished += 1;
        progress.last = Some(result.clone());
        self.settled.notify_all();
        result
    }
    /// Waits for an in-flight scan, and for one admitted but not yet started. Scheduling belongs to the caller (the
    /// refresh cycle).
    pub fn stop(&self) {
        let mut progress = lock(&self.progress);
        while progress.active || progress.pending > 0 {
            progress = self.settled.wait(progress).unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn scan_sources(&self) -> Result<ScanResult> {
        let mut diagnostics = BTreeSet::new();
        for &tool in TOOL_IDS {
            let source = lock(&self.store).get_source_configuration(tool)?;
            if !source.enabled || !is_supported(tool) {
                continue;
            }
            lock(&self.store).set_source_state(
                tool,
                SourceState::Importing,
                "Importing authorized local usage metadata.",
                None,
            )?;
            let mut failed = false;
            let mut found = Vec::new();
            let mut source_diagnostics = BTreeSet::new();
            if self.discover(tool, &source.paths, &mut found).is_err() {
                failed = true;
                source_diagnostics.insert("source_read_failed".to_owned());
            }
            let superseded = adapter(tool).is_some_and(|adapter| adapter.database_supersedes_documents)
                && found.iter().any(|file| file.kind == SourceKind::Sqlite);
            // Superseded documents are withdrawn only after every database was read this scan, so a locked one keeps
            // their usage.
            let ordered: Vec<&Found> = if superseded {
                let (databases, others): (Vec<&Found>, Vec<&Found>) =
                    found.iter().partition(|file| file.kind == SourceKind::Sqlite);
                databases.into_iter().chain(others).collect()
            } else {
                found.iter().collect()
            };
            let parents = if matches!(tool, ToolId::Codex | ToolId::EveryCode) {
                self.parents(tool, &found)
            } else {
                Parents::default()
            };
            let mut databases_read = true;
            let mut unresolved_lineage = false;
            for Found { root, path, kind } in ordered {
                if superseded && *kind == SourceKind::Json {
                    if databases_read {
                        lock(&self.store).forget_file(&text(path), tool)?;
                    }
                    continue;
                }
                let codes = match kind {
                    SourceKind::Jsonl => self.ingest_file(tool, path, root, &parents),
                    SourceKind::Json => self.ingest_document(tool, path, root),
                    SourceKind::Sqlite => self.ingest_database(tool, path, root),
                    SourceKind::CompressedJsonl => self.ingest_archive(tool, path, root, &parents),
                };
                match codes {
                    Ok(codes) => {
                        unresolved_lineage |= codes.iter().any(|d| d == "fork_lineage_unavailable")
                            && !codes.iter().any(|d| d == "kilo_history_local_only");
                        source_diagnostics.extend(codes);
                    }
                    Err(_) => {
                        failed = true;
                        source_diagnostics.insert("file_read_failed".to_owned());
                        if *kind == SourceKind::Sqlite {
                            databases_read = false;
                        }
                    }
                }
            }
            if tool == ToolId::Claude {
                self.read_claude_limits()?;
            }
            diagnostics.extend(source_diagnostics.iter().cloned());
            let timestamp = iso_timestamp((self.now)());
            let (state, message) = if failed {
                (SourceState::Error, "Some authorized logs could not be read.".to_owned())
            } else if unresolved_lineage {
                (SourceState::Stale, "Fork history is incomplete. Local totals are provisional; leaderboard sync is paused until the missing history is restored.".to_owned())
            } else if source_diagnostics.contains("kilo_history_local_only")
                && source_diagnostics
                    .iter()
                    .all(|d| matches!(d.as_str(), "kilo_history_local_only" | "fork_lineage_unavailable"))
            {
                (SourceState::Current, "Authorized logs are current.".to_owned())
            } else if !source_diagnostics.is_empty() {
                let codes: Vec<String> = source_diagnostics.into_iter().collect();
                (
                    SourceState::Stale,
                    format!("Import completed with diagnostics: {}.", codes.join(", ")),
                )
            } else if !found.is_empty() {
                (SourceState::Current, "Authorized logs are current.".to_owned())
            } else {
                (
                    SourceState::Detected,
                    "No supported logs found in authorized paths.".to_owned(),
                )
            };
            let imported_at = (!failed).then_some(timestamp.as_str());
            lock(&self.store).set_source_state(tool, state, &message, imported_at)?;
        }
        let timestamp = iso_timestamp((self.now)());
        let mut store = lock(&self.store);
        store.set_last_scan_at(&timestamp)?;
        Ok(ScanResult {
            status: CollectorStatus {
                sources: store.source_statuses()?,
                collecting: false,
                last_scan_at: store.last_scan_at()?,
            },
            diagnostics: diagnostics.into_iter().collect(),
        })
    }
    /// The parents of Codex forks among the files found: each rollout's running totals by its thread, read once a scan.
    fn parents(&self, tool: ToolId, found: &[Found]) -> Parents {
        let rollouts: HashMap<String, (PathBuf, PathBuf)> = found
            .iter()
            .filter_map(|file| {
                Some((
                    rollout_thread(&file.path)?.to_owned(),
                    (file.path.clone(), file.root.clone()),
                ))
            })
            .collect();
        let read: Mutex<HashMap<String, Option<Arc<HashSet<RawCounts>>>>> = Mutex::default();
        let limit = self.max_archive_bytes;
        Parents::new(move |thread| {
            lock(&read)
                .entry(thread.to_owned())
                .or_insert_with(|| {
                    let (path, root) = rollouts.get(thread)?;
                    rollout_totals(tool, path, root, limit).map(Arc::new)
                })
                .clone()
        })
    }
    /// The supported files below each root, in walk order. Files found before a failure are kept and still read.
    fn discover(&self, tool: ToolId, roots: &[String], found: &mut Vec<Found>) -> Result<()> {
        // Where each file is in `found`, so one below two saved roots is found once.
        let mut seen = HashMap::new();
        for root in roots {
            let root = Path::new(root);
            // Canonical roots are pinned at authorization. Replacement with a symlink cannot expand an existing
            // permission grant.
            if fs::canonicalize(root)? != root {
                return Err(ServiceError::SourceScopeChanged);
            }
            self.walk(tool, root, root, 0, found, &mut seen)?;
        }
        Ok(())
    }
    fn walk(
        &self,
        tool: ToolId,
        root: &Path,
        path: &Path,
        depth: usize,
        found: &mut Vec<Found>,
        seen: &mut HashMap<PathBuf, usize>,
    ) -> Result<()> {
        let stat = fs::symlink_metadata(path)?;
        if stat.is_symlink() {
            return Ok(());
        }
        if stat.is_file() {
            let Some(kind) = source_kind(tool, path) else {
                return Ok(());
            };
            // Found again from another saved root: it keeps its place and takes the wider root, whose scope covers
            // its sidecars.
            if let Some(&at) = seen.get(path) {
                if found[at].root.starts_with(root) {
                    found[at].root = root.to_path_buf();
                }
                return Ok(());
            }
            if found.len() >= self.max_files {
                return Err(ServiceError::SourceFileLimit);
            }
            if !inside(root, path) {
                return Err(ServiceError::SourceScopeChanged);
            }
            seen.insert(path.to_path_buf(), found.len());
            found.push(Found {
                root: root.to_path_buf(),
                path: path.to_path_buf(),
                kind,
            });
            return Ok(());
        }
        if !stat.is_dir() {
            return Ok(());
        }
        if depth > self.max_depth {
            return Err(ServiceError::SourceDepthLimit);
        }
        let mut entries = fs::read_dir(path)?.collect::<io::Result<Vec<DirEntry>>>()?;
        // `localeCompare` order in TypeScript; fixtures/README.md guarantees it is byte order for every fixture.
        entries.sort_by_key(DirEntry::file_name);
        for entry in entries {
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            let child = path.join(entry.file_name());
            if kind.is_dir() || (kind.is_file() && source_kind(tool, &child).is_some()) {
                self.walk(tool, root, &child, depth + 1, found, seen)?;
            }
        }
        Ok(())
    }
    /// Whole JSON documents are re-read when their size or times change, or when a sidecar does (its version is kept in
    /// `prefix_hash`); a partly written one waits for the next scan.
    fn ingest_document(&self, tool: ToolId, path: &Path, root: &Path) -> Result<Vec<String>> {
        let Opened { mut file, stat } = open_inside(path, root)?;
        let previous = lock(&self.store).checkpoint(&text(path), Some(tool))?;
        let sidecar_stamp = sidecar_version(tool, path, root);
        if let Some(previous) =
            previous.filter(|previous| previous.prefix_hash == sidecar_stamp && stat.matches(previous))
        {
            return Ok(previous.diagnostics);
        }
        let mut result = ParseResult {
            events: Vec::new(),
            diagnostics: vec!["record_too_large".to_owned()],
            withdrawn: None,
        };
        if stat.size <= MAX_DOCUMENT_BYTES {
            let Some(bytes) = read_document_bytes(&mut file, MAX_DOCUMENT_BYTES)? else {
                // SECURITY: Growth is retried without checkpointing a partial snapshot (VULN-004).
                return Ok(vec![PENDING.to_owned()]);
            };
            let after = Stat::of_file(&file)?;
            if bytes.len() as u64 != stat.size || after.size != stat.size || after.mtime_ms != stat.mtime_ms {
                return Ok(vec![PENDING.to_owned()]);
            }
            let content = String::from_utf8_lossy(&bytes).into_owned();
            let mut sidecars = Sidecars::new();
            let siblings = adapter(tool).and_then(|adapter| adapter.sidecars);
            for (role, sibling) in siblings.map_or_else(Vec::new, |sidecars| sidecars(path)) {
                sidecars.insert(role, read_sidecar(&sibling, root)?);
            }
            result = parse_document(tool, path, &content, &sidecars);
            if result.diagnostics.iter().any(|code| code == PENDING) {
                return Ok(vec![PENDING.to_owned()]);
            }
        }
        let checkpoint = FileCheckpoint {
            path: text(path),
            tool,
            identity: stat.identity,
            offset: stat.size,
            prefix_hash: sidecar_stamp,
            parser_version: PARSER_VERSION.into(),
            state: new_parser_state()?,
            diagnostics: result.diagnostics.clone(),
            file_size: Some(stat.size),
            mtime_ms: Some(stat.mtime_ms),
            ctime_ms: Some(stat.ctime_ms),
        };
        let withdrawn = result.withdrawn.as_deref().unwrap_or_default();
        lock(&self.store).commit_file_withdrawing(&checkpoint, &result.events, false, withdrawn)?;
        Ok(result.diagnostics)
    }
    /// SQLite stores are opened read-only and re-read in full when the database or its WAL changes. A busy, locked or
    /// unreadable database fails this scan without a checkpoint, so the next scan retries it.
    fn ingest_database(&self, tool: ToolId, path: &Path, root: &Path) -> Result<Vec<String>> {
        let stat = open_inside(path, root)?.stat;
        let mut wal = path.as_os_str().to_owned();
        wal.push("-wal");
        let wal = Stat::of_path(Path::new(&wal)).ok();
        // `JSON.stringify([size, mtimeMs, ctimeMs, wal?.size ?? null, wal?.mtimeMs ?? null])`.
        let (wal_size, wal_mtime) = wal.map_or(("null".to_owned(), "null".to_owned()), |wal| {
            (wal.size.to_string(), js_number(wal.mtime_ms))
        });
        let version = digest(format!(
            "[{},{},{},{wal_size},{wal_mtime}]",
            stat.size,
            js_number(stat.mtime_ms),
            js_number(stat.ctime_ms)
        ));
        let previous = lock(&self.store).checkpoint(&text(path), Some(tool))?;
        if let Some(previous) = previous.as_ref().filter(|previous| {
            previous.identity == stat.identity
                && previous.parser_version == i64::from(PARSER_VERSION)
                && previous.prefix_hash == version
                // Other physical stores can restore an ancestor without changing this database. Re-evaluate a
                // provisional snapshot against persisted lineage rather than freezing its old diagnostic forever.
                && !previous.diagnostics.iter().any(|code| code == "fork_lineage_unavailable")
        }) {
            return Ok(previous.diagnostics.clone());
        }
        let known = if crate::readers::counts_across_copies(tool) {
            lock(&self.store).tool_events(tool)?
        } else {
            lock(&self.store).file_events(&text(path), tool)?
        };
        let incremental = adapter(tool).and_then(|adapter| adapter.incremental);
        // The same database at the same parser version resumes at its watermark; any other starts again from 0.
        let resume = previous
            .as_ref()
            .filter(|previous| {
                previous.identity == stat.identity && previous.parser_version == i64::from(PARSER_VERSION)
            })
            .map_or(0, |previous| previous.offset);
        let (mut result, origins, watermark) = match incremental {
            Some(read) => {
                let (result, watermark) = read(path, &known, resume)?;
                (result, Vec::new(), watermark)
            }
            None => {
                let known_origins = lock(&self.store).usage_origins()?;
                let (result, origins) = crate::readers::read_database_with_origins(tool, path, &known, &known_origins)?;
                (result, origins, 0)
            }
        };
        if lock(&self.store).is_local_only_file(&text(path), tool)? {
            add(&mut result.diagnostics, "kilo_history_local_only");
        }
        // SQLite opens the path again; discard what it read if the file was swapped in the meantime.
        let after = fs::symlink_metadata(path)?;
        if after.is_symlink()
            || Stat::of_link(path, &after)?.identity != stat.identity
            || !inside(root, &fs::canonicalize(path)?)
        {
            return Err(ServiceError::SourceScopeChanged);
        }
        let checkpoint = FileCheckpoint {
            path: text(path),
            tool,
            identity: stat.identity,
            offset: watermark,
            prefix_hash: version,
            parser_version: PARSER_VERSION.into(),
            state: new_parser_state()?,
            diagnostics: result.diagnostics.clone(),
            file_size: Some(stat.size),
            mtime_ms: Some(stat.mtime_ms),
            ctime_ms: Some(stat.ctime_ms),
        };
        lock(&self.store).commit_with_origins(
            &checkpoint,
            &result.events,
            false,
            result.withdrawn.as_deref().unwrap_or_default(),
            &origins,
        )?;
        Ok(result.diagnostics)
    }
    /// Archives are written once: each is read whole, decompressed as a stream, and read again only when its identity,
    /// size or times change. One that is corrupt, or decompresses past `max_archive_bytes`, reports a diagnostic and
    /// keeps the usage counted from it before.
    fn ingest_archive(&self, tool: ToolId, path: &Path, root: &Path, parents: &Parents) -> Result<Vec<String>> {
        let Opened { file, stat } = open_inside(path, root)?;
        let previous = lock(&self.store).checkpoint(&text(path), Some(tool))?;
        if let Some(previous) = previous.filter(|previous| stat.matches(previous)) {
            return Ok(previous.diagnostics);
        }
        let ledger = adapter(tool).is_some_and(|adapter| adapter.ledger);
        let (events, diagnostics, replace, limits) = match self.read_archive(tool, path, &file, parents) {
            Ok((events, diagnostics, limits)) => (events, diagnostics, !ledger, limits),
            Err(code) => (Vec::new(), vec![code.to_owned()], false, None),
        };
        let after = Stat::of_file(&file)?;
        if after.size != stat.size || after.mtime_ms != stat.mtime_ms || after.ctime_ms != stat.ctime_ms {
            return Err(ServiceError::FileChangedDuringScan);
        }
        let checkpoint = FileCheckpoint {
            path: text(path),
            tool,
            identity: stat.identity,
            offset: stat.size,
            // Nothing is appended to an archive, so there is no prefix to verify.
            prefix_hash: digest(""),
            parser_version: PARSER_VERSION.into(),
            state: new_parser_state()?,
            diagnostics: diagnostics.clone(),
            file_size: Some(stat.size),
            mtime_ms: Some(stat.mtime_ms),
            ctime_ms: Some(stat.ctime_ms),
        };
        self.offer_limits(limits.as_ref())?;
        lock(&self.store).commit_file(&checkpoint, &events, replace)?;
        Ok(diagnostics)
    }
    /// The usage in one archive, split into lines as `ingest_file` splits a log, and its last rate-limit snapshot, or
    /// the diagnostic that skips it.
    fn read_archive(
        &self,
        tool: ToolId,
        path: &Path,
        file: &File,
        parents: &Parents,
    ) -> std::result::Result<Archive, &'static str> {
        let mut state = ParserState {
            parents: parents.clone(),
            ..ParserState::default()
        };
        let (mut events, mut diagnostics) = (Vec::new(), Vec::new());
        let mut each = |line: Option<&[u8]>| match line {
            None => add(&mut diagnostics, "record_too_large"),
            Some(line) => {
                let result = parse_usage_line(tool, &String::from_utf8_lossy(line), path, &mut state);
                events.extend(result.events);
                for code in &result.diagnostics {
                    add(&mut diagnostics, code);
                }
            }
        };
        let mut lines = Lines::new(tool);
        decompress(file, self.max_archive_bytes, |bytes| lines.push(bytes, &mut each))?;
        lines.finish(&mut each);
        Ok((events, diagnostics, state.rate_limits))
    }
    /// Appended lines are read from the checkpoint's offset once the 64 bytes before it are verified again; any other
    /// change reads the file afresh, and replaces its events unless the tool is an append-only ledger.
    fn ingest_file(&self, tool: ToolId, path: &Path, root: &Path, parents: &Parents) -> Result<Vec<String>> {
        let previous = lock(&self.store).checkpoint(&text(path), Some(tool))?;
        // An unchanged log needs no open; anything else, a swapped symlink included, takes the checks below.
        if let Some(previous) = &previous
            && Stat::of_path(path)?.matches(previous)
        {
            return Ok(previous.diagnostics.clone());
        }
        let Opened { file, stat } = open_inside(path, root)?;
        if let Some(previous) = previous.as_ref().filter(|previous| stat.matches(previous)) {
            return Ok(previous.diagnostics.clone());
        }
        let mut chunk = vec![0u8; CHUNK];
        let mut checkpoint = previous.filter(|previous| {
            previous.tool == tool
                && previous.identity == stat.identity
                && previous.parser_version == i64::from(PARSER_VERSION)
                && previous.offset <= stat.size
        });
        // Only a log that grew is read on from its offset, and only while the bytes before it are still there. A
        // same-size rewrite, a shrink or an edited tail is read afresh.
        let grew = checkpoint
            .as_ref()
            .is_some_and(|previous| previous.file_size.is_some_and(|size| stat.size > size));
        if let Some(previous) = &checkpoint
            && !(grew && tail_hash(&file, previous.offset)? == previous.prefix_hash)
        {
            checkpoint = None;
        }
        let replace = checkpoint.is_none();
        let mut position = checkpoint.as_ref().map_or(0, |previous| previous.offset);
        let mut state: ParserState = match &checkpoint {
            Some(checkpoint) => serde_json::from_value(checkpoint.state.clone()).map_err(StoreError::Json)?,
            None => ParserState::default(),
        };
        state.parents = parents.clone();
        let limits = state.rate_limits;
        let mut offset = position;
        let (mut pending, mut length, mut oversized) = (Vec::new(), 0usize, false);
        let limit = line_limit(tool);
        // A line too long to read is reported only where it may have held usage.
        let mut usage = MayHoldUsage::new(tool);
        let mut events = Vec::new();
        let mut diagnostics = Vec::new();
        for code in checkpoint.iter().flat_map(|checkpoint| &checkpoint.diagnostics) {
            if code != "partial_line_pending" {
                add(&mut diagnostics, code);
            }
        }
        while position < stat.size {
            let want = CHUNK.min((stat.size - position) as usize);
            let read = file.read_at(&mut chunk[..want], position)?;
            if read == 0 {
                return Err(ServiceError::FileChangedDuringScan);
            }
            let bytes = &chunk[..read];
            let mut start = 0;
            for index in (0..bytes.len()).filter(|&index| bytes[index] == b'\n') {
                let fragment = &bytes[start..index];
                length += fragment.len();
                if !oversized && length <= limit {
                    pending.extend_from_slice(fragment);
                } else {
                    if !oversized {
                        usage.feed(&pending);
                    }
                    usage.feed(fragment);
                    oversized = true;
                }
                if oversized {
                    if usage.take() {
                        add(&mut diagnostics, "record_too_large");
                    }
                } else {
                    let result = parse_usage_line(tool, &String::from_utf8_lossy(&pending), path, &mut state);
                    events.extend(result.events);
                    for code in &result.diagnostics {
                        add(&mut diagnostics, code);
                    }
                }
                (length, oversized) = (0, false);
                pending.clear();
                offset = position + index as u64 + 1;
                start = index + 1;
            }
            if start < bytes.len() {
                let fragment = &bytes[start..];
                length += fragment.len();
                if !oversized && length <= limit {
                    pending.extend_from_slice(fragment);
                } else {
                    if !oversized {
                        usage.feed(&pending);
                    }
                    usage.feed(fragment);
                    oversized = true;
                    pending.clear();
                }
            }
            position += read as u64;
        }
        if length > 0 && !oversized {
            add(&mut diagnostics, "partial_line_pending");
        } else if length > 0 && usage.take() {
            add(&mut diagnostics, "record_too_large");
        }
        let after = Stat::of_file(&file)?;
        if changed_during_read(&stat, &after) {
            return Err(ServiceError::FileChangedDuringScan);
        }
        let next = FileCheckpoint {
            path: text(path),
            tool,
            identity: stat.identity,
            offset,
            prefix_hash: tail_hash(&file, offset)?,
            parser_version: PARSER_VERSION.into(),
            state: serde_json::to_value(&state).map_err(StoreError::Json)?,
            diagnostics: diagnostics.clone(),
            file_size: Some(stat.size),
            mtime_ms: Some(stat.mtime_ms),
            ctime_ms: Some(stat.ctime_ms),
        };
        let ledger = adapter(tool).is_some_and(|adapter| adapter.ledger);
        // Offered before the checkpoint that records it, so a crash between the two offers it again.
        if state.rate_limits != limits {
            self.offer_limits(state.rate_limits.as_ref())?;
        }
        lock(&self.store).commit_file(&next, &events, replace && !ledger)?;
        Ok(diagnostics)
    }
    /// Claude Code's cached usage-limit reading (F6), with the scan of its enabled source: whatever its settings file
    /// holds now replaces the stored reading, and no file, or no reading for the account signed in, clears it. The
    /// file is parsed in memory and read again only once it changes; nothing but the reading's figures is kept.
    fn read_claude_limits(&self) -> Result<()> {
        let Some(path) = &self.claude_config_file else {
            return Ok(());
        };
        #[cfg(unix)]
        let stat = fs::metadata(path).ok().map(|metadata| Stat::of(&metadata));
        // The file a link leads to, as `fs::metadata` reads it.
        #[cfg(windows)]
        let stat = File::open(path).and_then(|file| Stat::of_file(&file)).ok();
        let mut seen = lock(&self.claude_config_seen);
        if seen.as_ref() == Some(&stat) {
            return Ok(());
        }
        let reading = stat
            .as_ref()
            .and_then(|_| read_claude_config(path, MAX_CLAUDE_CONFIG_BYTES))
            .and_then(|content| claude_reading(&content));
        lock(&self.store).replace_limits(ToolId::Claude, reading.as_ref())?;
        *seen = Some(stat);
        Ok(())
    }
    /// A Codex rollout's latest rate-limit snapshot, kept when no rollout's is later (F6).
    fn offer_limits(&self, limits: Option<&RateLimits>) -> Result<()> {
        if let Some(limits) = limits {
            lock(&self.store).update_limits(&LimitReading::codex(limits))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    #[test]
    fn document_reads_accept_empty_exact_and_short_bodies_but_reject_excess() {
        for (content, limit, expected) in [
            (&b""[..], 0, Some(&b""[..])),
            (&b"abc"[..], 3, Some(&b"abc"[..])),
            (&b"abc"[..], 4, Some(&b"abc"[..])),
            (&b"abcd"[..], 3, None),
            (&b"x"[..], 0, None),
        ] {
            assert_eq!(
                read_document_bytes(Cursor::new(content), limit).unwrap().as_deref(),
                expected
            );
        }
    }

    #[test]
    fn endless_document_reads_stop_after_one_excess_byte() {
        let mut endless = io::repeat(b'x').take(1_000_000);
        assert!(read_document_bytes(&mut endless, 16).unwrap().is_none());
        assert_eq!(endless.limit(), 1_000_000 - 17);
    }

    #[test]
    fn file_growth_after_metadata_does_not_expand_the_read_budget() {
        let folder = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(folder.path()).unwrap();
        let path = root.join("document.json");
        fs::write(&path, b"a").unwrap();
        let Opened { mut file, stat } = open_inside(&path, &root).unwrap();
        assert_eq!(stat.size, 1);
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[b'x'; 32])
            .unwrap();
        assert!(read_document_bytes(&mut file, 16).unwrap().is_none());
        let mut remainder = Vec::new();
        file.read_to_end(&mut remainder).unwrap();
        assert_eq!(
            remainder.len(),
            16,
            "only limit + 1 bytes were consumed after the stale stat"
        );
    }

    #[test]
    fn document_io_failures_are_propagated() {
        struct Fails;
        impl Read for Fails {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("synthetic read failure"))
            }
        }
        assert!(read_document_bytes(Fails, 16).is_err());
    }

    #[test]
    fn sidecar_limits_preserve_valid_content_and_scope_checks() {
        let folder = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(folder.path()).unwrap();
        let path = root.join("metadata.json");
        fs::write(&path, "{\"valid\":true}").unwrap();
        assert_eq!(read_sidecar(&path, &root).unwrap().as_deref(), Some("{\"valid\":true}"));
        #[cfg(unix)]
        {
            let link = root.join("link.json");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(read_sidecar(&link, &root).unwrap().is_none());
        }
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        assert!(read_sidecar(&path, &root).unwrap().is_none());
    }

    #[test]
    fn document_retries_do_not_freeze_partial_or_previously_oversized_content() {
        let folder = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(folder.path()).unwrap();
        let path = root.join("ui_messages.json");
        let store = Arc::new(Mutex::new(UsageStore::open(root.join("usage.sqlite")).unwrap()));
        let service = IngestionService::new(store.clone(), IngestionOptions::default()).unwrap();
        fs::write(&path, "[").unwrap();
        assert_eq!(service.ingest_document(ToolId::Cline, &path, &root).unwrap(), [PENDING]);
        assert!(
            lock(&store)
                .checkpoint(&text(&path), Some(ToolId::Cline))
                .unwrap()
                .is_none()
        );
        fs::write(&path, "[]").unwrap();
        assert!(service.ingest_document(ToolId::Cline, &path, &root).unwrap().is_empty());
        assert!(
            lock(&store)
                .checkpoint(&text(&path), Some(ToolId::Cline))
                .unwrap()
                .is_some()
        );
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        assert_eq!(
            service.ingest_document(ToolId::Cline, &path, &root).unwrap(),
            ["record_too_large"]
        );
        fs::write(&path, "[]").unwrap();
        assert!(service.ingest_document(ToolId::Cline, &path, &root).unwrap().is_empty());
    }

    fn stat(size: u64, time: f64) -> Stat {
        Stat {
            identity: "1:2".into(),
            size,
            mtime_ms: time,
            ctime_ms: time,
        }
    }
    #[test]
    fn growth_while_reading_is_not_a_change() {
        assert!(!changed_during_read(&stat(100, 1.0), &stat(150, 2.0)));
        assert!(!changed_during_read(&stat(100, 1.0), &stat(100, 1.0)));
        assert!(changed_during_read(&stat(100, 1.0), &stat(90, 2.0)));
        assert!(changed_during_read(&stat(100, 1.0), &stat(100, 2.0)));
    }
}
