//! Exact pricing cases, snapshot-version checks and JavaScript-compatible JSON serialization.
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    task::{Context, Poll, Waker},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokentracky_core::{CostParts, TokenCounts, ToolId};
use tokentracky_pricing::{
    Json, LITELLM_URL, MAX_DOWNLOAD_BYTES, PricedCost, PricingError, PricingRefresher, PricingTable, RefresherOptions,
    Transport, TransportError, bundled_table, pricing_refresh_enabled, trim_litellm,
};

const SNAPSHOT: &str = include_str!("../data/litellm-prices.json");
const CURATED: &str = include_str!("../data/curated-prices.json");

fn tokens(input: u64, output: u64, cache_read: u64, cache_write: u64) -> TokenCounts {
    TokenCounts {
        input,
        output,
        cache_read,
        cache_write,
        reasoning: None,
        cache_write_1h: None,
    }
}

fn json(text: &str) -> Json {
    serde_json::from_str(text).unwrap()
}

/// LiteLLM-shaped table text with exact synthetic rates, padded past the minimum model count. `extra` members
/// come last, so a repeated key replaces the earlier value in place, as in the TypeScript object spread.
fn synthetic_text(extra: &[&str]) -> String {
    let mut members = vec![
        r#""sample_spec":{"input_cost_per_token":0,"output_cost_per_token":0}"#.to_owned(),
        r#""tiered-model":{"mode":"chat","input_cost_per_token":3e-6,"output_cost_per_token":1.5e-5,"cache_read_input_token_cost":3e-7,"cache_creation_input_token_cost":3.75e-6,"input_cost_per_token_above_200k_tokens":6e-6,"output_cost_per_token_above_200k_tokens":2.25e-5,"cache_read_input_token_cost_above_200k_tokens":6e-7}"#.to_owned(),
        r#""no-cache-model":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":2e-6}"#.to_owned(),
        r#""image-model":{"mode":"image_generation","input_cost_per_token":1e-6,"output_cost_per_token":1e-6}"#.to_owned(),
        r#""broken-model":{"mode":"chat","input_cost_per_token":-1,"output_cost_per_token":1e-6}"#.to_owned(),
        r#""gemini/gemini-test":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":4e-6}"#.to_owned(),
        r#""gemini-test":{"mode":"chat","input_cost_per_token":9e-6,"output_cost_per_token":9e-6}"#.to_owned(),
    ];
    members.extend(
        (0..100).map(|i| {
            format!(r#""pad-{i}":{{"input_cost_per_token":1e-6,"output_cost_per_token":2e-6,"mode":"chat"}}"#)
        }),
    );
    members.extend(extra.iter().map(|member| (*member).to_owned()));
    format!("{{{}}}", members.join(","))
}

fn synthetic(extra: &[&str]) -> Json {
    json(&synthetic_text(extra))
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        // The fake transport never waits, so the first poll completes.
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}

fn snapshot_fetched_at_ms() -> i64 {
    let snapshot: serde_json::Value = serde_json::from_str(SNAPSHOT).unwrap();
    let fetched_at = snapshot["source"]["fetchedAt"].as_str().unwrap();
    (OffsetDateTime::parse(fetched_at, &Rfc3339)
        .unwrap()
        .unix_timestamp_nanos()
        / 1_000_000) as i64
}

/// A clock the test moves: hours after the bundled snapshot was fetched.
#[derive(Clone)]
struct TestClock(Arc<AtomicI64>);

fn later(hours: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(snapshot_fetched_at_ms() + hours * 3_600_000) * 1_000_000)
        .unwrap()
}

impl TestClock {
    fn at(hours: i64) -> Self {
        Self(Arc::new(AtomicI64::new(hours)))
    }
    fn set(&self, hours: i64) {
        self.0.store(hours, Ordering::SeqCst);
    }
    fn boxed(&self) -> tokentracky_pricing::Clock {
        let hours = self.0.clone();
        Box::new(move || later(hours.load(Ordering::SeqCst)))
    }
}

/// Answers every request with one canned reply and records the URLs it was asked for.
#[derive(Clone)]
struct Fake {
    reply: Result<String, String>,
    urls: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    fn new(reply: Result<String, String>) -> Self {
        Self {
            reply,
            urls: Arc::default(),
        }
    }
    fn table() -> Self {
        Self::new(Ok(synthetic_text(&[])))
    }
    fn calls(&self) -> usize {
        self.urls.lock().unwrap().len()
    }
}

impl Transport for Fake {
    fn fetch(&self, url: &str) -> impl Future<Output = Result<String, TransportError>> + Send {
        self.urls.lock().unwrap().push(url.to_owned());
        let reply = self.reply.clone().map_err(TransportError::from);
        async move { reply }
    }
}

fn options(cache_path: &Path, enabled: bool, transport: Fake, clock: &TestClock) -> RefresherOptions<Fake> {
    RefresherOptions {
        cache_path: cache_path.to_owned(),
        enabled,
        url: None,
        transport,
        now: Some(clock.boxed()),
    }
}

/// The expected `(cost_microusd, pricing_version)`; cost by kind is checked on its own.
fn cost(table: &PricingTable, micro: u64) -> Option<(u64, String)> {
    Some((micro, table.version().to_owned()))
}

fn plain(price: PricedCost) -> (u64, String) {
    (price.cost_microusd, price.pricing_version)
}
fn micro(table: &PricingTable, tokens: &TokenCounts, model: &str, tool: ToolId) -> Option<u64> {
    table.price(tokens, model, tool).map(|priced| priced.cost_microusd)
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

mod bundled_snapshot {
    use super::*;

    /// The version of the snapshot's LiteLLM part alone, without the hand-maintained list: `litellm:` and the first
    /// 12 hex digits of the SHA-256 of the JSON of its `models`, as the test below computes it.
    const TYPESCRIPT_VERSION: &str = "litellm:ebe634462118";

    #[test]
    fn is_pinned_licensed_and_large_enough_to_cover_real_tool_model_ids() {
        let snapshot: serde_json::Value = serde_json::from_str(SNAPSHOT).unwrap();
        assert_eq!(snapshot["source"]["repository"], "BerriAI/litellm");
        assert_eq!(snapshot["source"]["license"], "MIT");
        let commit = snapshot["source"]["commit"].as_str().unwrap();
        assert!(commit.len() == 40 && commit.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
        let table = bundled_table();
        assert!(table.size() > 2000);
        let hash = table.version().strip_prefix("litellm:").unwrap();
        assert!(hash.len() == 12 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    }

    /// The LiteLLM part hashes as TypeScript's version does; the version also covers the hand-maintained list,
    /// which TypeScript lacks, so a changed hand rate re-prices too.
    #[test]
    fn hashes_the_litellm_part_as_typescript_does_and_the_hand_list_after_it() {
        let models = json(SNAPSHOT).get("models").unwrap().to_json_string();
        let litellm = Sha256::digest(&models);
        assert_eq!(format!("litellm:{}", hex::encode(&litellm[..6])), TYPESCRIPT_VERSION);
        let both = Sha256::digest(models + &json(CURATED).to_json_string());
        assert_eq!(
            bundled_table().version(),
            format!("litellm:{}", hex::encode(&both[..6]))
        );
    }

    /// Each entry prices, names its source and fills a gap: one LiteLLM now carries fails here, to be removed.
    #[test]
    fn hand_maintained_entries_price_name_a_source_and_fill_gaps_litellm_leaves() {
        let (table, curated, snapshot) = (bundled_table(), json(CURATED), json(SNAPSHOT));
        let litellm = snapshot.get("models").unwrap();
        let used = tokens(1_000, 1_000, 0, 0);
        for (id, entry) in curated.get("models").unwrap().members() {
            assert!(*id == id.to_lowercase() && litellm.get(id).is_none(), "{id}");
            assert!(entry.get("source").is_some() && entry.get("checked").is_some(), "{id}");
            assert!(table.price(&used, id, ToolId::OpenCode).is_some(), "{id}");
        }
        for (id, alias) in curated.get("aliases").unwrap().members() {
            let Some(Json::String(to)) = alias.get("to") else {
                panic!("{id}")
            };
            assert!(*id == id.to_lowercase() && litellm.get(id).is_none(), "{id}");
            assert!(alias.get("source").is_some() && alias.get("checked").is_some(), "{id}");
            let target = table.price(&used, to, ToolId::OpenCode);
            assert!(
                target.is_some() && table.price(&used, id, ToolId::OpenCode) == target,
                "{id}"
            );
        }
    }

    #[test]
    fn prices_ids_litellm_lacks_at_the_hand_maintained_rates() {
        let table = bundled_table();
        // K3: $3 in, $15 out, $0.30 cache read and $3 cache write per million; Kimi Code records cache writes.
        let all = tokens(1_000, 1_000, 1_000, 1_000);
        assert_eq!(
            micro(&table, &all, "k3", ToolId::Kimi),
            Some(3_000 + 15_000 + 300 + 3_000)
        );
        assert_eq!(
            micro(&table, &all, "kimi-code/k3.1-pro", ToolId::Kimi),
            Some(2_000 + 10_000 + 200 + 2_000)
        );
        let read = tokens(1_000, 1_000, 1_000, 0);
        // kimi-for-coding at K2.7 Code's $0.95 in, $4 out, $0.19 cache read.
        assert_eq!(
            micro(&table, &read, "kimi-code/kimi-for-coding", ToolId::Kimi),
            Some(950 + 4_000 + 190)
        );
        // Z.ai's $0.11 cache read, which LiteLLM's zai/glm-4.5 lacks.
        assert_eq!(micro(&table, &read, "glm-4.5", ToolId::Pi), Some(600 + 2_200 + 110));
        assert_eq!(
            micro(&table, &read, "grok-build", ToolId::Grok),
            Some(1_000 + 2_000 + 200)
        );
        // Codex Spark at GPT-5.3 Codex's $1.75 in, $14 out, $0.175 cache read.
        assert_eq!(
            micro(&table, &read, "gpt-5.3-codex-spark", ToolId::Codex),
            Some(1_750 + 14_000 + 175)
        );
        // Mimo V2.5 Pro: $0.435 in, $0.87 out, $0.0036 cache read and free cache writes.
        let million = tokens(1_000_000, 1_000_000, 1_000_000, 1_000_000);
        assert_eq!(
            micro(&table, &million, "mimo-v2-pro", ToolId::Mimo),
            Some(435_000 + 870_000 + 3_600)
        );
        assert_eq!(
            micro(&table, &million, "deepseek-v4.1-flash", ToolId::CommandCode),
            Some(300_000 + 1_200_000 + 6_000)
        );
        // Gemini 3 Pro Preview: $2 in, $12 out; above 200k prompt tokens $4 in, $18 out.
        let gemini = |t: TokenCounts| micro(&table, &t, "gemini-3-pro-preview", ToolId::Gemini);
        assert_eq!(gemini(tokens(1_000, 1_000, 0, 0)), Some(14_000));
        assert_eq!(gemini(tokens(300_000, 1_000, 0, 0)), Some(1_200_000 + 18_000));
    }

    #[test]
    fn unsupported_curated_rates_stay_unknown_instead_of_being_invented() {
        let table = bundled_table();
        let plain = tokens(1_000, 1_000, 0, 0);
        assert_eq!(micro(&table, &plain, "grok-4", ToolId::Grok), Some(18_000));
        assert_eq!(micro(&table, &tokens(1_000, 1_000, 1, 0), "grok-4", ToolId::Grok), None);
        assert_eq!(micro(&table, &plain, "minimax-m2.7-highspeed", ToolId::Pi), Some(3_000));
        assert_eq!(
            micro(
                &table,
                &tokens(1_000, 1_000, 0, 1),
                "minimax-m2.7-highspeed",
                ToolId::Pi
            ),
            None
        );
        for id in ["hy3-preview", "hy4-preview", "hy3-preview-agent", "hy4-preview-agent"] {
            assert_eq!(micro(&table, &plain, id, ToolId::CodeBuddy), None, "{id}");
        }
    }

    #[test]
    fn independently_documented_cache_and_context_tiers_apply() {
        let table = bundled_table();
        let mut writes = tokens(0, 0, 0, 1_000);
        writes.cache_write_1h = Some(1_000);
        assert_eq!(
            micro(&table, &writes, "kimi-k3.1-pro-highspeed", ToolId::Kimi),
            Some(8_000)
        );
        assert_eq!(
            micro(&table, &tokens(128_000, 1_000, 0, 0), "grok-4-fast", ToolId::Grok),
            Some(26_100)
        );
        assert_eq!(
            micro(&table, &tokens(129_000, 1_000, 0, 0), "grok-4-fast", ToolId::Grok),
            Some(52_600)
        );
    }

    /// The version hashes `JSON.stringify` output, so key order and number formatting must survive a round trip.
    #[test]
    fn snapshot_reserialises_byte_for_byte_as_javascript_wrote_it() {
        let parsed = json(SNAPSHOT);
        assert_eq!(parsed.to_json_string() + "\n", SNAPSHOT);
        let models = parsed.get("models").unwrap();
        assert_eq!(trim_litellm(models).unwrap(), *models);
    }

    /// xAI lists no Grok Build models: their Grok API models' rates price them (grok-4.7: $2 in, $6 out per million).
    #[test]
    fn prices_grok_build_models_at_the_grok_api_rates() {
        let table = bundled_table();
        // Below the 200k-token context tier, which doubles both rates.
        let prompt = tokens(100_000, 100_000, 0, 0);
        assert_eq!(micro(&table, &prompt, "grok-4.7-build", ToolId::Grok), Some(800_000));
        assert_eq!(micro(&table, &prompt, "grok-4.7-build", ToolId::Codex), None);
    }

    // Exact values follow the pinned snapshot; update them together with the snapshot.
    #[test]
    fn prices_a_claude_code_event_exactly_input_output_cache_read_and_cache_write() {
        // claude-sonnet-4-5: $3 in, $15 out, $0.30 cache read, $3.75 cache write per million.
        let table = bundled_table();
        assert_eq!(
            table
                .price(
                    &tokens(1_000, 500, 20_000, 4_000),
                    "claude-sonnet-4-5-20250929",
                    ToolId::Claude
                )
                .map(plain),
            cost(&table, 3_000 + 7_500 + 6_000 + 15_000)
        );
    }

    #[test]
    fn prices_one_hour_cache_writes_at_their_own_rate() {
        // claude-sonnet-4-5: $3.75 per million for 5-minute writes, $6 for one-hour writes.
        let table = bundled_table();
        let event = TokenCounts {
            cache_write_1h: Some(1_000),
            ..tokens(1_000, 500, 20_000, 4_000)
        };
        assert_eq!(
            table
                .price(&event, "claude-sonnet-4-5-20250929", ToolId::Claude)
                .map(plain),
            cost(&table, 3_000 + 7_500 + 6_000 + 11_250 + 6_000)
        );
        // One-hour tokens beyond the writes are clamped to them.
        let all = TokenCounts {
            cache_write_1h: Some(9_000),
            ..tokens(0, 0, 0, 4_000)
        };
        assert_eq!(
            table.price(&all, "claude-sonnet-4-5", ToolId::Claude).map(plain),
            cost(&table, 24_000)
        );
    }

    #[test]
    fn splits_cost_by_kind_so_the_kinds_add_up_to_the_cost() {
        // claude-sonnet-4-5: 1,000 in = 3,000, 500 out = 7,500, 20,000 read = 6,000 µUSD, 3,000 five-minute writes
        // = 11,250 and 1,000 one-hour writes = 6,000. Reading 20,000 tokens from cache saved 20,000 × ($3 − $0.30).
        let event = TokenCounts {
            cache_write_1h: Some(1_000),
            ..tokens(1_000, 500, 20_000, 4_000)
        };
        let priced = bundled_table()
            .price(&event, "claude-sonnet-4-5", ToolId::Claude)
            .unwrap();
        assert_eq!(
            priced.parts,
            CostParts {
                input: 3_000,
                output: 7_500,
                cache_read: 6_000,
                cache_write: 17_250,
                cache_savings: 54_000,
            }
        );
        // 3 + 15 + 0.3 + 3.75 = 22.05 rounds to 22: each kind rounds down (21) and the largest remainder, cache write's
        // 0.75, takes the difference.
        let small = bundled_table()
            .price(&tokens(1, 1, 1, 1), "claude-sonnet-4-5", ToolId::Claude)
            .unwrap();
        assert_eq!(small.cost_microusd, 22);
        let p = small.parts;
        assert_eq!((p.input, p.output, p.cache_read, p.cache_write), (3, 15, 0, 4));
    }

    #[test]
    fn prices_a_codex_event_exactly_with_cached_input_at_the_cache_read_rate() {
        // gpt-5-codex: $1.25 in, $10 out, $0.125 cached per million. The parser already moved 8,000 cached tokens out of input.
        let table = bundled_table();
        let event = TokenCounts {
            reasoning: Some(100),
            ..tokens(2_000, 300, 8_000, 0)
        };
        assert_eq!(
            table.price(&event, "gpt-5-codex", ToolId::Codex).map(plain),
            cost(&table, 2_500 + 3_000 + 1_000)
        );
    }

    #[test]
    fn prices_a_codex_fast_turn_exactly_at_the_priority_rates() {
        // gpt-5 on the Fast tier: $2.50 in, $20 out, $0.25 cached per million, twice its Standard rates. Reading 8,000
        // tokens from cache saved 8,000 × ($2.50 − $0.25).
        let table = bundled_table();
        let event = tokens(2_000, 300, 8_000, 0);
        assert_eq!(
            table.price(&event, "gpt-5", ToolId::Codex).map(plain),
            cost(&table, 2_500 + 3_000 + 1_000)
        );
        let fast = table.price_tier(&event, "gpt-5", ToolId::Codex, true).unwrap();
        assert_eq!(fast.cost_microusd, 5_000 + 6_000 + 2_000);
        assert_eq!(
            fast.parts,
            CostParts {
                input: 5_000,
                output: 6_000,
                cache_read: 2_000,
                cache_write: 0,
                cache_savings: 18_000,
            }
        );
    }

    #[test]
    fn prices_a_fast_turn_at_standard_rates_when_the_model_publishes_no_priority_rates() {
        // gpt-5-codex has no `_priority` rates in the pinned snapshot.
        let table = bundled_table();
        let event = tokens(2_000, 300, 8_000, 0);
        assert_eq!(
            table.price_tier(&event, "gpt-5-codex", ToolId::Codex, true),
            table.price(&event, "gpt-5-codex", ToolId::Codex)
        );
    }

    #[test]
    fn resolves_the_id_variants_tools_log() {
        let table = bundled_table();
        for model in [
            "claude-sonnet-4-5",
            "anthropic/claude-sonnet-4-5",
            "claude-sonnet-4-5@20250929",
            "claude-opus-4-6[1m]",
            "CLAUDE-HAIKU-4-5-20251001",
            "claude-opus-4-5-20990101",
        ] {
            assert!(table.has(model, ToolId::Claude), "{model}");
        }
        for model in ["gpt-5", "gpt-5-codex", "gpt-5.1-codex-max", "openai/gpt-5.2-codex"] {
            assert!(table.has(model, ToolId::Codex), "{model}");
        }
    }

    /// LiteLLM keeps these providers' own prices under a prefix only: `zai/glm-4.6`, `moonshot/kimi-k3`,
    /// `minimax/minimax-m2` and `dashscope/qwen3.8-max`.
    #[test]
    fn prices_bare_ids_at_their_providers_own_rates() {
        let table = bundled_table();
        let used = tokens(1_000, 1_000, 0, 0);
        // $0.60 in, $2.20 out; $3 in, $15 out; $0.30 in, $1.20 out; $2 in, $6 out per million.
        assert_eq!(micro(&table, &used, "glm-4.6", ToolId::Pi), Some(2_800));
        assert_eq!(micro(&table, &used, "kimi-k3", ToolId::Kimi), Some(18_000));
        assert_eq!(micro(&table, &used, "MiniMax-M2", ToolId::MiniMax), Some(1_500));
        assert_eq!(micro(&table, &used, "qwen3.8-max", ToolId::OpenCode), Some(8_000));
    }

    /// Copilot and Zed write Claude versions with a dot (`claude-sonnet-4.5`); Anthropic's ids use a dash. A
    /// subscription's usage is priced at the API rates.
    #[test]
    fn prices_dotted_claude_versions_at_the_anthropic_api_rates() {
        let table = bundled_table();
        assert_eq!(
            micro(
                &table,
                &tokens(1_000, 500, 20_000, 4_000),
                "claude-sonnet-4.5",
                ToolId::Copilot
            ),
            Some(3_000 + 7_500 + 6_000 + 15_000)
        );
        let plain = tokens(1_000, 1_000, 0, 0);
        assert_eq!(micro(&table, &plain, "claude-haiku-4.5", ToolId::Copilot), Some(6_000));
        assert_eq!(
            micro(&table, &plain, "claude-opus-4.8-20260101", ToolId::Zed),
            Some(30_000)
        );
        assert_eq!(
            micro(&table, &plain, "us.anthropic.claude-3.5-haiku", ToolId::Claude),
            Some(4_800)
        );
    }

    /// LiteLLM dropped the Anthropic API entries of retired Claude models; their Bedrock entries keep the same
    /// rates (Anthropic lists Opus 4.1 at $15 in, $75 out per million).
    #[test]
    fn prices_retired_claude_models_at_their_bedrock_entries_rates() {
        let table = bundled_table();
        let used = tokens(1_000, 500, 20_000, 4_000);
        assert_eq!(
            micro(&table, &used, "claude-sonnet-4-20250514", ToolId::Claude),
            Some(3_000 + 7_500 + 6_000 + 15_000)
        );
        let plain = tokens(1_000, 1_000, 0, 0);
        assert_eq!(micro(&table, &plain, "claude-opus-4-1", ToolId::Cline), Some(90_000));
        assert_eq!(
            micro(&table, &plain, "claude-3-5-haiku-20241022", ToolId::Claude),
            Some(4_800)
        );
        // The undated id takes the newest snapshot, not LiteLLM's 2024 entry at $3.60 in, $18 out.
        assert_eq!(micro(&table, &plain, "claude-3-7-sonnet", ToolId::Claude), Some(18_000));
    }

    #[test]
    fn keeps_unknown_models_unknown_never_zero_but_zero_token_placeholders_cost_nothing() {
        let table = bundled_table();
        assert_eq!(
            table.price(&tokens(10, 10, 0, 0), "definitely-not-a-model", ToolId::Claude),
            None
        );
        assert_eq!(table.price(&tokens(10, 10, 0, 0), "unknown", ToolId::Codex), None);
        assert_eq!(
            table
                .price(&tokens(0, 0, 0, 0), "<synthetic>", ToolId::Claude)
                .map(plain),
            cost(&table, 0)
        );
    }

    #[test]
    fn prices_local_models_at_a_known_zero_and_keeps_unpriced_cloud_models_unknown() {
        let table = bundled_table();
        let zero = Some(PricedCost {
            cost_microusd: 0,
            pricing_version: table.version().to_owned(),
            parts: CostParts::default(),
        });
        let used = tokens(1_000, 500, 200, 100);
        // LM Studio runs every model locally, even one LiteLLM prices for its cloud API.
        for model in ["qwen2.5-7b-instruct", "claude-sonnet-4-5", "unknown"] {
            assert_eq!(table.price(&used, model, ToolId::LmStudio), zero, "{model}");
            assert_eq!(table.price_tier(&used, model, ToolId::LmStudio, true), zero, "{model}");
        }
        // Unsloth Studio's local routes, whatever the tool.
        assert_eq!(table.price(&used, "local/llama-3.2-1b", ToolId::Unsloth), zero);
        assert_eq!(table.price(&used, "local/claude-sonnet-4-5", ToolId::Claude), zero);
        // A paid route of the same tool is priced normally, and a cloud model without a price stays unknown.
        assert!(
            table
                .price(&used, "claude-sonnet-4-5", ToolId::Unsloth)
                .is_some_and(|cost| cost.cost_microusd > 0)
        );
        assert_eq!(table.price(&used, "swe-2", ToolId::Unsloth), None);
        assert_eq!(table.price(&used, "locally-hosted", ToolId::Claude), None);
    }

    /// Free tiers end their id in `-free` (OpenCode's `glm-5.3-flash-free`, Muse's `*-contributor-free`) and cost a
    /// known $0, as the hand-maintained `big-pickle` does.
    #[test]
    fn prices_free_tier_ids_at_a_known_zero() {
        let table = bundled_table();
        let zero = Some(PricedCost {
            cost_microusd: 0,
            pricing_version: table.version().to_owned(),
            parts: CostParts::default(),
        });
        let used = tokens(1_000, 500, 200, 100);
        for model in [
            "glm-5.3-flash-free",
            "opencode/deepseek-v4.1-flash-free",
            "MUSE-SPARK-1.3-CONTRIBUTOR-FREE",
            " kimi-k2.5-free\n",
            "big-pickle",
        ] {
            assert_eq!(table.price(&used, model, ToolId::OpenCode), zero, "{model:?}");
        }
        for model in ["free", "-free-model", "freebie", "glm-free-tier"] {
            assert_eq!(table.price(&used, model, ToolId::OpenCode), None, "{model:?}");
        }
    }

    /// Codex's hidden approval reviewer has no published price and costs a known $0, on either service tier.
    #[test]
    fn prices_codex_auto_review_at_a_known_zero() {
        let table = bundled_table();
        let zero = Some(PricedCost {
            cost_microusd: 0,
            pricing_version: table.version().to_owned(),
            parts: CostParts::default(),
        });
        let used = tokens(1_000, 500, 200, 100);
        for priority in [false, true] {
            assert_eq!(
                table.price_tier(&used, "codex-auto-review", ToolId::Codex, priority),
                zero,
                "{priority}"
            );
        }
    }
}

mod pricing_table {
    use super::*;

    #[test]
    fn keeps_only_priced_chat_entries_and_fields() {
        let extra = r#""extra":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":1e-6,"max_tokens":10,"litellm_provider":"x"}"#;
        let trimmed = trim_litellm(&synthetic(&[extra])).unwrap();
        for dropped in ["sample_spec", "image-model", "broken-model"] {
            assert!(trimmed.get(dropped).is_none(), "{dropped}");
        }
        assert_eq!(
            trimmed.get("extra").unwrap(),
            &json(r#"{"input_cost_per_token":1e-6,"output_cost_per_token":1e-6,"mode":"chat"}"#)
        );
        let only = json(r#"{"only":{"input_cost_per_token":1e-6,"output_cost_per_token":1e-6}}"#);
        assert_eq!(trim_litellm(&only).unwrap_err().to_string(), "invalid_pricing_table");
        assert!(matches!(trim_litellm(&json("[]")), Err(PricingError::InvalidTable)));
    }

    #[test]
    fn switches_to_the_long_context_tier_when_the_prompt_exceeds_its_threshold() {
        let table = PricingTable::new(&synthetic(&[])).unwrap();
        let tiered = |t: TokenCounts| micro(&table, &t, "tiered-model", ToolId::Claude);
        assert_eq!(tiered(tokens(200_000, 1_000, 0, 0)), Some(600_000 + 15_000));
        // 150,000 × $6 + 1,000 × $22.50 + 50,001 × $0.60 per million = 952,500.6 µUSD.
        assert_eq!(tiered(tokens(150_000, 1_000, 50_001, 0)), Some(952_501));
        // Cache write has no tier rate, so its base rate applies inside the tier: 1,200,006 + 37.5 µUSD.
        assert_eq!(tiered(tokens(200_001, 0, 0, 10)), Some(1_200_044));
    }

    #[test]
    fn prices_the_fast_tier_per_component_at_its_own_rates_long_context_included() {
        let fast = r#""fast-model":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":2e-6,"cache_read_input_token_cost":1e-7,"input_cost_per_token_above_200k_tokens":2e-6,"output_cost_per_token_above_200k_tokens":3e-6,"input_cost_per_token_priority":4e-6,"output_cost_per_token_priority":8e-6,"input_cost_per_token_above_200k_tokens_priority":1e-5,"input_cost_per_audio_token_priority":1e-6}"#;
        let models = synthetic(&[fast]);
        assert_eq!(
            trim_litellm(&models).unwrap().get("fast-model").unwrap(),
            &json(
                r#"{"input_cost_per_token":1e-6,"output_cost_per_token":2e-6,"cache_read_input_token_cost":1e-7,"input_cost_per_token_above_200k_tokens":2e-6,"output_cost_per_token_above_200k_tokens":3e-6,"input_cost_per_token_priority":4e-6,"output_cost_per_token_priority":8e-6,"input_cost_per_token_above_200k_tokens_priority":1e-5,"mode":"chat"}"#
            )
        );
        let table = PricingTable::new(&models).unwrap();
        let price = |t: TokenCounts, priority| {
            table
                .price_tier(&t, "fast-model", ToolId::Codex, priority)
                .map(|priced| priced.cost_microusd)
        };
        assert_eq!(price(tokens(1_000, 1_000, 1_000, 0), false), Some(1_000 + 2_000 + 100));
        // Cache reads have no priority rate, so they keep the Standard one.
        assert_eq!(price(tokens(1_000, 1_000, 1_000, 0), true), Some(4_000 + 8_000 + 100));
        // Above 200k, input takes its long-context priority rate. Output has none, so its flat priority rate applies.
        assert_eq!(price(tokens(200_001, 1_000, 0, 0), false), Some(400_002 + 3_000));
        assert_eq!(price(tokens(200_001, 1_000, 0, 0), true), Some(2_000_010 + 8_000));
    }

    #[test]
    fn returns_none_when_a_used_component_has_no_rate() {
        let table = PricingTable::new(&synthetic(&[])).unwrap();
        assert_eq!(
            table
                .price(&tokens(10, 10, 0, 0), "no-cache-model", ToolId::Codex)
                .map(plain),
            cost(&table, 30)
        );
        assert_eq!(
            table.price(&tokens(10, 10, 1, 0), "no-cache-model", ToolId::Codex),
            None
        );
    }

    #[test]
    fn rounds_to_whole_micro_usd_half_up_and_handles_counts_past_2_pow_53_picodollars() {
        let table = PricingTable::new(&synthetic(&[])).unwrap();
        assert_eq!(
            micro(&table, &tokens(0, 0, 1, 0), "tiered-model", ToolId::Claude),
            Some(0)
        ); // 0.3 µUSD
        assert_eq!(
            micro(&table, &tokens(0, 0, 5, 0), "tiered-model", ToolId::Claude),
            Some(2)
        ); // 1.5 µUSD
        assert_eq!(
            micro(&table, &tokens(4_000_000_000_000, 0, 0, 0), "pad-1", ToolId::Claude),
            Some(4_000_000_000_000)
        );
    }

    #[test]
    fn prefers_the_google_ai_studio_entry_for_gemini_cli() {
        let table = PricingTable::new(&synthetic(&[])).unwrap();
        assert_eq!(
            micro(&table, &tokens(1_000, 1_000, 0, 0), "gemini-test", ToolId::Gemini),
            Some(5_000)
        );
        assert_eq!(
            micro(&table, &tokens(1_000, 1_000, 0, 0), "gemini-test", ToolId::Claude),
            Some(18_000)
        );
    }

    #[test]
    fn falls_back_to_the_providers_own_entry_after_every_unprefixed_form() {
        let table = PricingTable::new(&synthetic(&[
            r#""zai/glm-test":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":2e-6}"#,
            r#""zai/glm-bare":{"mode":"chat","input_cost_per_token":9e-6,"output_cost_per_token":9e-6}"#,
            r#""glm-bare":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":1e-6}"#,
            r#""aihubmix/glm-resold":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":1e-6}"#,
            r#""zai/other-test":{"mode":"chat","input_cost_per_token":9e-6,"output_cost_per_token":9e-6}"#,
        ]))
        .unwrap();
        let used = tokens(1_000, 1_000, 0, 0);
        for model in ["glm-test", "GLM-Test", "openrouter/z-ai/glm-test", "glm-test-20260101"] {
            assert_eq!(micro(&table, &used, model, ToolId::Pi), Some(3_000), "{model}");
        }
        assert_eq!(micro(&table, &used, "glm-bare", ToolId::Pi), Some(2_000));
        // A reseller's entry is not the provider's, and only a model's own family takes a provider.
        assert_eq!(micro(&table, &used, "glm-resold", ToolId::Pi), None);
        assert_eq!(micro(&table, &used, "other-test", ToolId::Pi), None);
    }

    #[test]
    fn answers_dated_and_undated_ids_from_dated_bedrock_claude_entries() {
        let table = PricingTable::new(&synthetic(&[
            r#""anthropic.claude-test-20240101-v1:0":{"mode":"chat","input_cost_per_token":9e-6,"output_cost_per_token":9e-6}"#,
            r#""anthropic.claude-test-20250101-v2:0":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":2e-6}"#,
            r#""anthropic.claude-kept-20250101-v1:0":{"mode":"chat","input_cost_per_token":9e-6,"output_cost_per_token":9e-6}"#,
            r#""claude-kept":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":1e-6}"#,
            r#""anthropic.claude-v2:1":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":1e-6}"#,
        ]))
        .unwrap();
        let used = tokens(1_000, 1_000, 0, 0);
        assert_eq!(
            micro(&table, &used, "claude-test-20240101", ToolId::Claude),
            Some(18_000)
        );
        assert_eq!(micro(&table, &used, "claude-test", ToolId::Claude), Some(3_000));
        assert_eq!(micro(&table, &used, "claude-kept", ToolId::Claude), Some(2_000));
        assert_eq!(micro(&table, &used, "claude", ToolId::Claude), None);
    }

    #[test]
    fn derives_the_version_from_content_so_identical_tables_share_it() {
        let table = PricingTable::new(&synthetic(&[])).unwrap();
        assert_eq!(PricingTable::new(&synthetic(&[])).unwrap().version(), table.version());
        let changed =
            synthetic(&[r#""pad-1":{"mode":"chat","input_cost_per_token":2e-6,"output_cost_per_token":2e-6}"#]);
        assert_ne!(PricingTable::new(&changed).unwrap().version(), table.version());
    }

    // The expected values of the cases below were computed with the earlier TypeScript pricing package.

    #[test]
    fn matches_the_alias_rules_of_the_typescript_candidates() {
        let table = PricingTable::new(&synthetic(&[])).unwrap();
        let expected = [
            (" PAD-1 ", true),
            ("us.pad-1-v1:0", true),
            ("anthropic.pad-1", true),
            ("x/y/pad-1", true),
            ("pad-1@20250929", true),
            ("pad-1-20250929", true),
            ("pad-1-2025-09-29", true),
            ("pad-1[1m]", true),
            ("pad-1-v1", true),
            ("pad-1-v1:0@20250929", false),
            ("eu.anthropic.pad-1-v2", true),
            ("pad-1[1m", false),
            ("pad-1-v", false),
            ("pad-1-2025-9-29", false),
            ("pad-1@2025092", false),
            ("pad-1-v1:", false),
            ("pad-1[a]b]", false),
            ("pad-1[a[b]", true),
            ("pad-1 [1m]", false),
            ("\u{85}pad-1", false),
            ("\u{feff}pad-1", true),
            ("pad-1\n", true),
            ("pad-1-v1-v2", false),
            ("pad-1-v1:0-v2:0", false),
            ("au.us.pad-1", false),
            ("global.pad-1", true),
            ("pad-1/", false),
        ];
        for (model, found) in expected {
            assert_eq!(table.has(model, ToolId::Claude), found, "{model:?}");
        }
    }

    #[test]
    fn keeps_the_first_position_and_the_later_sorted_value_when_keys_collide_after_lowercasing() {
        let colliding = [
            r#""Zed-1":{"mode":"chat","input_cost_per_token":5e-6,"output_cost_per_token":6e-6}"#,
            r#""zed-1":{"mode":"chat","input_cost_per_token":7e-6,"output_cost_per_token":8e-6}"#,
        ];
        let base = trim_litellm(&synthetic(&[])).unwrap().members().len();
        let trimmed = trim_litellm(&synthetic(&colliding)).unwrap();
        assert_eq!(trimmed.members().len(), base + 1);
        assert_eq!(
            trimmed.get("zed-1").unwrap().to_json_string(),
            r#"{"input_cost_per_token":0.000005,"output_cost_per_token":0.000006,"mode":"chat"}"#
        );
    }

    #[test]
    fn does_not_count_a_proto_key_as_a_model() {
        let proto = r#""__PROTO__":{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":2e-6}"#;
        let base = trim_litellm(&synthetic(&[])).unwrap().members().len();
        let trimmed = trim_litellm(&synthetic(&[proto])).unwrap();
        assert_eq!(trimmed.members().len(), base);
        assert!(trimmed.get("__proto__").is_none());
        let entry = r#"{"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":2e-6}"#;
        let members: Vec<String> = (0..99).map(|i| format!(r#""pad-{i}":{entry}"#)).collect();
        let short = json(&format!("{{{},{proto}}}", members.join(",")));
        assert!(matches!(trim_litellm(&short), Err(PricingError::InvalidTable)));
    }

    #[test]
    fn serialises_like_json_stringify() {
        let numbers = json(
            "[1e-7,0.000001,1e21,123456789012345680000,-0,0.1,0.0000125,100,1.5e300,5e-324,9007199254740993,0.30000000000000004,0.000003,2.5e-7]",
        );
        assert_eq!(
            numbers.to_json_string(),
            "[1e-7,0.000001,1e+21,123456789012345680000,0,0.1,0.0000125,100,1.5e+300,5e-324,9007199254740992,0.30000000000000004,0.000003,2.5e-7]"
        );
        let text = json(r#""a\"b\\c\n\t\u0001\u001f\u007f é😀/ \b\f\r""#);
        assert_eq!(
            text.to_json_string(),
            "\"a\\\"b\\\\c\\n\\t\\u0001\\u001f\u{7f} é😀/ \\b\\f\\r\""
        );
        // Array-index keys come first in ascending order; a repeated key keeps its first position.
        assert_eq!(
            json(r#"{"b":1,"2":2,"a":3,"1":4,"01":5,"a":6}"#).to_json_string(),
            r#"{"1":4,"2":2,"b":1,"a":6,"01":5}"#
        );
    }
}

mod daily_refresh {
    use super::*;

    fn cache_path(directory: &tempfile::TempDir) -> PathBuf {
        directory.path().join("pricing").join("litellm.json")
    }

    #[test]
    fn downloads_after_24_hours_caches_to_disk_and_keeps_the_version_when_nothing_changed() {
        let directory = tempfile::tempdir().unwrap();
        let cache_path = cache_path(&directory);
        let clock = TestClock::at(1);
        let fake = Fake::table();
        let mut refresher = PricingRefresher::new(options(&cache_path, true, fake.clone(), &clock));
        assert!(Arc::ptr_eq(&refresher.current(), &bundled_table()));
        assert!(!block_on(refresher.refresh()).unwrap());
        assert_eq!(fake.calls(), 0);
        clock.set(25);
        assert!(block_on(refresher.refresh()).unwrap());
        assert_eq!(
            refresher.current().version(),
            PricingTable::new(&synthetic(&[])).unwrap().version()
        );
        #[cfg(unix)]
        {
            assert_eq!(mode(&cache_path), 0o600);
            assert_eq!(mode(cache_path.parent().unwrap()), 0o700);
        }
        assert!(!cache_path.with_extension("json.tmp").exists());
        clock.set(48);
        assert!(!block_on(refresher.refresh()).unwrap());
        assert_eq!(fake.calls(), 1);
        clock.set(50);
        assert!(!block_on(refresher.refresh()).unwrap());
        assert_eq!(fake.calls(), 2);
        // A new process starts from the cache instead of the bundled snapshot.
        let restarted = PricingRefresher::new(options(&cache_path, true, fake.clone(), &clock));
        assert_eq!(restarted.current().version(), refresher.current().version());
    }

    #[test]
    fn requests_the_litellm_url_unless_told_otherwise() {
        let directory = tempfile::tempdir().unwrap();
        let clock = TestClock::at(25);
        let fake = Fake::table();
        block_on(PricingRefresher::new(options(&cache_path(&directory), true, fake.clone(), &clock)).refresh())
            .unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut custom = options(&cache_path(&other), true, fake.clone(), &clock);
        custom.url = Some("http://localhost/prices.json".to_owned());
        block_on(PricingRefresher::new(custom).refresh()).unwrap();
        assert_eq!(
            *fake.urls.lock().unwrap(),
            [LITELLM_URL, "http://localhost/prices.json"]
        );
    }

    #[test]
    fn makes_no_request_and_ignores_the_cache_when_turned_off() {
        let directory = tempfile::tempdir().unwrap();
        let cache_path = cache_path(&directory);
        let fake = Fake::table();
        let mut on = PricingRefresher::new(options(&cache_path, true, fake.clone(), &TestClock::at(25)));
        block_on(on.refresh()).unwrap();
        let mut off = PricingRefresher::new(options(&cache_path, false, fake.clone(), &TestClock::at(100)));
        assert!(Arc::ptr_eq(&off.current(), &bundled_table()));
        assert!(!block_on(off.refresh()).unwrap());
        assert_eq!(fake.calls(), 1);
        let disabled = ["off", "OFF", "0", "false", "no", " off "].map(|value| pricing_refresh_enabled(Some(value)));
        assert_eq!(disabled, [false; 6]);
        let enabled = [None, Some(""), Some("on"), Some("1")].map(pricing_refresh_enabled);
        assert_eq!(enabled, [true; 4]);
    }

    #[test]
    fn switching_off_goes_back_to_the_bundled_snapshot_and_on_to_the_cached_download() {
        let directory = tempfile::tempdir().unwrap();
        let cache_path = cache_path(&directory);
        let clock = TestClock::at(25);
        let fake = Fake::table();
        let mut refresher = PricingRefresher::new(options(&cache_path, true, fake.clone(), &clock));
        assert_eq!(refresher.fetched_at(), snapshot_fetched_at_ms());
        assert!(block_on(refresher.refresh()).unwrap());
        let downloaded = refresher.current().version().to_owned();
        assert_eq!(refresher.fetched_at(), snapshot_fetched_at_ms() + 25 * 3_600_000);
        // Off: the bundled snapshot, no download however old it is.
        assert!(refresher.set_enabled(false));
        assert!(Arc::ptr_eq(&refresher.current(), &bundled_table()));
        assert_eq!(refresher.fetched_at(), snapshot_fetched_at_ms());
        clock.set(100);
        assert!(!block_on(refresher.refresh()).unwrap());
        assert_eq!(fake.calls(), 1);
        assert!(!refresher.set_enabled(false));
        // On again: the cached download, then the next refresh downloads, as it is over a day old.
        assert!(refresher.set_enabled(true));
        assert_eq!(refresher.current().version(), downloaded);
        assert_eq!(refresher.fetched_at(), snapshot_fetched_at_ms() + 25 * 3_600_000);
        assert!(!block_on(refresher.refresh()).unwrap());
        assert_eq!(fake.calls(), 2);
    }

    #[test]
    fn keeps_the_current_table_when_a_download_fails_is_oversized_or_is_not_a_price_table() {
        let tiny = r#"{"tiny":{"input_cost_per_token":1e-6,"output_cost_per_token":1e-6}}"#;
        let directory = tempfile::tempdir().unwrap();
        let cache_path = cache_path(&directory);
        let replies = [
            Err("HTTP 503".to_owned()),
            // The transport enforces the Content-Length cap before reading the body.
            Err("content-length 67108864 is over the 20 MiB limit".to_owned()),
            Ok("x".repeat(MAX_DOWNLOAD_BYTES + 1)),
            Ok(tiny.to_owned()),
            Ok("{not json".to_owned()),
        ];
        for reply in replies {
            let mut refresher =
                PricingRefresher::new(options(&cache_path, true, Fake::new(reply.clone()), &TestClock::at(25)));
            let error = block_on(refresher.refresh()).unwrap_err();
            match (&reply, &error) {
                (Err(_), PricingError::Transport(_)) => {}
                (Ok(body), PricingError::TooLarge) if body.len() > MAX_DOWNLOAD_BYTES => {}
                (Ok(body), PricingError::InvalidTable) if body == tiny => {}
                (Ok(body), PricingError::Json(_)) if body == "{not json" => {}
                _ => panic!(
                    "unexpected error {error} for {:?}",
                    reply.as_ref().map(|body| body.len())
                ),
            }
            assert!(Arc::ptr_eq(&refresher.current(), &bundled_table()));
        }
        assert!(!cache_path.exists());
    }

    #[test]
    fn ignores_a_corrupt_cache_or_one_older_than_the_bundled_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let cache_path = cache_path(&directory);
        let fake = Fake::table();
        block_on(PricingRefresher::new(options(&cache_path, true, fake.clone(), &TestClock::at(25))).refresh())
            .unwrap();
        let mut cached: serde_json::Value = serde_json::from_str(&fs::read_to_string(&cache_path).unwrap()).unwrap();
        cached["fetchedAt"] = later(-1).format(&Rfc3339).unwrap().into();
        fs::write(&cache_path, cached.to_string()).unwrap();
        let stale = PricingRefresher::new(options(&cache_path, true, fake.clone(), &TestClock::at(26)));
        assert!(Arc::ptr_eq(&stale.current(), &bundled_table()));
        fs::write(&cache_path, "{corrupt").unwrap();
        let corrupt = PricingRefresher::new(options(&cache_path, true, fake, &TestClock::at(26)));
        assert!(Arc::ptr_eq(&corrupt.current(), &bundled_table()));
    }
}
