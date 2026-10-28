//! Browser approval from the local app.
mod support;

use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::*;
use tokentracky_local_api::{
    CloudLink, CloudSync, ConnectStart, ConnectStatus, DeviceConnect, MemorySecretStore, SecretStore,
    default_device_name, hashed_machine_id, linux_machine_id, machine_guid, platform_uuid,
};
use tokio::sync::Notify;

const URL: &str = "https://cloud.example";
const DEVICE_TOKEN: &str = "ttd_synthetic-device-token-12345";
const MACHINE_ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn publication() -> Value {
    json!({"alias": "alice", "generation": "11111111-1111-4111-8111-111111111111", "historyStart": null, "shareTools": true, "shareCost": false})
}

type Poll = Arc<Mutex<Box<dyn Fn() -> Fetch + Send>>>;

struct Fixture {
    connect: Arc<DeviceConnect>,
    sync: Arc<CloudSync>,
    secrets: Arc<MemorySecretStore>,
    client: Arc<ScriptedClient>,
    poll: Poll,
}

impl Fixture {
    fn set_poll(&self, poll: impl Fn() -> Fetch + Send + 'static) {
        *self.poll.lock().unwrap() = Box::new(poll);
    }
    fn poll_calls(&self) -> usize {
        self.client
            .calls()
            .iter()
            .filter(|call| call.url.ends_with("/poll"))
            .count()
    }
}

fn fixture() -> Fixture {
    fixture_for(Some(MACHINE_ID.to_owned()))
}

fn fixture_for(machine_id: Option<String>) -> Fixture {
    let secrets = Arc::new(MemorySecretStore::default());
    let poll: Poll = Arc::new(Mutex::new(Box::new(|| respond_json(200, json!({"status": "pending"})))));
    let client = ScriptedClient::new({
        let poll = poll.clone();
        move |request| match path(request).as_str() {
            "/api/device-auth" => respond_json(
                200,
                json!({"pollToken": "ttp_secret", "userCode": "BCDF-GHJK", "expiresAt": "2026-10-23T12:10:00.000Z", "interval": 3}),
            ),
            "/api/device-auth/poll" => (poll.lock().unwrap())(),
            "/api/device-policy" => respond_json(200, json!({"publication": publication()})),
            _ => respond_json(200, json!({"accepted": 0})),
        }
    });
    let sync = CloudSync::new(memory_store(), secrets.clone(), client.clone());
    let connect = DeviceConnect::new(sync.clone(), client.clone(), "Studio Mac".to_owned(), machine_id);
    Fixture {
        connect,
        sync,
        secrets,
        client,
        poll,
    }
}

fn approved() -> Fetch {
    respond_json(
        200,
        json!({"status": "approved", "deviceToken": DEVICE_TOKEN, "publication": publication()}),
    )
}

#[tokio::test]
async fn names_the_device_then_saves_the_credential_with_exactly_the_approved_scope() {
    let f = fixture();
    assert_eq!(
        f.connect.start(URL).await.unwrap(),
        ConnectStart {
            user_code: "BCDF-GHJK".to_owned(),
            verification_url: "https://cloud.example/?connect=BCDF-GHJK".to_owned(),
            expires_at: "2026-10-23T12:10:00.000Z".to_owned()
        }
    );
    assert_eq!(
        body(&f.client.calls()[0]),
        json!({"deviceName": "Studio Mac", "machineId": MACHINE_ID})
    );
    assert_eq!(f.connect.poll().await.unwrap(), ConnectStatus::Pending);
    assert_eq!(
        header(&f.client.calls()[1], "authorization").as_deref(),
        Some("Bearer ttp_secret")
    );
    f.set_poll(approved);
    assert_eq!(
        f.connect.poll().await.unwrap(),
        ConnectStatus::Connected {
            alias: "alice".to_owned()
        }
    );
    assert_eq!(
        f.secrets.get().await.unwrap(),
        Some(CloudLink {
            url: URL.to_owned(),
            device_token: DEVICE_TOKEN.to_owned(),
            generation: "11111111-1111-4111-8111-111111111111".to_owned(),
            history_start: None,
            share_tools: true,
            share_cost: false,
            share_models: false,
        })
    );
    assert_eq!(f.sync.status().alias.as_deref(), Some("alice"));
    // The single-use credential is never requested twice.
    assert_eq!(code(f.connect.poll().await), "CONNECT_NOT_STARTED");
}

#[tokio::test]
async fn shares_one_in_flight_check_between_concurrent_callers() {
    let f = fixture();
    f.connect.start(URL).await.unwrap();
    let gate = Arc::new(Notify::new());
    f.set_poll({
        let gate = gate.clone();
        move || {
            let gate = gate.clone();
            after(async move { gate.notified().await }, approved())
        }
    });
    let connected = ConnectStatus::Connected {
        alias: "alice".to_owned(),
    };
    let (first, second, ()) = tokio::join!(f.connect.poll(), f.connect.poll(), async { gate.notify_one() });
    assert_eq!((first.unwrap(), second.unwrap()), (connected.clone(), connected));
    assert_eq!(f.poll_calls(), 1);
}

#[tokio::test]
async fn reports_expiry_and_failures_without_saving_anything() {
    let f = fixture();
    assert_eq!(code(f.connect.poll().await), "CONNECT_NOT_STARTED");
    f.connect.start(URL).await.unwrap();
    f.set_poll(|| respond(503, ""));
    assert_eq!(code(f.connect.poll().await), "CONNECT_FAILED");
    f.set_poll(|| respond_json(200, json!({"status": "approved", "publication": publication()})));
    assert_eq!(f.connect.poll().await.unwrap_err().status, 400);
    f.connect.start(URL).await.unwrap();
    f.set_poll(|| respond_json(410, json!({"error": {"code": "EXPIRED"}})));
    assert_eq!(f.connect.poll().await.unwrap(), ConnectStatus::Expired);
    assert_eq!(code(f.connect.poll().await), "CONNECT_NOT_STARTED");
    assert_eq!(f.secrets.get().await.unwrap(), None);
    f.client.once(|_| respond(429, ""));
    assert_eq!(code(f.connect.start(URL).await), "RATE_LIMITED");
    f.client.once(|_| offline());
    assert_eq!(code(f.connect.start(URL).await), "CONNECT_FAILED");
}

#[test]
fn derives_a_printable_device_label_from_the_host_name() {
    assert_eq!(default_device_name(Some("Studio-Mac.local")), "Studio-Mac");
    assert_eq!(default_device_name(Some("bad\u{7}host")), "badhost");
    assert_eq!(default_device_name(Some(&"x".repeat(120))).encode_utf16().count(), 80);
    assert_eq!(default_device_name(Some("\u{1}")), "My computer");
}

#[tokio::test]
async fn reports_counter_overflow_and_keeps_the_approval_for_a_retry() {
    let f = fixture();
    f.connect.start(URL).await.unwrap();
    f.set_poll(|| {
        respond_json(
            422,
            json!({"error": {"code": "COUNTER_OVERFLOW", "message": "untrusted hosted message"}}),
        )
    });
    let error = f.connect.poll().await.unwrap_err();
    assert_eq!((error.status, error.code), (422, "COUNTER_OVERFLOW"));
    assert!(error.message.contains("retry connecting"));
    assert!(!error.message.contains("untrusted"));
    assert_eq!(f.secrets.get().await.unwrap(), None);
    f.set_poll(approved);
    assert_eq!(
        f.connect.poll().await.unwrap(),
        ConnectStatus::Connected {
            alias: "alice".to_owned()
        }
    );
    assert_eq!(f.poll_calls(), 2);
    assert_eq!(f.secrets.get().await.unwrap().unwrap().device_token, DEVICE_TOKEN);
}

#[tokio::test]
async fn sends_only_the_name_where_the_computer_has_no_hardware_id() {
    let f = fixture_for(None);
    f.connect.start(URL).await.unwrap();
    assert_eq!(body(&f.client.calls()[0]), json!({"deviceName": "Studio Mac"}));
}

#[test]
fn identifies_the_computer_by_a_salted_hash_of_its_hardware_uuid() {
    let ioreg = r#"+-o Mac14,2  <class IOPlatformExpertDevice, id 0x100000254, registered, matched, active, busy 0 (25 ms), retain 34>
    {
      "IOPlatformSerialNumber" = "C02SYNTHETIC"
      "IOPlatformUUID" = "4C4C4544-0042-3810-8052-B4C04F4E4A32"
    }
"#;
    assert_eq!(platform_uuid(ioreg), Some("4C4C4544-0042-3810-8052-B4C04F4E4A32"));
    assert_eq!(platform_uuid("\"IOPlatformUUID\" = \"not-a-uuid\""), None);
    assert_eq!(platform_uuid(""), None);
    // The salt never changes: a different hash would make every computer look new to the hosted service.
    assert_eq!(
        hashed_machine_id("4C4C4544-0042-3810-8052-B4C04F4E4A32"),
        "55ad7bed4365a317a3e669932fec6dad879e7c8707257ca898b88e87e8f729dc"
    );
}

#[test]
fn identifies_a_linux_computer_by_its_machine_id() {
    assert_eq!(
        linux_machine_id("4c4c4544004238108052b4c04f4e4a32\n"),
        Some("4c4c4544004238108052b4c04f4e4a32")
    );
    // systemd writes `uninitialized` until the first boot completes.
    assert_eq!(linux_machine_id("uninitialized\n"), None);
    assert_eq!(linux_machine_id("4c4c4544004238108052b4c04f4e4a3\n"), None);
    assert_eq!(linux_machine_id("4c4c4544004238108052b4c04f4e4a3g\n"), None);
    assert_eq!(linux_machine_id(""), None);
}

#[test]
fn identifies_a_windows_computer_by_its_machine_guid() {
    assert_eq!(
        machine_guid("6f1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"),
        Some("6f1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b")
    );
    assert_eq!(machine_guid("6f1e2a3b4c5d4e6f8a9b0c1d2e3f4a5b"), None);
    assert_eq!(machine_guid("{6f1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b}"), None);
    assert_eq!(machine_guid(""), None);
}
