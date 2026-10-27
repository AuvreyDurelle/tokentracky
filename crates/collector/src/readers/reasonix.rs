//! Reasonix: not read yet. Its `<session>.jsonl.telemetry.json` is not a total of
//! that session: one tally per process (esengine/DeepSeek-Reasonix `internal/session/control/goalusage.go`, built once
//! in `internal/assembly/boot/build.go`) is never loaded from the file or reset, so it restarts at zero when a session is
//! resumed and carries over into the next session that `/new` starts (`session_lifecycle.go`).
use super::adapters::Adapter;
use tokentracky_core::ToolId;

/// The tool's adapter, or `None` while it is not read.
pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    None
}
