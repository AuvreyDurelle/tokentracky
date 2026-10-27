//! Browser approval (`apps/server/src/connect.ts`). The member signs in and consents on the hosted site; this process
//! holds only a poll secret until approval, then saves the device credential with exactly the approved scope.
use crate::error::LocalError;
use crate::http::{HttpClient, HttpRequest, HttpResponse};
use crate::link::validate_cloud_link;
use crate::sync::{CloudSync, HOSTED_TIMEOUT, Outcome, outcome};
use axum::http::{Method, StatusCode, header};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tokentracky_core::is_js_space;
use tokio::sync::watch;

const NOT_STARTED: LocalError = LocalError::new(
    409,
    "CONNECT_NOT_STARTED",
    "Start joining the leaderboard from the app.",
);
const RATE_LIMITED: LocalError =
    LocalError::new(429, "RATE_LIMITED", "Too many attempts. Wait a minute and try again.");
const UNAVAILABLE: LocalError = LocalError::new(
    502,
    "CONNECT_FAILED",
    "The leaderboard could not be reached. Check your connection and try again.",
);
const COUNTER_OVERFLOW: LocalError = LocalError::new(
    422,
    "COUNTER_OVERFLOW",
    "Connecting this computer would exceed your account's usage limit. Correct the usage, or save your listing on the website and sync again, then retry connecting.",
);

/// The answer of `POST /api/local/connect`. The poll secret never leaves this process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectStart {
    pub user_code: String,
    pub verification_url: String,
    pub expires_at: String,
}

/// The answer of `POST /api/local/connect/poll`: `{"status":"pending"}`, `"expired"`, or `"connected"` with the alias.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ConnectStatus {
    Pending,
    Expired,
    Connected { alias: String },
}

struct Pending {
    url: String,
    poll_token: String,
}

#[derive(Default)]
struct State {
    pending: Option<Arc<Pending>>,
    active: Option<Outcome<ConnectStatus>>,
}

pub struct DeviceConnect {
    sync: Arc<CloudSync>,
    client: Arc<dyn HttpClient>,
    device_name: String,
    machine_id: Option<String>,
    state: Mutex<State>,
}

/// Never change it: a different hash makes every computer look new to the hosted service.
const MACHINE_ID_SALT: &str = "tokentracky-machine-id-v1:";

/// Lets the hosted service tell this computer connecting again (a reinstall, a new data folder) from another computer,
/// so it replaces this computer's earlier totals instead of adding to them. Only a salted hash leaves the computer.
/// `None` where there is no hardware UUID to read: only macOS has one today.
pub fn machine_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/sbin/ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        platform_uuid(&String::from_utf8_lossy(&output.stdout)).map(hashed_machine_id)
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// The hardware UUID in `ioreg -rd1 -c IOPlatformExpertDevice` output.
pub fn platform_uuid(ioreg: &str) -> Option<&str> {
    ioreg
        .lines()
        .find_map(|line| line.trim().strip_prefix(r#""IOPlatformUUID" = ""#)?.strip_suffix('"'))
        .filter(|uuid| {
            uuid.len() == 36
                && uuid.char_indices().all(|(index, c)| {
                    if matches!(index, 8 | 13 | 18 | 23) {
                        c == '-'
                    } else {
                        c.is_ascii_hexdigit()
                    }
                })
        })
}

pub fn hashed_machine_id(platform_uuid: &str) -> String {
    hex::encode(Sha256::digest(format!("{MACHINE_ID_SALT}{platform_uuid}")))
}

/// A readable, non-identifying label for the member's own device list: the host name (this machine's when `None`)
/// without `.local`, control characters and surrounding space, at most 80 UTF-16 units, or `My computer`.
pub fn default_device_name(name: Option<&str>) -> String {
    let host;
    let name = match name {
        Some(name) => name,
        None => {
            host = gethostname::gethostname().to_string_lossy().into_owned();
            &host
        }
    };
    let bytes = name.as_bytes();
    let name = if bytes.len() >= 6 && bytes[bytes.len() - 6..].eq_ignore_ascii_case(b".local") {
        &name[..name.len() - 6]
    } else {
        name
    };
    let printable: String = name.chars().filter(|&c| c >= ' ' && c != '\u{7f}').collect();
    let mut units = 0;
    let label: String = printable
        .trim_matches(is_js_space)
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 80
        })
        .collect();
    if label.is_empty() {
        "My computer".to_owned()
    } else {
        label
    }
}

impl DeviceConnect {
    /// `machine_id`: [`machine_id`] in the app; older apps sent none and each connection added a computer.
    pub fn new(
        sync: Arc<CloudSync>,
        client: Arc<dyn HttpClient>,
        device_name: String,
        machine_id: Option<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            sync,
            client,
            device_name,
            machine_id,
            state: Mutex::default(),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Asks `url` (a hosted origin) for a user code; a later start replaces the pending one.
    pub async fn start(&self, url: &str) -> Result<ConnectStart, LocalError> {
        let mut body = json!({"deviceName": self.device_name});
        if let Some(machine_id) = &self.machine_id {
            body["machineId"] = machine_id.as_str().into();
        }
        let body = body.to_string();
        let request = HttpRequest::new(Method::POST, format!("{url}/api/device-auth"), HOSTED_TIMEOUT).json(body);
        let response = self.request(request).await?;
        if response.status == StatusCode::TOO_MANY_REQUESTS {
            return Err(RATE_LIMITED);
        }
        if !response.ok() {
            return Err(UNAVAILABLE);
        }
        let body = serde_json::from_slice::<Value>(&response.body).ok();
        let text = |key| body.as_ref().and_then(|body| body.get(key)).and_then(Value::as_str);
        let code = text("userCode").filter(|code| {
            let code = code.as_bytes();
            code.len() == 9 && code[4] == b'-' && code[..4].iter().chain(&code[5..]).all(u8::is_ascii_uppercase)
        });
        let (Some(poll_token), Some(user_code), Some(expires_at)) = (text("pollToken"), code, text("expiresAt")) else {
            return Err(UNAVAILABLE);
        };
        self.state().pending = Some(Arc::new(Pending {
            url: url.to_owned(),
            poll_token: poll_token.to_owned(),
        }));
        Ok(ConnectStart {
            user_code: user_code.to_owned(),
            verification_url: format!("{url}/?connect={user_code}"),
            expires_at: expires_at.to_owned(),
        })
    }

    /// Concurrent callers share one check, so the single-use credential is collected once.
    pub async fn poll(self: &Arc<Self>) -> Result<ConnectStatus, LocalError> {
        let done = {
            let mut state = self.state();
            match &state.active {
                Some(done) => done.clone(),
                None => {
                    let (sender, done) = watch::channel(None);
                    state.active = Some(done.clone());
                    let this = self.clone();
                    tokio::spawn(async move {
                        let result = this.check().await;
                        this.state().active = None;
                        sender.send_replace(Some(result));
                    });
                    done
                }
            }
        };
        outcome(done, LocalError::internal()).await
    }

    async fn check(&self) -> Result<ConnectStatus, LocalError> {
        let pending = self.state().pending.clone().ok_or(NOT_STARTED)?;
        let request = HttpRequest::new(
            Method::POST,
            format!("{}/api/device-auth/poll", pending.url),
            HOSTED_TIMEOUT,
        )
        .header(header::AUTHORIZATION, format!("Bearer {}", pending.poll_token));
        let response = self.request(request).await?;
        if response.status == StatusCode::GONE {
            self.forget(&pending);
            return Ok(ConnectStatus::Expired);
        }
        if response.status == StatusCode::UNPROCESSABLE_ENTITY
            && serde_json::from_slice::<Value>(&response.body)
                .ok()
                .and_then(|body| body.pointer("/error/code").and_then(Value::as_str).map(str::to_owned))
                .as_deref()
                == Some("COUNTER_OVERFLOW")
        {
            // The hosted transaction rolled back. Keep this authorization available for correction and retry.
            return Err(COUNTER_OVERFLOW);
        }
        if !response.ok() {
            return Err(UNAVAILABLE);
        }
        let body = serde_json::from_slice::<Value>(&response.body).ok();
        let field = |key| body.as_ref().and_then(|body| body.get(key));
        if field("status") == Some(&Value::from("pending")) {
            return Ok(ConnectStatus::Pending);
        }
        let publication = field("publication");
        let alias = publication
            .and_then(|publication| publication.get("alias"))
            .and_then(Value::as_str);
        let (true, Some(publication), Some(alias)) =
            (field("status") == Some(&Value::from("approved")), publication, alias)
        else {
            return Err(UNAVAILABLE);
        };
        // The credential is single-use from here on: never poll for it again.
        self.forget(&pending);
        let mut link = Map::new();
        link.insert("url".into(), pending.url.clone().into());
        let fields = [
            ("deviceToken", field("deviceToken")),
            ("historyStart", publication.get("historyStart")),
            ("shareTools", publication.get("shareTools")),
            ("shareCost", publication.get("shareCost")),
        ];
        for (key, value) in fields {
            if let Some(value) = value {
                link.insert(key.into(), value.clone());
            }
        }
        let share_models = publication.get("shareModels") == Some(&Value::Bool(true));
        link.insert("shareModels".into(), share_models.into());
        self.sync
            .set_link(validate_cloud_link(Some(&Value::Object(link)))?)
            .await?;
        // Upload once before reporting success so the app can show its standing right away.
        let _ = self.sync.sync().await;
        Ok(ConnectStatus::Connected {
            alias: alias.to_owned(),
        })
    }

    fn forget(&self, pending: &Arc<Pending>) {
        let mut state = self.state();
        if state
            .pending
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, pending))
        {
            state.pending = None;
        }
    }

    async fn request(&self, request: HttpRequest) -> Result<HttpResponse, LocalError> {
        self.client.send(request).await.map_err(|_| UNAVAILABLE)
    }
}
