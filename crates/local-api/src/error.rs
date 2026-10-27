//! The uniform error body and the error and not-found handlers.
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};

/// The content type Fastify gives every JSON reply.
pub const JSON: &str = "application/json; charset=utf-8";

/// A refusal with its status, stable code and human-readable message, answered as exactly
/// `{"error":{"code":..,"message":..}}`. Every code and message is a TypeScript literal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct LocalError {
    pub status: u16,
    pub code: &'static str,
    pub message: &'static str,
}

impl LocalError {
    pub const fn new(status: u16, code: &'static str, message: &'static str) -> Self {
        Self { status, code, message }
    }
    /// The not-found handler: unknown paths, and known paths with another method.
    pub const fn not_found() -> Self {
        Self::new(404, "NOT_FOUND", "This endpoint does not exist.")
    }
    /// What the error handler makes of any other failure with this status.
    pub const fn from_status(status: u16) -> Self {
        match status {
            429 => Self::new(429, "RATE_LIMITED", "Too many requests. Please try again shortly."),
            400..=499 => Self::new(status, "INVALID_REQUEST", "The request could not be accepted."),
            _ => Self::internal(),
        }
    }
    pub const fn internal() -> Self {
        Self::new(500, "INTERNAL_ERROR", "The service could not complete this request.")
    }
    pub const fn invalid_request() -> Self {
        Self::new(400, "INVALID_REQUEST", "Request contains invalid fields.")
    }
}

#[derive(Serialize)]
struct Body<'a> {
    error: Detail<'a>,
}
#[derive(Serialize)]
struct Detail<'a> {
    code: &'a str,
    message: &'a str,
}

impl IntoResponse for LocalError {
    fn into_response(self) -> Response {
        let body = Body {
            error: Detail {
                code: self.code,
                message: self.message,
            },
        };
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut response = json(status, &body);
        // Marks the reply as already shaped, so `shape_errors` leaves it alone.
        response.extensions_mut().insert(self);
        response
    }
}

/// A JSON reply with Fastify's content type.
pub fn json(status: StatusCode, value: &impl Serialize) -> Response {
    let body = serde_json::to_vec(value).expect("reply bodies serialize");
    (status, [(header::CONTENT_TYPE, HeaderValue::from_static(JSON))], body).into_response()
}

/// `object(value, keys)`: a JSON object with no key outside `keys`; anything else (including no body) is 400.
pub fn object<'a>(value: Option<&'a Value>, keys: &[&str]) -> Result<&'a Map<String, Value>, LocalError> {
    value
        .and_then(Value::as_object)
        .filter(|body| body.keys().all(|key| keys.contains(&key.as_str())))
        .ok_or(LocalError::invalid_request())
}

/// Marks a hosted answer relayed as it is, so `shape_errors` leaves it alone.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Relayed;

/// Gives the framework's own refusals (405, 413, 400 rejections, an empty 404 from a file) the error body, as the
/// Fastify error and not-found handlers do. A wrong method on a known path is a 404, as in Fastify.
pub(crate) async fn shape_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status().as_u16();
    let extensions = response.extensions();
    if status < 400 || extensions.get::<LocalError>().is_some() || extensions.get::<Relayed>().is_some() {
        return response;
    }
    match status {
        404 | 405 => LocalError::not_found(),
        status => LocalError::from_status(status),
    }
    .into_response()
}
