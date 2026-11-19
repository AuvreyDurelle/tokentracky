# Third-party notices

Inline interface icons use Lucide shapes, including icons derived from Feather. Their ISC and MIT notices, together with the project MIT licence and LiteLLM data licence, are included in [the distributed notices](apps/web/public/assets/third-party-notices.txt). Vite copies this file into the web build; native app and CLI bundles include that build. The product terms link to the same notices.

The bundled LiteLLM snapshot records its upstream commit and data source in `crates/pricing/data/litellm-prices.json`. Its MIT licence remains in `crates/pricing/data/LICENSE-litellm.txt`. Hand-maintained prices record their independent sources in `crates/pricing/data/curated-prices.json`.

The hosted API renders link-preview cards with the Inter typeface (Inter Medium and SemiBold, v4.1), bundled under the SIL Open Font License 1.1 in `packages/cloud/fonts` with its licence in `packages/cloud/fonts/LICENSE-Inter.txt`.

Other dependencies retain their own licences. Rust and npm dependency versions are recorded in the committed lockfiles; release inventories should cover the actual distributed dependency set.
