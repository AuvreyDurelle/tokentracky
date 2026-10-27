//! Pure readers: file content in, `ParseResult` out. Synthetic cases in `fixtures/` specify accounting behaviour.
//!
//! What the ingestion service (`service.rs`) uses:
//! - [`adapter`] gives a tool's [`Adapter`] (`None` for Cursor); [`is_supported`] and [`source_kind`] are shortcuts.
//!   `kind` classifies a path below an authorised root as a [`SourceKind`] or never opens it; `ledger` keeps usage once
//!   seen when a file is rewritten or truncated; `database_supersedes_documents` withdraws `json` documents once a
//!   `sqlite` file is found.
//! - `Jsonl`: each complete line, without its newline, decoded as lossy UTF-8 and at most [`line_limit`] bytes (a longer
//!   one is `record_too_large` without being parsed), goes to [`parse_usage_line`] with the file's [`ParserState`]
//!   (`ParserState::default()` for a new file; serde round-trips it inside the checkpoint). A final line without a
//!   newline is left pending (`partial_line_pending`).
//! - `CompressedJsonl` (Codex archives, DeepSeek Harness logs): the whole file, decompressed as a stream (one zstd frame
//!   or several), goes line by line to [`parse_usage_line`] as `Jsonl` does, with a fresh [`ParserState`]; a final line
//!   needs no newline.
//! - `Json`: a document of at most [`MAX_DOCUMENT_BYTES`] goes to [`parse_document`] with the [`Sidecars`] that
//!   `adapter.sidecars` names, each read inside the same root (`None` when absent, out of scope or too large).
//!   A [`PENDING`] diagnostic means the document or a sidecar is mid-write: retry next scan, write no checkpoint.
//! - `Sqlite`: an OpenCode-format database (OpenCode, Kilo Code, Mimo Code, DuMate: [`read_opencode_database`]) opens
//!   the file read-only, given the events already counted from it (the store's `file_events`); an `Err` (busy, locked,
//!   unreadable) fails that file for this scan. Any other database has `incremental`, which reads from the watermark
//!   the last scan returned (kept as the checkpoint's `offset`), or whole when it always returns 0; usage it does not
//!   return again stays.
//! - A Codex rollout also carries its latest local rate-limit snapshot in [`ParserState`].
//! - A `ParseResult` may list `withdrawn` event ids (usage the source now marks as another tool's); the commit removes
//!   them even from a ledger.
//! - [`digest`] is the SHA-256 hex of event-id keys and checkpoint prefixes; [`PARSER_VERSION`] invalidates checkpoints;
//!   [`is_metadata_text`] is the store's metadata check.
//!
//! [`parse_usage_file`] reads a whole log at once (a valid final line needs no newline); tests compare it with goldens.
//! Events and diagnostics never hold prompts, responses, paths or raw records, and diagnostics are fixed codes.
mod adapters;
mod cline;
mod codebuddy;
mod commandcode;
mod copilot;
mod deepseek;
mod dumate;
mod everycode;
mod goose;
mod grok;
mod hermes;
pub(crate) mod iso;
mod kimi;
mod lmstudio;
mod mimo;
mod openclaw;
mod opencode;
mod parser;
mod pi;
mod reasonix;
mod roo;
mod unsloth;
mod zcode;
mod zed;

pub use adapters::{
    Adapter, IncrementalReader, MAX_DOCUMENT_BYTES, NO_CAPABILITIES, SidecarPaths, Sidecars, SourceKind, adapter,
    counts_across_copies, is_supported, parse_document, source_kind,
};
pub(crate) use opencode::read_database_with_origins;
pub use opencode::read_opencode_database;
pub use parser::{
    MAX_LINE_BYTES, PARSER_VERSION, PENDING, Parents, ParserState, RateLimits, RateWindow, RawCounts, digest,
    is_metadata_text, line_limit, parse_gemini_session, parse_usage_file, parse_usage_line,
};
pub(crate) use parser::{MayHoldUsage, codex_total};
