//! Shared types, validation and UTC day maths. Ported from `packages/core`.
//! JSON field names, optionality and unions match the TypeScript types generated from them (see README).
mod activity;
mod ranking;
pub use activity::{ActivityStats, DayTokens, activity_stats};
pub use ranking::{CounterOverflow, MAX_SAFE_INTEGER, checked_sum, is_safe_count, is_utc_day, ranking_window};

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ToolId {
    Claude,
    Codex,
    Cursor,
    Gemini,
    Cline,
    Roo,
    Kilo,
    OpenCode,
    EveryCode,
    Mimo,
    DuMate,
    Pi,
    Omp,
    Omo,
    PrimeAgent,
    MiniMax,
    CodeBuddy,
    Kimi,
    CommandCode,
    DeepSeek,
    LmStudio,
    Copilot,
    Unsloth,
    ZCode,
    Zed,
    OpenClaw,
    Reasonix,
    Hermes,
    Goose,
    Grok,
}
/// Every tool, in display order (`TOOL_IDS` in TypeScript).
pub const TOOL_IDS: &[ToolId] = &[
    ToolId::Claude,
    ToolId::Codex,
    ToolId::Cursor,
    ToolId::Gemini,
    ToolId::Cline,
    ToolId::Roo,
    ToolId::Kilo,
    ToolId::OpenCode,
    ToolId::EveryCode,
    ToolId::Mimo,
    ToolId::DuMate,
    ToolId::Pi,
    ToolId::Omp,
    ToolId::Omo,
    ToolId::PrimeAgent,
    ToolId::MiniMax,
    ToolId::CodeBuddy,
    ToolId::Kimi,
    ToolId::CommandCode,
    ToolId::DeepSeek,
    ToolId::LmStudio,
    ToolId::Copilot,
    ToolId::Unsloth,
    ToolId::ZCode,
    ToolId::Zed,
    ToolId::OpenClaw,
    ToolId::Reasonix,
    ToolId::Hermes,
    ToolId::Goose,
    ToolId::Grok,
];
impl ToolId {
    /// Display name (`TOOL_NAMES` in TypeScript).
    pub const fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
            Self::Gemini => "Gemini CLI",
            Self::Cline => "Cline",
            Self::Roo => "Roo Code",
            Self::Kilo => "Kilo Code",
            Self::OpenCode => "OpenCode",
            Self::EveryCode => "Every Code",
            Self::Mimo => "Mimo Code",
            Self::DuMate => "DuMate",
            Self::Pi => "pi",
            Self::Omp => "oh-my-pi",
            Self::Omo => "OmO",
            Self::PrimeAgent => "Prime Agent",
            Self::MiniMax => "MiniMax Code",
            Self::CodeBuddy => "CodeBuddy",
            Self::Kimi => "Kimi Code",
            Self::CommandCode => "Command Code",
            Self::DeepSeek => "DeepSeek Harness",
            Self::LmStudio => "LM Studio",
            Self::Copilot => "GitHub Copilot",
            Self::Unsloth => "Unsloth Studio",
            Self::ZCode => "ZCode",
            Self::Zed => "Zed Agent",
            Self::OpenClaw => "OpenClaw",
            Self::Reasonix => "Reasonix",
            Self::Hermes => "Hermes Agent",
            Self::Goose => "Goose",
            Self::Grok => "Grok Build",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Period {
    Week,
    Month,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    /// Input excludes the separately counted cache buckets.
    #[ts(type = "number")]
    pub input: u64,
    /// Output includes reasoning; reasoning is informational and never added again.
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub reasoning: Option<u64>,
    /// The part of `cache_write` written for one hour (Claude), priced at its own rate; like reasoning, never added again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub cache_write_1h: Option<u64>,
}

/// Estimated cost by token kind, in micro-USD. The four kinds add up to the cost exactly. `cache_savings` is what the
/// cache reads would have cost as plain input, minus what they cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CostParts {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    #[ts(type = "number")]
    pub cache_savings: u64,
}
impl CostParts {
    /// The four cost components, excluding cache savings.
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
    /// Each kind added, or `None` on overflow.
    pub fn checked_add(self, other: Self) -> Option<Self> {
        Some(Self {
            input: self.input.checked_add(other.input)?,
            output: self.output.checked_add(other.output)?,
            cache_read: self.cache_read.checked_add(other.cache_read)?,
            cache_write: self.cache_write.checked_add(other.cache_write)?,
            cache_savings: self.cache_savings.checked_add(other.cache_savings)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    /// Stable source-event identity. Retained locally and never uploaded.
    pub event_id: String,
    /// Local-only identity of a Claude Code mirror of an OmO request; contains only the hashed message id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub claude_mirror_id: Option<String>,
    pub tool: ToolId,
    pub model: String,
    pub occurred_at: Option<String>,
    pub project: Option<String>,
    pub session_id: String,
    pub tokens: TokenCounts,
    /// Codex's service tier when known (`priority`); absent means Standard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub service_tier: Option<String>,
    /// Null means unavailable; never silently substitute a zero estimate.
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
    pub pricing_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct ParseResult {
    pub events: Vec<UsageEvent>,
    /// Sanitized codes only: no paths, raw records, prompts or credentials.
    pub diagnostics: Vec<String>,
    /// Event ids the source now marks as another tool's usage (an import). They are removed even where seen usage
    /// otherwise stays counted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub withdrawn: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    PermissionRequired,
    Detected,
    Importing,
    Current,
    Stale,
    Unsupported,
    Paused,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub id: ToolId,
    pub name: String,
    pub enabled: bool,
    pub state: SourceState,
    pub paths: Vec<String>,
    pub last_imported_at: Option<String>,
    #[ts(type = "number")]
    pub event_count: u64,
    pub message: String,
    #[ts(inline)]
    pub capabilities: SourceCapabilities,
}
/// What a source's records can provide (`SourceStatus.capabilities`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct SourceCapabilities {
    pub tokens: bool,
    pub models: bool,
    pub projects: bool,
    pub costs: bool,
    pub quotas: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    #[ts(type = "number")]
    pub tokens: u64,
    /// Tokens by kind; `tokens` is their total.
    pub breakdown: TokenCounts,
    /// Streaks and best day over the selected range (UTC days).
    pub activity: ActivityStats,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
    /// Cost by token kind; null under the same rule as `cost_microusd`.
    #[ts(type = "CostParts | null")]
    pub cost_parts: Option<CostParts>,
    pub sessions: u32,
    pub cache_rate: f64,
    #[ts(inline)]
    pub by_tool: Vec<ToolUsage>,
    #[ts(inline)]
    pub by_model: Vec<ModelUsage>,
    #[ts(inline)]
    pub daily: Vec<DayUsage>,
    /// Tokens by hour of day, 0 to 23, in the query's zone (UTC without one).
    #[ts(type = "Array<number>")]
    pub by_hour: Vec<u64>,
}
/// One tool's share of a summary (`UsageSummary.byTool`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    pub tool: ToolId,
    #[ts(type = "number")]
    pub tokens: u64,
    pub breakdown: TokenCounts,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
    #[ts(type = "CostParts | null")]
    pub cost_parts: Option<CostParts>,
    /// Distinct sessions, each tool's own, that used it.
    pub sessions: u32,
}
/// One model's share of a summary (`UsageSummary.byModel`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    #[ts(type = "number")]
    pub tokens: u64,
    pub breakdown: TokenCounts,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
    #[ts(type = "CostParts | null")]
    pub cost_parts: Option<CostParts>,
    /// Distinct sessions, each tool's own, that used it.
    pub sessions: u32,
}
/// One UTC day of a summary (`UsageSummary.daily`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: String,
    #[ts(type = "number")]
    pub tokens: u64,
    pub breakdown: TokenCounts,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
    #[ts(type = "CostParts | null")]
    pub cost_parts: Option<CostParts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub project: Option<String>,
    pub tool: ToolId,
    /// The latest event's model; `models` lists every model, largest first.
    pub model: String,
    pub models: Vec<String>,
    #[ts(type = "number")]
    pub tokens: u64,
    /// The session's tokens by kind; `tokens` is their total.
    pub breakdown: TokenCounts,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub name: String,
    /// `owner/repo` from the project's local git remote, when it is a repository. Local only.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub repository: Option<Option<String>>,
    #[ts(type = "number")]
    pub tokens: u64,
    /// Tokens by kind; `tokens` is their total.
    pub breakdown: TokenCounts,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
    pub sessions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfile {
    pub alias: String,
    pub rank: u32,
    #[ts(type = "number")]
    pub tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Partial<Record<ToolId, number>>")]
    pub tool_tokens: Option<BTreeMap<ToolId, u64>>,
    /// All-time tokens across every tool. Only on week and month rows; on all-time rows it would repeat the total.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub lifetime_tokens: Option<u64>,
    /// Estimated cost across all tools in the window, even when ranked by one tool.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | null")]
    pub cost_microusd: Option<Option<u64>>,
    /// Rank in the same window at the end of yesterday (UTC); null when the builder had no tokens before today.
    pub previous_rank: Option<u32>,
    /// Tokens per UTC day for the 14 days ending today, oldest first.
    #[ts(type = "Array<number>")]
    pub daily: Vec<u64>,
    /// Tokens in the last 24 whole UTC hours across every tool, like `lifetime_tokens`; absent until one of the member's
    /// computers uploads hourly totals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub last24h_tokens: Option<u64>,
    /// The member's three highest-tier badges, ties in display order; absent without any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub top_badges: Option<Vec<BadgeId>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardResponse {
    pub items: Vec<PublicProfile>,
    pub total: u32,
    /// Ranked builders in the window before any search: what "Top N%" divides by.
    #[serde(default)]
    pub builders: u32,
    pub page: u32,
    pub page_size: u32,
    pub period: Period,
    pub window_start: Option<String>,
    pub updated_at: String,
    #[ts(type = "number")]
    pub total_tokens: u64,
    /// Community tokens by tool, from builders who share their tool split.
    #[ts(type = "Partial<Record<ToolId, number>>")]
    pub tool_totals: BTreeMap<ToolId, u64>,
    /// Sum of known costs shared by builders; null when none are known.
    #[ts(type = "number | null")]
    pub total_cost_microusd: Option<u64>,
    /// Community tokens per UTC day for the 30 days ending today, oldest first.
    #[ts(inline)]
    pub trend: Vec<DayTokens>,
    /// Exact shared values beyond JavaScript's safe integer range. Corresponding numeric fields are lower bounds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exact_aggregates: Option<ExactAggregates>,
}

/// Decimal integer companions for shared aggregates. Maps and series are complete when present; null costs stay unknown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExactAggregates {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total_tokens: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total_cost_microusd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Partial<Record<ToolId, string>>")]
    pub tool_totals: Option<BTreeMap<ToolId, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub trend: Option<Vec<ExactDayTokens>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub breakdown: Option<ExactTokenCounts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ExactDayTokens {
    pub day: String,
    pub tokens: String,
}

/// Community token kinds as decimal integers. Reasoning is part of output and is never added to the total again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExactTokenCounts {
    pub input: String,
    pub output: String,
    pub cache_read: String,
    pub cache_write: String,
    pub reasoning: String,
}

/// The builders ranked just above and below one alias, and the alias itself (`/api/leaderboard/around/:alias`); empty
/// when the alias is not ranked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LeaderboardNeighbours {
    pub items: Vec<PublicProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub alias: String,
    pub history_start: Option<String>,
    pub share_tools: bool,
    pub share_cost: bool,
    /// Publish the model mix: buckets split by model, so profiles show favourite model and per-model cost.
    pub share_models: bool,
    pub generation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicBucket {
    /// UTC date YYYY-MM-DD, or null when the original timestamp is unavailable.
    pub day: Option<String>,
    /// Aggregate to `all` before upload when tool breakdown was not approved.
    #[ts(inline)]
    pub tool: BucketTool,
    /// Present only when model sharing was approved; the model id as the tool logged it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[ts(type = "number")]
    pub tokens: u64,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
    #[ts(type = "number")]
    pub revision: u64,
    /// Tokens by kind: input, output, cache read and cache write add up to `tokens`; reasoning (part of output) is
    /// always present. Never the one-hour cache-write part. Collectors always set it; older apps upload without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub breakdown: Option<TokenCounts>,
}
/// `ToolId | 'all'`: a public bucket is one tool's, or every tool's when the split is not shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BucketTool {
    All,
    #[serde(untagged)]
    Tool(ToolId),
}
/// One UTC hour's tokens for one tool, or every tool's as `all`: the leaderboard's 24-hour column. Nothing else about
/// the hour is uploaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PublicHour {
    /// The hour's first instant (`toISOString`).
    pub hour: String,
    #[ts(inline)]
    pub tool: BucketTool,
    #[ts(type = "number")]
    pub tokens: u64,
}

/// Model ids that may be published: what tools log, without separators or free text.
pub fn is_public_model(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:/@[]-".contains(c))
}

/// One builder's public page: everything is limited to what they chose to share.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStats {
    pub alias: String,
    /// Rank and tokens in each leaderboard window.
    #[ts(inline)]
    pub periods: PeriodRanks,
    /// Tokens per UTC day for the 365 days ending today, oldest first.
    #[ts(inline)]
    pub daily: Vec<DayTokens>,
    pub activity: ActivityStats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Partial<Record<ToolId, number>>")]
    pub tool_tokens: Option<BTreeMap<ToolId, u64>>,
    /// All-time estimated cost; null when any shared day lacks a price.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | null")]
    pub cost_microusd: Option<Option<u64>>,
    /// All-time tokens by model, largest first. Cost appears only when cost sharing is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub models: Option<Vec<ModelTokens>>,
    /// All-time tokens by kind, with reasoning; absent unless every shared bucket carries its kinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub breakdown: Option<TokenCounts>,
    /// Likes from visible members.
    pub likes: u32,
    /// The UTC day (`YYYY-MM-DD`) the member's account was created.
    pub member_since: String,
    /// Present when the member signed in with GitHub; read from GitHub's identity, never typed by the member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub github_login: Option<String>,
    /// Every badge, in display order (`BADGE_IDS`).
    pub badges: Vec<BadgeProgress>,
}
/// Rank and tokens in each leaderboard window (`ProfileStats.periods`, a `Record<Period, …>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PeriodRanks {
    #[ts(inline)]
    pub week: PeriodRank,
    #[ts(inline)]
    pub month: PeriodRank,
    #[ts(inline)]
    pub all: PeriodRank,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PeriodRank {
    pub rank: u32,
    #[ts(type = "number")]
    pub tokens: u64,
    // Ranked builders in the window: what "Top N%" divides by. A plain comment, since the type is inlined.
    #[serde(default)]
    pub builders: u32,
}
/// One model's all-time tokens on a profile (`ProfileStats.models`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelTokens {
    pub model: String,
    #[ts(type = "number")]
    pub tokens: u64,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | null")]
    pub cost_microusd: Option<Option<u64>>,
}

/// Landing-page totals across every published builder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommunityStats {
    pub builders: u32,
    /// Builders whose account was created in the last 7 days.
    pub new_builders: u32,
    #[ts(type = "number")]
    pub total_tokens: u64,
    #[ts(type = "number | null")]
    pub total_cost_microusd: Option<u64>,
    #[ts(type = "Partial<Record<ToolId, number>>")]
    pub tool_totals: BTreeMap<ToolId, u64>,
    /// Community tokens per UTC day for the 30 days ending today, oldest first.
    #[ts(inline)]
    pub trend: Vec<DayTokens>,
    pub updated_at: String,
    /// Community tokens by kind, with reasoning, summed over the buckets that carry kinds; null when none do.
    pub breakdown: Option<TokenCounts>,
    /// Exact shared values beyond JavaScript's safe integer range. Corresponding numeric fields are lower bounds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exact_aggregates: Option<ExactAggregates>,
}

/// Achievements (F7), computed on the hosted side from published data only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum BadgeId {
    TokenTitan,
    BigDay,
    Marathoner,
    Streak,
    WeekendWarrior,
    Momentum,
    Veteran,
    Podium,
    Multitool,
    Polyglot,
    Trendsetter,
}
/// Every badge, in display order (`BADGE_IDS` in TypeScript).
pub const BADGE_IDS: &[BadgeId] = &[
    BadgeId::TokenTitan,
    BadgeId::BigDay,
    BadgeId::Marathoner,
    BadgeId::Streak,
    BadgeId::WeekendWarrior,
    BadgeId::Momentum,
    BadgeId::Veteran,
    BadgeId::Podium,
    BadgeId::Multitool,
    BadgeId::Polyglot,
    BadgeId::Trendsetter,
];
/// One badge's tier and progress towards the next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BadgeProgress {
    pub id: BadgeId,
    /// 0 none, 1 bronze, 2 silver, 3 gold, 4 diamond.
    pub tier: u8,
    /// What the badge measures. For `podium` it is the best rank ever reached (lower is better; 0: never ranked).
    #[ts(type = "number")]
    pub value: u64,
    /// The next tier's threshold; null at diamond.
    #[ts(type = "number | null")]
    pub next: Option<u64>,
}
/// How many visible members hold each badge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AchievementRarity {
    /// Visible published members.
    pub builders: u32,
    /// Members holding at least bronze, silver, gold and diamond, in that order.
    #[ts(type = "Partial<Record<BadgeId, number[]>>")]
    pub holders: BTreeMap<BadgeId, [u32; 4]>,
}

/// The menu bar's overview for the local pages (`GET /api/local/overview`): the leaderboard-aligned totals and the
/// published weekly rank of the last refresh cycle, with the alias, collection and refresh as they are now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MenuOverview {
    #[ts(type = "number")]
    pub today: u64,
    #[ts(type = "number")]
    pub week: u64,
    #[ts(type = "number")]
    pub month: u64,
    #[ts(type = "number")]
    pub all_time: u64,
    /// The tool with the most tokens this week.
    #[ts(inline)]
    pub top_tool: Option<TopTool>,
    /// This week's published rank, when linked under an alias.
    #[ts(type = "number | null")]
    pub rank: Option<i64>,
    pub alias: Option<String>,
    pub paused: bool,
    pub refreshing: bool,
    /// When the cycle behind these totals finished; null before the first.
    pub refreshed_at: Option<String>,
    pub next_refresh_at: Option<String>,
    /// Each total's estimated cost.
    pub costs: PeriodCosts,
}
/// What the menu bar item shows beside its icon (`LocalSettings.menuBar`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum MenuBarShows {
    #[default]
    Tokens,
    Cost,
    Icon,
}
/// Which total the menu bar item shows (`LocalSettings.menuBarPeriod`): local days in the computer's zone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum MenuBarPeriod {
    #[default]
    Today,
    Week,
    Month,
    All,
}
/// The app's own settings, kept with the local history (`GET`/`PUT /api/local/settings`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSettings {
    pub menu_bar: MenuBarShows,
    pub menu_bar_period: MenuBarPeriod,
    /// The daily LiteLLM price-table download; off keeps the bundled snapshot.
    pub price_refresh: bool,
}
impl Default for LocalSettings {
    fn default() -> Self {
        Self {
            menu_bar: MenuBarShows::default(),
            menu_bar_period: MenuBarPeriod::default(),
            price_refresh: true,
        }
    }
}
/// Each period's estimated cost in micro-USD at the current prices: zero without usage, null when a model used in it
/// has no price.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeriodCosts {
    #[ts(type = "number | null")]
    pub today: Option<u64>,
    #[ts(type = "number | null")]
    pub week: Option<u64>,
    #[ts(type = "number | null")]
    pub month: Option<u64>,
    #[ts(type = "number | null")]
    pub all_time: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TopTool {
    pub tool: ToolId,
    #[ts(type = "number")]
    pub tokens: u64,
}

/// One day × tool × model aggregate, for cost and token analysis over time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdownRow {
    pub day: String,
    pub tool: ToolId,
    pub model: String,
    #[ts(type = "number")]
    pub tokens: u64,
    /// Tokens by kind; `tokens` is their total.
    pub breakdown: TokenCounts,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
}

/// One hour × tool × model aggregate: the Tokens page's bars of the last 24 hours.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HourBreakdownRow {
    /// The hour's first instant (`toISOString`).
    pub hour: String,
    pub tool: ToolId,
    pub model: String,
    #[ts(type = "number")]
    pub tokens: u64,
    /// Tokens by kind; `tokens` is their total.
    pub breakdown: TokenCounts,
    #[ts(type = "number | null")]
    pub cost_microusd: Option<u64>,
}

/// Input, output and both cache buckets; reasoning is already inside output.
pub fn total_tokens(tokens: &TokenCounts) -> u64 {
    tokens.input + tokens.output + tokens.cache_read + tokens.cache_write
}

/// Keeps `null` distinct from an absent field in `field?: T | null` (absent: not shared; null: unknown).
fn present<'de, T: Deserialize<'de>, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
    Option::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_reasoning_exactly_once_and_includes_disjoint_cache_counters() {
        let tokens = TokenCounts {
            input: 100,
            output: 60,
            cache_read: 40,
            cache_write: 20,
            reasoning: Some(50),
            cache_write_1h: Some(15),
        };
        assert_eq!(total_tokens(&tokens), 220);
    }
    #[test]
    fn serialises_unions_and_keeps_null_apart_from_absent() {
        let bucket = |tool| PublicBucket {
            day: None,
            tool,
            model: None,
            tokens: 1,
            cost_microusd: None,
            revision: 2,
            breakdown: None,
        };
        assert_eq!(serde_json::to_value(bucket(BucketTool::All)).unwrap()["tool"], "all");
        assert_eq!(
            serde_json::to_value(bucket(BucketTool::Tool(ToolId::OpenCode))).unwrap()["tool"],
            "opencode"
        );
        let parsed: PublicBucket = serde_json::from_value(
            json!({"day": null, "tool": "roo", "tokens": 1, "costMicrousd": null, "revision": 2}),
        )
        .unwrap();
        assert_eq!(
            parsed,
            bucket(BucketTool::Tool(ToolId::Roo)),
            "older apps upload without kinds"
        );
        let typed = PublicBucket {
            breakdown: Some(TokenCounts {
                input: 1,
                reasoning: Some(0),
                ..TokenCounts::default()
            }),
            ..bucket(BucketTool::All)
        };
        assert_eq!(
            serde_json::to_value(&typed).unwrap()["breakdown"],
            json!({"input": 1, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0})
        );
        assert!(serde_json::from_value::<BucketTool>(json!("other")).is_err());
        assert_eq!(
            serde_json::to_value(SourceState::PermissionRequired).unwrap(),
            "permission_required"
        );
        for (input, cost) in [
            (json!({}), None),
            (json!({"costMicrousd": null}), Some(None)),
            (json!({"costMicrousd": 5}), Some(Some(5))),
        ] {
            let mut value = json!({"model": "m", "tokens": 1});
            value
                .as_object_mut()
                .unwrap()
                .extend(input.as_object().unwrap().clone());
            let model: ModelTokens = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(model.cost_microusd, cost);
            assert_eq!(serde_json::to_value(&model).unwrap(), value);
        }
    }
    #[test]
    fn names_badges_in_kebab_case_and_display_order() {
        let ids: Vec<_> = BADGE_IDS.iter().map(|id| serde_json::to_value(id).unwrap()).collect();
        assert_eq!(
            ids,
            [
                "token-titan",
                "big-day",
                "marathoner",
                "streak",
                "weekend-warrior",
                "momentum",
                "veteran",
                "podium",
                "multitool",
                "polyglot",
                "trendsetter"
            ]
        );
        let progress = BadgeProgress {
            id: BadgeId::Podium,
            tier: 4,
            value: 1,
            next: None,
        };
        assert_eq!(
            serde_json::to_value(&progress).unwrap(),
            json!({"id": "podium", "tier": 4, "value": 1, "next": null})
        );
        let rarity = AchievementRarity {
            builders: 3,
            holders: BTreeMap::from([(BadgeId::WeekendWarrior, [2, 1, 0, 0])]),
        };
        let value = json!({"builders": 3, "holders": {"weekend-warrior": [2, 1, 0, 0]}});
        assert_eq!(serde_json::to_value(&rarity).unwrap(), value);
        assert_eq!(serde_json::from_value::<AchievementRarity>(value).unwrap(), rarity);
    }
    #[test]
    fn accepts_public_model_ids_only() {
        for id in [
            "claude-sonnet-4-5",
            "gpt-5.1-codex",
            "openrouter/anthropic/claude",
            "model@2026[1m]",
            "a",
        ] {
            assert!(is_public_model(id), "{id}");
        }
        for id in ["", "-model", "has space", "line\nbreak", "naïve", &"a".repeat(129)] {
            assert!(!is_public_model(id), "{id}");
        }
        assert!(is_public_model(&"a".repeat(128)));
    }
}
