//! The device link: where it publishes, with which credential and consent scope, and the explicit projection of
//! what may leave the device.
use crate::error::{LocalError, object};
use crate::http::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::sync::{Mutex, PoisonError};
use time::OffsetDateTime;
use tokentracky_collector::store::{PublicationOptions, StoreError, UsageStore};
use tokentracky_core::{BucketTool, PublicBucket, is_js_space, is_utc_day, iso_timestamp};

/// A saved link. Field order is the TypeScript object's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLink {
    pub url: String,
    pub device_token: String,
    pub history_start: Option<String>,
    pub share_tools: bool,
    pub share_cost: bool,
    /// Absent in links saved before model sharing existed, which means not shared.
    #[serde(default)]
    pub share_models: bool,
    pub generation: String,
}

/// A link as the member submits it: everything but the generation, which the hosted policy supplies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkInput {
    pub url: String,
    pub device_token: String,
    pub history_start: Option<String>,
    pub share_tools: bool,
    pub share_cost: bool,
    pub share_models: bool,
}

impl LinkInput {
    pub fn with_generation(self, generation: String) -> CloudLink {
        CloudLink {
            url: self.url,
            device_token: self.device_token,
            history_start: self.history_start,
            share_tools: self.share_tools,
            share_cost: self.share_cost,
            share_models: self.share_models,
            generation,
        }
    }
}

impl CloudLink {
    pub fn scope(&self) -> Scope<'_> {
        Scope {
            history_start: self.history_start.as_deref(),
            share_tools: self.share_tools,
            share_cost: self.share_cost,
            share_models: self.share_models,
        }
    }
    /// The store's projection options: history from its UTC day.
    pub fn publication_options(&self) -> PublicationOptions {
        PublicationOptions {
            history_start: self
                .history_start
                .as_deref()
                .map(|start| start.get(..10).unwrap_or(start).to_owned()),
            share_tools: self.share_tools,
            share_cost: self.share_cost,
            share_models: self.share_models,
        }
    }
}

pub type SecretError = Box<dyn Error + Send + Sync>;

/// Where the link (and so the device credential) is kept: a private file (`cloud-link.json`) in the app and CLI,
/// memory in tests.
pub trait SecretStore: Send + Sync {
    fn get(&self) -> BoxFuture<'_, Result<Option<CloudLink>, SecretError>>;
    fn set(&self, link: CloudLink) -> BoxFuture<'_, Result<(), SecretError>>;
    fn clear(&self) -> BoxFuture<'_, Result<(), SecretError>>;
}

/// Keeps the link for the life of the process.
#[derive(Debug, Default)]
pub struct MemorySecretStore(Mutex<Option<CloudLink>>);

impl SecretStore for MemorySecretStore {
    fn get(&self) -> BoxFuture<'_, Result<Option<CloudLink>, SecretError>> {
        let link = self.0.lock().unwrap_or_else(PoisonError::into_inner).clone();
        Box::pin(async move { Ok(link) })
    }
    fn set(&self, link: CloudLink) -> BoxFuture<'_, Result<(), SecretError>> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(link);
        Box::pin(async { Ok(()) })
    }
    fn clear(&self) -> BoxFuture<'_, Result<(), SecretError>> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Box::pin(async { Ok(()) })
    }
}

const URL_REQUIRED: LocalError = LocalError::new(400, "INVALID_CLOUD_URL", "A hosted service URL is required.");
/// The hosted origin bundled by distributed first-party clients. Generic local API users remain unconfigured.
pub const DEFAULT_CLOUD_ORIGIN: &str = "https://tokentracky.com";
const INVALID_URL: LocalError = LocalError::new(
    400,
    "INVALID_CLOUD_URL",
    "Use the HTTPS origin of your hosted service (loopback HTTP is allowed for development).",
);
const INVALID_HISTORY: LocalError = LocalError::new(400, "INVALID_HISTORY", "Choose a UTC day no later than today.");
const INVALID_LINK: LocalError = LocalError::new(400, "INVALID_LINK", "Review the device token and sharing choices.");

/// The HTTPS origin of a hosted service (loopback HTTP allowed): no credentials, path, query or fragment.
pub fn cloud_origin(value: &str) -> Result<String, LocalError> {
    let url = url::Url::parse(value).map_err(|_| INVALID_URL)?;
    let loopback = ["127.0.0.1", "localhost", "[::1]"].contains(&url.host_str().unwrap_or(""));
    let scheme = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    let present = |part: Option<&str>| part.is_some_and(|part| !part.is_empty());
    if !scheme
        || !url.username().is_empty()
        || present(url.password())
        || present(url.query())
        || present(url.fragment())
        || url.path() != "/"
    {
        return Err(INVALID_URL);
    }
    Ok(url.origin().ascii_serialization())
}

/// A history start: `null`, or a UTC day (optionally at midnight) no later than today, as midnight.
pub fn cutoff(value: Option<&Value>) -> Result<Option<String>, LocalError> {
    let day = match value {
        Some(Value::Null) => return Ok(None),
        Some(Value::String(text)) => text.get(..10).filter(|day| {
            matches!(text.get(10..), Some("" | "T00:00:00Z" | "T00:00:00.000Z"))
                && is_utc_day(day)
                && *day <= &iso_timestamp(OffsetDateTime::now_utc())[..10]
        }),
        _ => None,
    };
    day.map(|day| Some(format!("{day}T00:00:00.000Z")))
        .ok_or(INVALID_HISTORY)
}

/// `validateCloudLink`: unknown fields are 400 `INVALID_REQUEST`, then the token and sharing choices, the URL and the
/// history are checked in that order.
pub fn validate_cloud_link(value: Option<&Value>) -> Result<LinkInput, LocalError> {
    let body = object(
        value,
        &[
            "url",
            "deviceToken",
            "historyStart",
            "shareTools",
            "shareCost",
            "shareModels",
        ],
    )?;
    let token = body
        .get("deviceToken")
        .and_then(Value::as_str)
        .filter(|token| (20..=256).contains(&token.encode_utf16().count()) && !token.chars().any(is_js_space));
    let flag = |key| body.get(key).and_then(Value::as_bool);
    let share_models = body.get("shareModels").map_or(Some(false), Value::as_bool);
    let (Some(token), Some(share_tools), Some(share_cost), Some(share_models)) =
        (token, flag("shareTools"), flag("shareCost"), share_models)
    else {
        return Err(INVALID_LINK);
    };
    let url = match body.get("url") {
        Some(Value::String(url)) => cloud_origin(url)?,
        _ => return Err(URL_REQUIRED),
    };
    Ok(LinkInput {
        url,
        device_token: token.to_owned(),
        history_start: cutoff(body.get("historyStart"))?,
        share_tools,
        share_cost,
        share_models,
    })
}

/// What a link or a hosted policy shares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scope<'a> {
    pub history_start: Option<&'a str>,
    pub share_tools: bool,
    pub share_cost: bool,
    pub share_models: bool,
}

/// True when `a` shares something `b` does not: a field, or history from before `b`'s start.
pub fn broader(a: Scope<'_>, b: Scope<'_>) -> bool {
    (a.share_tools && !b.share_tools)
        || (a.share_cost && !b.share_cost)
        || (a.share_models && !b.share_models)
        || b.history_start.is_some_and(|b| a.history_start.is_none_or(|a| a < b))
}

/// Explicit projection at the network boundary; project and session identifiers never leave.
pub fn upload_buckets(store: &mut UsageStore, link: &CloudLink) -> Result<Vec<PublicBucket>, StoreError> {
    Ok(store
        .project_public_buckets(&link.publication_options())?
        .into_iter()
        .map(|bucket| PublicBucket {
            day: bucket.day,
            tool: if link.share_tools { bucket.tool } else { BucketTool::All },
            model: bucket.model.filter(|_| link.share_models),
            tokens: bucket.tokens,
            cost_microusd: bucket.cost_microusd.filter(|_| link.share_cost),
            revision: bucket.revision,
            breakdown: bucket.breakdown,
        })
        .collect())
}
