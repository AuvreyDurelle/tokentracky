//! DuMate (Baidu): a desktop app running OpenCode, with its database at
//! `qianfan_desk_xdg/<install-id>/data/opencode/opencode.db`. A reinstall gets a new install id holding a copy of the
//! same messages; their event keys hold no install id, so the copies count once.
//! Its `tokens.total` shows output already including reasoning (input 1070 + output 888 + cache read 768 = total 2726,
//! with reasoning 818), unlike OpenCode, so each record is converted as its total shows.
use super::adapters::{Adapter, SourceKind};
use super::opencode::{self, Dialect, Reasoning};
use super::parser::file_name;
use tokentracky_core::{SourceCapabilities, ToolId};

/// The bundled `opencode import` copies Claude Code and OpenCode history under their own providers; DuMate's own
/// model proxy is `QianfanPersonalQuota`.
pub(crate) const DIALECT: Dialect = Dialect {
    providers: Some(&["QianfanPersonalQuota"]),
    reasoning: Reasoning::FromTotal,
    forks: true,
};

static DUMATE: Adapter = Adapter {
    capabilities: SourceCapabilities {
        tokens: true,
        models: true,
        projects: true,
        costs: false,
        quotas: false,
    },
    // `memory.db` beside it is not usage.
    kind: |path| (file_name(path) == "opencode.db").then_some(SourceKind::Sqlite),
    ledger: true,
    document: None,
    sidecars: None,
    database: Some(|path, known| opencode::read_opencode_database(ToolId::DuMate, path, known)),
    incremental: None,
    line: None,
    text: None,
    database_supersedes_documents: false,
};

pub(crate) fn adapter(_tool: ToolId) -> Option<&'static Adapter> {
    Some(&DUMATE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opencode::reasoning_inside;
    use serde_json::Value;

    #[test]
    fn the_total_shows_whether_output_includes_reasoning() {
        let inside = |total: Option<u64>, kinds, reasoning| {
            let total = total.map(Value::from);
            reasoning_inside(DIALECT.reasoning, total.as_ref(), kinds, reasoning).ok()
        };
        // 1070 + 888 + 768 = 2726, with reasoning 818 inside the output.
        assert_eq!(inside(Some(2726), [1070, 888, 768, 0], 818), Some(true));
        assert_eq!(inside(Some(170), [100, 50, 0, 0], 20), Some(false));
        assert_eq!(inside(None, [10, 5, 0, 0], 0), Some(false));
        assert_eq!(inside(None, [10, 5, 0, 0], 3), None);
        assert_eq!(inside(Some(999), [10, 5, 0, 0], 3), None);
    }
}
