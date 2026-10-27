//! Request bodies as Fastify's content-type parsers read them, with the per-route limit set by `DefaultBodyLimit`.
use crate::error::LocalError;
use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody};
use axum::extract::{FromRequest, Request};
use axum::http::{Method, header};
use serde_json::Value;
use std::time::Duration;

/// The whole request must arrive within this time (Node's `requestTimeout`); a slower body is 408.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The body of a request: `None` when it has none (`undefined` in TypeScript), parsed JSON for `application/json`,
/// a string for `text/plain`. Other media types are 415; empty, malformed or `__proto__`/`constructor.prototype`
/// JSON is 400; a body over the route's `DefaultBodyLimit` is 413. GET and HEAD bodies are never read.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonBody(pub Option<Value>);

enum Parser {
    Json,
    Text,
}

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = LocalError;

    async fn from_request(request: Request, state: &S) -> Result<Self, LocalError> {
        if [Method::GET, Method::HEAD, Method::TRACE].contains(request.method()) {
            return Ok(Self(None));
        }
        let headers = request.headers();
        let parser = match headers.get(header::CONTENT_TYPE) {
            None => {
                let length = headers.get(header::CONTENT_LENGTH);
                if !headers.contains_key(header::TRANSFER_ENCODING) && length.is_none_or(|length| length == "0") {
                    return Ok(Self(None));
                }
                None
            }
            Some(value) => match value.to_str().ok().and_then(media_type).as_deref() {
                Some("application/json") => Some(Parser::Json),
                Some("text/plain") => Some(Parser::Text),
                _ => None,
            },
        };
        let parser = parser.ok_or(LocalError::from_status(415))?;
        let bytes = match tokio::time::timeout(REQUEST_TIMEOUT, Bytes::from_request(request, state)).await {
            Err(_) => return Err(LocalError::from_status(408)),
            Ok(Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_)))) => {
                return Err(LocalError::from_status(413));
            }
            Ok(Err(_)) => return Err(LocalError::from_status(400)),
            Ok(Ok(bytes)) => bytes,
        };
        match parser {
            Parser::Text => Ok(Self(Some(Value::String(String::from_utf8_lossy(&bytes).into_owned())))),
            Parser::Json => serde_json::from_slice(&bytes)
                .ok()
                .filter(|value| !poisoned(value))
                .map(|value| Self(Some(value)))
                .ok_or(LocalError::from_status(400)),
        }
    }
}

/// The `type/subtype` of a Content-Type, lowercased, when both are HTTP tokens.
fn media_type(value: &str) -> Option<String> {
    let essence = value.split(';').next()?;
    let (kind, subtype) = essence.split_once('/')?;
    let (kind, subtype) = (kind.trim_start(), subtype.trim_end());
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&c))
    };
    (token(kind) && token(subtype)).then(|| format!("{kind}/{subtype}").to_ascii_lowercase())
}

/// secure-json-parse with Fastify's defaults: a `__proto__` key, or a `constructor` object with a `prototype` key.
fn poisoned(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.contains_key("__proto__")
                || map
                    .get("constructor")
                    .and_then(Value::as_object)
                    .is_some_and(|constructor| constructor.contains_key("prototype"))
                || map.values().any(poisoned)
        }
        Value::Array(items) => items.iter().any(poisoned),
        _ => false,
    }
}
