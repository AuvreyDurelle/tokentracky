//! Every request to the hosted service goes through [`HttpClient`]: the reqwest client in production, a scripted
//! fake in tests.
use axum::http::{HeaderMap, HeaderName, Method, StatusCode, header};
use std::error::Error;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type HttpError = Box<dyn Error + Send + Sync>;

// Match the first-party gateway's response ceiling, including direct hosted connections.
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// One outbound request. `body` is JSON text, sent with `Content-Type: application/json`.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(HeaderName, String)>,
    pub body: Option<String>,
    /// Covers the whole exchange, body included (`AbortSignal.timeout`).
    pub timeout: Duration,
}

impl HttpRequest {
    pub fn new(method: Method, url: String, timeout: Duration) -> Self {
        Self {
            method,
            url,
            headers: Vec::new(),
            body: None,
            timeout,
        }
    }
    pub fn header(mut self, name: HeaderName, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
    pub fn json(mut self, body: String) -> Self {
        self.body = Some(body);
        self
    }
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// `Response.ok`.
    pub fn ok(&self) -> bool {
        self.status.is_success()
    }
}

/// Sends a request and reads the whole answer. Implementations follow no redirects: a 3xx comes back as it is, and
/// every caller treats it as a failure, as `redirect: 'error'` does. Network failures and timeouts are errors.
pub trait HttpClient: Send + Sync {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, HttpError>>;
}

/// The production client: rustls, no redirects, no proxy (as Node's fetch), the timeout per request.
pub struct ReqwestClient(reqwest::Client);

impl ReqwestClient {
    pub fn new() -> Result<Self, HttpError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        Ok(Self(client))
    }
}

impl HttpClient for ReqwestClient {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, HttpError>> {
        Box::pin(async move {
            let mut builder = self.0.request(request.method, &request.url).timeout(request.timeout);
            for (name, value) in request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body {
                builder = builder.header(header::CONTENT_TYPE, "application/json").body(body);
            }
            let mut response = builder.send().await?;
            let (status, headers) = (response.status(), response.headers().clone());
            // SECURITY: A hostile upstream can omit Content-Length or stream indefinitely. Bound actual bytes
            // before appending, not just declared size (VULN-003). Do not remove.
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
            {
                return Err("hosted_response_too_large".into());
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
                    return Err("hosted_response_too_large".into());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(HttpResponse { status, headers, body })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    async fn upstream(head: &str, body: Vec<u8>, delay: Duration) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let head = head.to_owned();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
                assert!(request.len() < 8192);
            }
            socket.write_all(head.as_bytes()).await.unwrap();
            tokio::time::sleep(delay).await;
            // Oversize rejection may close the connection before the server finishes writing.
            let _ = socket.write_all(&body).await;
        });
        (url, task)
    }

    async fn fetch(head: &str, body: Vec<u8>) -> Result<HttpResponse, HttpError> {
        let (url, server) = upstream(head, body, Duration::ZERO).await;
        let result = ReqwestClient::new()
            .unwrap()
            .send(HttpRequest::new(Method::GET, url, Duration::from_secs(5)))
            .await;
        server.await.unwrap();
        result
    }

    fn chunked(length: usize) -> Vec<u8> {
        let mut body = Vec::new();
        let mut remaining = length;
        while remaining > 0 {
            let count = remaining.min(16 * 1024);
            body.extend_from_slice(format!("{count:x}\r\n").as_bytes());
            body.resize(body.len() + count, b'x');
            body.extend_from_slice(b"\r\n");
            remaining -= count;
        }
        body.extend_from_slice(b"0\r\n\r\n");
        body
    }

    #[tokio::test]
    async fn rejects_declared_oversize_without_waiting_for_body() {
        let (url, server) = upstream(
            &format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_RESPONSE_BYTES + 1),
            vec![],
            Duration::from_secs(1),
        )
        .await;
        let result = ReqwestClient::new()
            .unwrap()
            .send(HttpRequest::new(Method::GET, url, Duration::from_millis(500)))
            .await;
        server.abort();
        assert_eq!(result.unwrap_err().to_string(), "hosted_response_too_large");
    }

    #[tokio::test]
    async fn accepts_exact_limit_with_declared_length() {
        let response = fetch(
            &format!("HTTP/1.1 200 OK\r\nContent-Length: {MAX_RESPONSE_BYTES}\r\n\r\n"),
            vec![b'x'; MAX_RESPONSE_BYTES],
        )
        .await
        .unwrap();
        assert_eq!(response.body, vec![b'x'; MAX_RESPONSE_BYTES]);
    }

    #[tokio::test]
    async fn enforces_actual_chunked_bytes_at_the_boundary() {
        for length in [MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES + 1] {
            let result = fetch("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", chunked(length)).await;
            if length == MAX_RESPONSE_BYTES {
                assert_eq!(result.unwrap().body, vec![b'x'; length]);
            } else {
                assert_eq!(result.unwrap_err().to_string(), "hosted_response_too_large");
            }
        }
    }

    #[tokio::test]
    async fn enforces_bytes_without_a_declared_length() {
        for length in [0, MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES + 1] {
            let result = fetch("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n", vec![b'x'; length]).await;
            if length <= MAX_RESPONSE_BYTES {
                assert_eq!(result.unwrap().body, vec![b'x'; length]);
            } else {
                assert_eq!(result.unwrap_err().to_string(), "hosted_response_too_large");
            }
        }
    }

    #[tokio::test]
    async fn bounds_error_responses_too() {
        let result = fetch(
            "HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n",
            chunked(MAX_RESPONSE_BYTES + 1),
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), "hosted_response_too_large");
    }

    #[tokio::test]
    async fn preserves_status_headers_and_bytes_without_following_redirects() {
        let response = fetch(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nRetry-After: 7\r\nContent-Length: 2\r\n\r\n",
            b"{}".to_vec(),
        )
        .await
        .unwrap();
        assert_eq!(response.status, StatusCode::FOUND);
        assert_eq!(response.headers[header::RETRY_AFTER], "7");
        assert_eq!(response.body, b"{}");
    }

    #[tokio::test]
    async fn truncated_body_remains_a_transport_error() {
        assert!(
            fetch("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n", b"{}".to_vec())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn timeout_still_covers_body_reads() {
        let (url, server) = upstream(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n",
            b"{}".to_vec(),
            Duration::from_secs(1),
        )
        .await;
        let result = ReqwestClient::new()
            .unwrap()
            .send(HttpRequest::new(Method::GET, url, Duration::from_millis(100)))
            .await;
        server.abort();
        assert!(
            result
                .unwrap_err()
                .downcast_ref::<reqwest::Error>()
                .unwrap()
                .is_timeout()
        );
    }
}
