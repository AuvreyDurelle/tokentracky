# Third-party notices

Inline interface icons use Lucide shapes, including icons derived from Feather. Their ISC and MIT notices, together with the project MIT licence and LiteLLM data licence, are included in [the distributed notices](apps/web/public/assets/third-party-notices.txt). Vite copies this file into the web build; native app and CLI bundles include that build. The product terms link to the same notices.

The bundled LiteLLM snapshot records its upstream commit and data source in `crates/pricing/data/litellm-prices.json`. Its MIT licence remains in `crates/pricing/data/LICENSE-litellm.txt`. Hand-maintained prices record their independent sources in `crates/pricing/data/curated-prices.json`.

The Antigravity reader (`crates/collector/src/readers/antigravity.rs`) ports the transcript and `gen_metadata` accounting of [TokenTracker](https://github.com/xiufengsun/TokenTracker) (MIT, commit `3f72861`), and its tests port TokenTracker's cases; the Gemini CLI hook (`crates/collector/src/gemini_hook.rs`) follows TokenTracker's `gemini-config.js`. Its MIT licence is included in the distributed notices.

Other dependencies retain their own licences. Rust and npm dependency versions are recorded in the committed lockfiles; release inventories should cover the actual distributed dependency set.
