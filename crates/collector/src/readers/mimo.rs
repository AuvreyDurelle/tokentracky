//! Mimo Code: an OpenCode fork whose `mimocode.db` (`mimocode-<channel>.db` outside the stable channels) holds the
//! OpenCode tables. `session.ts` `getUsage` stores input without either cache and output without reasoning, as
//! OpenCode does, and `tokens.total` as the provider's total, which must then equal all five.
use super::adapters::{Adapter, SourceKind};
use super::opencode::{self, Dialect, Reasoning};
use super::parser::file_name;
use tokentracky_core::{SourceCapabilities, ToolId};

/// Mimo Code mirrors Claude Code, Codex and OpenCode history into its database under their own providers
/// (`anthropic`, `openai`, ...); only its own providers' rows are its usage.
pub(crate) const DIALECT: Dialect = Dialect {
    providers: Some(&["mimo", "xiaomi"]),
    reasoning: Reasoning::SeparateChecked,
    forks: true,
};

static MIMO: Adapter = Adapter {
    passive: true,
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: false,
        quotas: false,
    },
    kind: |path| {
        let name = file_name(path);
        (name.starts_with("mimocode") && name.ends_with(".db")).then_some(SourceKind::Sqlite)
    },
    ledger: true,
    document: None,
    sidecars: None,
    database: Some(|path, known| opencode::read_opencode_database(ToolId::Mimo, path, known)),
    incremental: None,
    line: None,
    text: None,
    database_supersedes_documents: false,
};

pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&MIMO)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opencode::reasoning_inside;
    use serde_json::Value;

    #[test]
    fn reasoning_is_outside_output_and_a_total_must_count_it() {
        let inside = |total: Option<u64>, kinds, reasoning| {
            let total = total.map(Value::from);
            reasoning_inside(DIALECT.reasoning, total.as_ref(), kinds, reasoning).ok()
        };
        assert_eq!(inside(Some(1200), [700, 300, 100, 0], 100), Some(false));
        assert_eq!(inside(None, [700, 300, 100, 0], 100), Some(false));
        assert_eq!(inside(Some(1100), [700, 300, 100, 0], 100), None);
        assert_eq!(inside(Some(5), [700, 300, 100, 0], 100), None);
    }
}
