# tokentracky-pricing

Estimated costs use model aliases, exact integer arithmetic, a bundled LiteLLM snapshot, and a daily download with a validated cache.

- `PricingTable::price(tokens, model, tool)` returns `PricedCost { cost_microusd, pricing_version }` or `None`. Input, output, cache read and cache write are priced separately in integer picodollars, rounded half up to micro-USD. The one-hour part of cache writes (`cache_write_1h`) is priced at `cache_creation_input_token_cost_above_1hr`, or at the cache write rate when a model has none. Reasoning tokens are already part of output. Long-context tiers (`*_above_<n>k_tokens`) apply when input plus cache tokens exceed the threshold.
- `PricingTable::price_tier(tokens, model, tool, priority)` prices Codex's Fast service tier when `priority` is set: each used component takes its `*_priority` rate (in long context its `*_above_<n>k_tokens_priority` rate, else the flat one) where the model publishes one, and its Standard rate otherwise; `price` is `price_tier` with `false`.
- Unknown models, and used components without a rate, return `None`: unknown stays unknown, never $0. Events with no tokens cost 0 for any model.
- Local models and free tiers cost a known 0, stamped with the table version: every LM Studio event, any model id starting with `local/` (Unsloth Studio's local routes), and any id ending in `-free` (OpenCode's `glm-5.3-flash-free`, Muse's `*-contributor-free`).
- Model ids are matched exactly, then without a provider prefix, Bedrock region and version wrappers, a Vertex `@date` suffix, Claude Code's `[1m]` suffix and a trailing date, then with a dotted Claude version dashed (Copilot's and Zed's `claude-sonnet-4.5`, priced at the API rates), then under the model's own provider's prefix (`glm-` under `zai/`, `kimi-` under `moonshot/`, `minimax-`, `qwen`, `grok-`, `deepseek-`, `mimo-` and `gemini-` likewise), never a reseller's. Gemini CLI prefers LiteLLM's `gemini/` entries. A dated Bedrock Claude entry (`anthropic.claude-sonnet-4-20250514-v1:0`) also answers for its dated and undated Anthropic ids, the newest snapshot taking the undated one, where LiteLLM has no Anthropic entry: LiteLLM drops retired models' Anthropic entries but keeps their Bedrock ones at the same rates.
- `data/curated-prices.json` is a hand-maintained list for what LiteLLM lacks: `models` gives rates (per token, in LiteLLM's field names) for ids LiteLLM has no entry for, and `aliases` points other ids at an entry, LiteLLM's or the list's own. Every entry names its `source` and the date it was `checked`. A LiteLLM entry with the same id wins, and a test fails once the bundled snapshot carries a listed id, so the entry can be removed. The list applies to downloaded tables too. Curated rates must have an independently documented source for each supported token kind. Unverified rates and unsupported aliases are omitted; affected usage keeps its token counts and has unknown cost. Provider-published context/cache tiers apply where documented.
- `PricingRefresher` downloads the table at most once a day, validates it (chat entries only, finite rates up to $1 per token, at least 100 models, 20 MiB cap), caches it at `cache_path` (file mode 0600, directory 0700, written through a temporary file and a rename) and keeps the current table on any failure. `refresh()` returns whether prices changed. `pricing_refresh_enabled(env)` parses `TOKENTRACKY_PRICING_REFRESH`: `off`, `0`, `false` and `no` disable it.
- This crate makes no HTTP request. The refresher takes a `Transport` (fetch a URL, return the body text) and the local API crate supplies the `reqwest` one. The implementation owns the HTTP rules: `Accept: application/json`, no redirects, a 20-second timeout, a non-2xx status as an error, and the `Content-Length` and body capped at `MAX_DOWNLOAD_BYTES`.

## Data files

`data/litellm-prices.json` is a snapshot of LiteLLM's `model_prices_and_context_window.json` (MIT, see `data/LICENSE-litellm.txt`), already trimmed by `trim_litellm`. Its `source` field records the repository, commit and fetch time. The Rust crate owns the snapshot and its upstream license after removal of the legacy TypeScript pricing package. They are embedded with `include_str!`, so the table needs no file at run time.

The snapshot's `fetchedAt` also decides which cache is usable: a cache older than the bundled snapshot is ignored.

## Updating the snapshot

Download `model_prices_and_context_window.json` from a full commit of `BerriAI/litellm`, then use the Rust snapshot writer:

```sh
cargo run -p tokentracky-pricing --example update_snapshot -- <full-upstream-commit-sha> <downloaded-json-file>
```

The writer validates and trims the downloaded table with the production Rust implementation, preserves JavaScript-compatible JSON serialization, writes `data/litellm-prices.json` and prints both its current version and its LiteLLM-only snapshot version. Update the exact-price expectations and the frozen version constant in `tests/pricing.rs` (the LiteLLM-only snapshot version) when the bundled prices change, and remove any `data/curated-prices.json` entry the new snapshot now carries (a test names them). The upstream license stays in `data/LICENSE-litellm.txt`.

## Version rule

`pricing_version` is `litellm:` plus the first 12 hex characters of SHA-256 over the `JSON.stringify` of the trimmed table followed by that of the hand-maintained list, so an unchanged download keeps the version, stored costs are not re-priced for nothing, and a changed hand rate re-prices. The hash of the trimmed table alone equals the TypeScript version exactly, which needs JavaScript's own rules:

- Entries are sorted with `localeCompare` (ICU root collation) and keyed by the lowercased id. `locale_compare` reproduces it for the ASCII ids LiteLLM uses. Keys that are array indices come first, in numeric order, as in a JavaScript object.
- Numbers are written with `ryu-js`, which formats `f64` like `Number.prototype.toString`. `serde_json` runs with `float_roundtrip` so every rate parses to the same `f64` as `JSON.parse`.
- `Json` keeps object members in `JSON.parse` order; a repeated key keeps its first position and takes the last value.

`tests/pricing.rs` checks the trimmed table's hash against the version TypeScript produces, and that the whole snapshot re-serialises byte for byte.

## Known differences

- A response with a lone surrogate escape (`"\ud800"`) or a number outside the `f64` range (`1e999`) fails to parse as a whole; `JSON.parse` accepts both. LiteLLM has neither.
- `localeCompare` for non-ASCII ids is approximated by code point order.
- The dotted Claude, provider-prefix and Bedrock Claude matches and the hand-maintained list are Rust only; the TypeScript package leaves those ids unknown.
- The cache's `fetchedAt` is parsed as RFC 3339, not with `Date.parse`'s wider formats. The refresher writes `toISOString` form, which is RFC 3339.
