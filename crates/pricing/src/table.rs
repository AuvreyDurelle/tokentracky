//! The price table: LiteLLM trimming, model id aliases and exact integer micro-USD costs.
use crate::{Json, PricingError, json::ObjectBuilder};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::HashMap,
    sync::{LazyLock, Mutex, PoisonError},
};
use tokentracky_core::{CostParts, MAX_SAFE_INTEGER, TokenCounts, ToolId, is_js_space};

/// LiteLLM field names this crate reads, in component order: input, output, cache read, cache write and one-hour
/// cache write. Everything else in an entry is ignored.
const RATE_FIELDS: [&str; 5] = [
    "input_cost_per_token",
    "output_cost_per_token",
    "cache_read_input_token_cost",
    "cache_creation_input_token_cost",
    "cache_creation_input_token_cost_above_1hr",
];
const CACHE_WRITE: usize = 3;
const CACHE_WRITE_1H: usize = 4;
const PRICED_MODES: [&str; 2] = ["chat", "responses"];
/// A rate above $1 per token is not a real price; reject the entry rather than inflate costs.
const MAX_RATE_USD: f64 = 1.0;
const MIN_MODELS: usize = 100;
/// Hand-maintained prices for models LiteLLM has no entry for, and ids LiteLLM files under another name. Applied to
/// every table, the downloaded ones included.
static CURATED: LazyLock<Json> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/curated-prices.json")).expect("the hand-maintained price list is JSON")
});
/// Model families whose provider's own LiteLLM entries carry a prefix only (`zai/glm-4.6`), and that prefix.
const PROVIDERS: [(&str, &str); 8] = [
    ("glm-", "zai/"),
    ("kimi-", "moonshot/"),
    ("minimax-", "minimax/"),
    ("qwen", "dashscope/"),
    ("grok-", "xai/"),
    ("deepseek-", "deepseek/"),
    ("mimo-", "xiaomi_mimo/"),
    ("gemini-", "gemini/"),
];

/// Integer picodollars per token for each component: exact for every published rate.
type Rates = [Option<u64>; 5];
struct Tier {
    above_tokens: u64,
    rates: Rates,
}
/// One service tier's rates: the base rates and the long-context tiers above them.
#[derive(Default)]
struct Schedule {
    base: Rates,
    /// Highest threshold first.
    tiers: Vec<Tier>,
}
impl Schedule {
    fn set(&mut self, component: usize, above_tokens: Option<u64>, rate: u64) {
        let rates = match above_tokens {
            None => &mut self.base,
            Some(above_tokens) => {
                let at = self
                    .tiers
                    .iter()
                    .position(|tier| tier.above_tokens == above_tokens)
                    .unwrap_or_else(|| {
                        self.tiers.push(Tier {
                            above_tokens,
                            rates: [None; 5],
                        });
                        self.tiers.len() - 1
                    });
                &mut self.tiers[at].rates
            }
        };
        rates[component] = Some(rate);
    }
    /// Each component's rate for a prompt of `context` tokens: the rate of the highest tier the prompt exceeds, else
    /// the base rate.
    fn at(&self, context: u128) -> Rates {
        let tier = self.tiers.iter().find(|tier| context > u128::from(tier.above_tokens));
        std::array::from_fn(|component| tier.and_then(|tier| tier.rates[component]).or(self.base[component]))
    }
}
struct ModelPrice {
    standard: Schedule,
    /// Codex's Fast service tier (`*_priority`): empty for most models.
    priority: Schedule,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricedCost {
    pub cost_microusd: u64,
    pub pricing_version: String,
    /// The cost by token kind; the kinds add up to `cost_microusd`.
    pub parts: CostParts,
}

/// Rounds picodollars per kind (input, output, cache read, cache write) to micro-USD that add up to the rounded
/// total: each kind is rounded down, then the largest remainders, earlier kinds first on a tie, take the difference.
fn split(picodollars: [u128; 4], total: u64) -> CostParts {
    let mut micro = picodollars.map(|pico| (pico / 1_000_000) as u64);
    let short = total.saturating_sub(micro.iter().sum());
    let mut order = [0, 1, 2, 3];
    order.sort_by_key(|&kind| std::cmp::Reverse(picodollars[kind] % 1_000_000));
    for &kind in order.iter().take(short as usize) {
        micro[kind] += 1;
    }
    let [input, output, cache_read, cache_write] = micro;
    CostParts {
        input,
        output,
        cache_read,
        cache_write,
        cache_savings: 0,
    }
}

fn rate(value: &Json) -> Option<u64> {
    let Json::Number(value) = *value else { return None };
    (0.0..=MAX_RATE_USD)
        .contains(&value)
        .then(|| (value * 1e12).round() as u64)
}

/// `<rate field>_above_<n>k_tokens` with one to four digits: the component and the threshold in tokens. The longest
/// matching rate field is the component, so a one-hour write tier is not read as a cache write tier.
fn tier_field(field: &str) -> Option<(usize, u64)> {
    let component = (0..RATE_FIELDS.len())
        .filter(|&component| field.starts_with(RATE_FIELDS[component]))
        .max_by_key(|&component| RATE_FIELDS[component].len())?;
    let digits = field[RATE_FIELDS[component].len()..]
        .strip_prefix("_above_")?
        .strip_suffix("k_tokens")?;
    if !(1..=4).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((component, digits.parse::<u64>().ok()? * 1000))
}

/// `<rate field>_priority` or `<rate field>_above_<n>k_tokens_priority`, for every component but the one-hour cache
/// write: the component and the threshold, if any.
fn priority_field(field: &str) -> Option<(usize, Option<u64>)> {
    let field = field.strip_suffix("_priority")?;
    match RATE_FIELDS[..CACHE_WRITE_1H].iter().position(|&name| name == field) {
        Some(component) => Some((component, None)),
        None => tier_field(field)
            .filter(|&(component, _)| component != CACHE_WRITE_1H)
            .map(|(component, above_tokens)| (component, Some(above_tokens))),
    }
}

fn entry(value: &Json) -> Option<ModelPrice> {
    if value
        .get("mode")
        .is_some_and(|mode| !matches!(mode, Json::String(m) if PRICED_MODES.contains(&m.as_str())))
    {
        return None;
    }
    let mut standard = Schedule::default();
    for (slot, name) in standard.base.iter_mut().zip(RATE_FIELDS) {
        if let Some(field) = value.get(name) {
            *slot = Some(rate(field)?);
        }
    }
    if standard.base[0].is_none() || standard.base[1].is_none() {
        return None;
    }
    let mut priority = Schedule::default();
    for (field, raw) in value.members() {
        let (schedule, component, above_tokens) = match (tier_field(field), priority_field(field)) {
            (Some((component, above_tokens)), _) => (&mut standard, component, Some(above_tokens)),
            (None, Some((component, above_tokens))) => (&mut priority, component, above_tokens),
            (None, None) => continue,
        };
        schedule.set(component, above_tokens, rate(raw)?);
    }
    for schedule in [&mut standard, &mut priority] {
        schedule.tiers.sort_by_key(|tier| std::cmp::Reverse(tier.above_tokens));
    }
    Some(ModelPrice { standard, priority })
}

/// Trims a LiteLLM `model_prices_and_context_window.json` map to the chat entries and fields used here.
pub fn trim_litellm(raw: &Json) -> Result<Json, PricingError> {
    let Json::Object(entries) = raw else {
        return Err(PricingError::InvalidTable);
    };
    let mut entries: Vec<&(String, Json)> = entries.iter().collect();
    entries.sort_by(|a, b| locale_compare(&a.0, &b.0));
    let mut models = ObjectBuilder::default();
    for (key, value) in entries {
        if key == "sample_spec" || key.encode_utf16().count() > 256 || entry(value).is_none() {
            continue;
        }
        let mut kept: Vec<(String, Json)> = value
            .members()
            .iter()
            .filter(|(field, _)| {
                RATE_FIELDS.contains(&field.as_str()) || tier_field(field).is_some() || priority_field(field).is_some()
            })
            .cloned()
            .collect();
        if let Some(mode @ Json::String(_)) = value.get("mode") {
            kept.push(("mode".to_owned(), mode.clone()));
        }
        // Assigning to `__proto__` sets the prototype in JavaScript: no own key, so it is not a model.
        let key = key.to_lowercase();
        if key != "__proto__" {
            models.set(key, Json::Object(kept));
        }
    }
    if models.len() < MIN_MODELS {
        return Err(PricingError::InvalidTable);
    }
    Ok(models.build())
}

/// `String.prototype.localeCompare` for the ASCII ids LiteLLM uses (ICU root collation). Compared by primary
/// weight first: whitespace and punctuation, then digits, then letters ignoring case. Ties go to lowercase.
/// Control characters are ignored. Other characters sort after ASCII, by code point.
fn locale_compare(a: &str, b: &str) -> Ordering {
    fn primary(s: &str) -> impl Iterator<Item = u32> {
        s.chars().filter_map(weight)
    }
    fn upper(s: &str) -> impl Iterator<Item = bool> {
        s.chars()
            .filter(|&c| weight(c).is_some())
            .map(|c| c.is_ascii_uppercase())
    }
    primary(a).cmp(primary(b)).then_with(|| upper(a).cmp(upper(b)))
}

fn weight(c: char) -> Option<u32> {
    /// ASCII whitespace and punctuation in ICU root collation order.
    const PUNCTUATION: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    const DIGITS: u32 = PUNCTUATION.len() as u32;
    match c {
        '0'..='9' => Some(DIGITS + u32::from(c) - u32::from('0')),
        'a'..='z' | 'A'..='Z' => Some(DIGITS + 10 + u32::from(c.to_ascii_lowercase()) - u32::from('a')),
        _ => match PUNCTUATION.find(c) {
            Some(at) => Some(at as u32),
            None if c.is_control() => None,
            None => Some(1000 + u32::from(c)),
        },
    }
}

/// Free tiers end their id in `-free` (OpenCode's `glm-5.3-flash-free`, Muse's `muse-spark-1.3-contributor-free`).
fn is_free(model: &str) -> bool {
    let id = model.trim_matches(is_js_space);
    id.len()
        .checked_sub("-free".len())
        .is_some_and(|at| id.as_bytes()[at..].eq_ignore_ascii_case(b"-free"))
}

/// Removes a trailing `shape`, where `#` stands for one ASCII digit.
fn strip_shape<'a>(s: &'a str, shape: &str) -> Option<&'a str> {
    let at = s.len().checked_sub(shape.len())?;
    let matches = s
        .bytes()
        .skip(at)
        .zip(shape.bytes())
        .all(|(b, p)| if p == b'#' { b.is_ascii_digit() } else { b == p });
    matches.then(|| &s[..at])
}

/// Removes a trailing Bedrock version such as `-v1` or `-v1:0`.
fn strip_bedrock_version(s: &str) -> &str {
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    let version = |t: &str| {
        t.split_once(':')
            .map_or_else(|| digits(t), |(major, minor)| digits(major) && digits(minor))
    };
    s.match_indices("-v")
        .find(|(at, _)| version(&s[at + 2..]))
        .map_or(s, |(at, _)| &s[..at])
}

/// Normalized candidates, most specific first. Logged ids may carry dates, regions, provider prefixes or
/// Claude Code's context suffix.
fn candidates(model: &str, tool: ToolId) -> Vec<String> {
    let lowered = model.trim_matches(is_js_space).to_lowercase();
    // A trailing `[...]` group, such as Claude Code's `[1m]`.
    let id = match lowered.strip_suffix(']') {
        Some(body) => {
            let from = body.rfind(']').map_or(0, |at| at + 1);
            body[from..]
                .find('[')
                .map_or(lowered.as_str(), |at| &lowered[..from + at])
        }
        None => lowered.as_str(),
    };
    let bare = id.rsplit('/').next().unwrap_or(id);
    let mut unwrapped = bare;
    if let Some(rest) = ["us.", "eu.", "apac.", "global.", "jp.", "au."]
        .iter()
        .find_map(|prefix| unwrapped.strip_prefix(prefix))
    {
        unwrapped = rest;
    }
    unwrapped = unwrapped.strip_prefix("anthropic.").unwrap_or(unwrapped);
    unwrapped = strip_bedrock_version(unwrapped);
    unwrapped = strip_shape(unwrapped, "@########").unwrap_or(unwrapped);
    let undated = strip_shape(unwrapped, "-####-##-##")
        .or_else(|| strip_shape(unwrapped, "-########"))
        .unwrap_or(unwrapped);
    let mut list = Vec::with_capacity(6);
    // Gemini CLI calls Google AI Studio, whose LiteLLM entries carry a `gemini/` prefix.
    if tool == ToolId::Gemini {
        list.extend([format!("gemini/{bare}"), format!("gemini/{undated}")]);
    }
    // Grok Build's models are xAI's Grok models at their API rates until xAI lists them.
    if tool == ToolId::Grok
        && let Some(grok) = bare.strip_suffix("-build")
    {
        list.extend([format!("xai/{grok}"), grok.to_owned()]);
    }
    list.extend([id, bare, unwrapped, undated].map(str::to_owned));
    // Copilot and Zed write Claude versions with a dot (`claude-sonnet-4.5`); Anthropic's ids use a dash.
    if unwrapped.starts_with("claude-") && unwrapped.contains('.') {
        list.extend([unwrapped, undated].map(|form| form.replace('.', "-")));
    }
    // Tools log the bare id; LiteLLM may hold the provider's own price under its prefix only.
    if let Some((_, provider)) = PROVIDERS.iter().find(|(family, _)| bare.starts_with(family)) {
        list.extend([bare, unwrapped, undated].map(|form| format!("{provider}{form}")));
    }
    list
}

/// The dated and undated Anthropic ids of a dated Bedrock Claude entry (`anthropic.claude-sonnet-4-20250514-v1:0`):
/// LiteLLM dropped retired models' Anthropic API entries but keeps their Bedrock ones, at the same rates.
fn bedrock_claude_aliases(key: &str) -> Option<[&str; 2]> {
    let dated = strip_bedrock_version(key.strip_prefix("anthropic.")?);
    let undated = strip_shape(dated, "-########")?;
    dated.starts_with("claude-").then_some([dated, undated])
}

pub struct PricingTable {
    index: HashMap<String, usize>,
    prices: Vec<ModelPrice>,
    /// Lookup results by tool and logged model id: the same ids repeat across a whole history.
    resolved: Mutex<HashMap<ToolId, HashMap<String, Option<usize>>>>,
    version: String,
}

impl PricingTable {
    /// Trims `models` (see [`trim_litellm`]) and prices from what is kept.
    pub fn new(models: &Json) -> Result<Self, PricingError> {
        let trimmed = trim_litellm(models)?;
        let mut index = HashMap::new();
        let mut prices = Vec::new();
        for (key, value) in trimmed.members() {
            if let Some(price) = entry(value) {
                index.insert(key.clone(), prices.len());
                prices.push(price);
            }
        }
        // Newest snapshot first, so an undated id takes it; an existing entry is never replaced.
        let aliases: Vec<(&str, usize)> = trimmed
            .members()
            .iter()
            .rev()
            .filter_map(|(key, _)| Some((bedrock_claude_aliases(key)?, index[key])))
            .flat_map(|(names, at)| names.map(|name| (name, at)))
            .collect();
        for (name, at) in aliases {
            index.entry(name.to_owned()).or_insert(at);
        }
        // The hand-maintained list fills gaps only: a LiteLLM entry with the same id wins. Its aliases may name its
        // own entries.
        for (key, value) in CURATED.get("models").map_or(&[][..], Json::members) {
            if !index.contains_key(key)
                && let Some(price) = entry(value)
            {
                index.insert(key.clone(), prices.len());
                prices.push(price);
            }
        }
        for (key, alias) in CURATED.get("aliases").map_or(&[][..], Json::members) {
            if let Some(Json::String(to)) = alias.get("to")
                && let Some(&at) = index.get(to)
            {
                index.entry(key.clone()).or_insert(at);
            }
        }
        let digest = Sha256::new()
            .chain_update(trimmed.to_json_string())
            .chain_update(CURATED.to_json_string())
            .finalize();
        Ok(Self {
            index,
            prices,
            resolved: Mutex::default(),
            version: format!("litellm:{}", hex::encode(&digest[..6])),
        })
    }

    /// `litellm:` plus a hash of the table and the hand-maintained list, so re-downloading an unchanged table keeps
    /// the version.
    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn size(&self) -> usize {
        self.prices.len()
    }

    pub fn has(&self, model: &str, tool: ToolId) -> bool {
        self.lookup(model, tool).is_some()
    }

    /// Integer micro-USD, rounded half up, or `None` when the model or a used rate is unknown.
    /// Unknown stays unknown: never $0 for a cloud model without a price. Local models (LM Studio, `local/…` ids)
    /// and free tiers (`…-free` ids) cost a known $0.
    /// One-hour cache writes are priced at their own rate, or at the cache write rate when the model has none.
    pub fn price(&self, tokens: &TokenCounts, model: &str, tool: ToolId) -> Option<PricedCost> {
        self.price_tier(tokens, model, tool, false)
    }

    /// [`Self::price`], on Codex's Fast service tier when `priority` is set. Each used component then takes its
    /// `_priority` rate where the model publishes one (its `_above_<n>k_tokens_priority` rate in long context, else
    /// Price using the recorded service tier; Fast and priority share the published priority schedule.
    pub fn price_on_tier(
        &self,
        tokens: &TokenCounts,
        model: &str,
        tool: ToolId,
        service_tier: Option<&str>,
    ) -> Option<PricedCost> {
        self.price_tier(tokens, model, tool, matches!(service_tier, Some("priority" | "fast")))
    }

    /// its flat `_priority` rate), and its Standard rate otherwise. Cache savings use the same rates.
    pub fn price_tier(&self, tokens: &TokenCounts, model: &str, tool: ToolId, priority: bool) -> Option<PricedCost> {
        let one_hour = tokens.cache_write_1h.unwrap_or(0).min(tokens.cache_write);
        let counts = [
            tokens.input,
            tokens.output,
            tokens.cache_read,
            tokens.cache_write - one_hour,
            one_hour,
        ];
        let priced = |cost_microusd, parts| {
            Some(PricedCost {
                cost_microusd,
                pricing_version: self.version.clone(),
                parts,
            })
        };
        // No tokens costs nothing, whatever the model (for example Claude Code's `<synthetic>` placeholders). Local
        // models run on the user's computer with no API bill: LM Studio, and the `local/` routes of Unsloth Studio.
        // Free tiers bill nothing either.
        if counts.iter().all(|&count| count == 0)
            || tool == ToolId::LmStudio
            || model.starts_with("local/")
            || is_free(model)
        {
            return priced(0, CostParts::default());
        }
        let price = self.lookup(model, tool)?;
        let context = u128::from(tokens.input) + u128::from(tokens.cache_read) + u128::from(tokens.cache_write);
        let mut rates = price.standard.at(context);
        if priority {
            for (rate, fast) in rates.iter_mut().zip(price.priority.at(context)) {
                *rate = fast.or(*rate);
            }
        }
        let rate = |component: usize| rates[component];
        let mut picodollars = 0u128;
        let mut kinds = [0u128; 4];
        for (component, &count) in counts.iter().enumerate().filter(|(_, count)| **count > 0) {
            let per_token =
                rate(component).or_else(|| (component == CACHE_WRITE_1H).then(|| rate(CACHE_WRITE)).flatten())?;
            picodollars += u128::from(count) * u128::from(per_token);
            kinds[component.min(CACHE_WRITE)] += u128::from(count) * u128::from(per_token);
        }
        let micro = u64::try_from((picodollars + 500_000) / 1_000_000).ok()?;
        if micro > MAX_SAFE_INTEGER {
            return None;
        }
        // Cache reads at the input rate, less what they cost; a cache read is never dearer than input in practice.
        let saved = match (rate(0), rate(2)) {
            (Some(input), Some(read)) => u128::from(tokens.cache_read) * u128::from(input.saturating_sub(read)),
            _ => 0,
        };
        let parts = CostParts {
            cache_savings: u64::try_from((saved + 500_000) / 1_000_000).ok()?,
            ..split(kinds, micro)
        };
        priced(micro, parts)
    }

    fn lookup(&self, model: &str, tool: ToolId) -> Option<&ModelPrice> {
        let mut resolved = self.resolved.lock().unwrap_or_else(PoisonError::into_inner);
        let by_model = resolved.entry(tool).or_default();
        let found = match by_model.get(model) {
            Some(&found) => found,
            None => {
                let found = candidates(model, tool)
                    .iter()
                    .find_map(|candidate| self.index.get(candidate.as_str()))
                    .copied();
                by_model.insert(model.to_owned(), found);
                found
            }
        };
        found.map(|at| &self.prices[at])
    }
}
