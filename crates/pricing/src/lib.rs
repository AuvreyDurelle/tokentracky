//! Bundled LiteLLM prices, model aliases, exact micro-USD costs, and daily refresh with a 24-hour cache.
mod json;
mod refresher;
mod table;

pub use json::Json;
pub use refresher::{
    Clock, LITELLM_URL, MAX_DOWNLOAD_BYTES, PricingRefresher, REFRESH_AFTER_MS, RefresherOptions, Transport,
    TransportError, bundled_table, pricing_refresh_enabled,
};
pub use table::{Ceiling, PricedCost, PricingTable, trim_litellm};
use tokentracky_core::{TokenCounts, ToolId};

#[derive(Debug, thiserror::Error)]
pub enum PricingError {
    #[error("invalid_pricing_table")]
    InvalidTable,
    #[error("pricing_download_failed: response over 20 MiB")]
    TooLarge,
    #[error("pricing_download_failed: {0}")]
    Transport(TransportError),
    #[error("invalid pricing JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("pricing cache write failed: {0}")]
    Cache(#[from] std::io::Error),
}

/// Estimated cost of one usage event with the bundled table, or `None` when the model has no known price.
pub fn price_event(tokens: &TokenCounts, model: &str, tool: ToolId) -> Option<PricedCost> {
    bundled_table().price(tokens, model, tool)
}
