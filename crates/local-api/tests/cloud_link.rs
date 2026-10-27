//! Consent-aware publication transport: the device link, its scope and the upload.
mod support;

use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::*;
use tokentracky_core::{TokenCounts, ToolId, UsageEvent};
use tokentracky_local_api::{CloudSync, LinkInput, MemorySecretStore, SecretStore, SyncStatus, validate_cloud_link};
use tokio::sync::Notify;

const GENERATION: &str = "11111111-1111-4111-8111-111111111111";

fn input() -> LinkInput {
    LinkInput {
        url: "https://cloud.example".to_owned(),
        device_token: "synthetic-device-token-12345".to_owned(),
        history_start: None,
        share_tools: false,
        share_cost: false,
        share_models: false,
    }
}

fn input_json(change: Value) -> Value {
    let mut value = json!({"url": "https://cloud.example", "deviceToken": "synthetic-device-token-12345", "historyStart": null, "shareTools": false, "shareCost": false});
    value
        .as_object_mut()
        .unwrap()
        .extend(change.as_object().unwrap().clone());
    value
}

struct Fixture {
    sync: Arc<CloudSync>,
    secrets: Arc<MemorySecretStore>,
    client: Arc<ScriptedClient>,
    store: Arc<Mutex<tokentracky_local_api::UsageStore>>,
    policy: Arc<Mutex<Value>>,
    status: Arc<Mutex<u16>>,
}

impl Fixture {
    fn set_policy(&self, change: Value) {
        let mut policy = self.policy.lock().unwrap();
        policy
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
    }
    fn set_status(&self, status: u16) {
        *self.status.lock().unwrap() = status;
    }
    /// The buckets of the latest ingest.
    fn sent(&self) -> Value {
        let calls = self.client.calls();
        let ingest = calls
            .iter()
            .rev()
            .find(|call| call.url.ends_with("/api/ingest"))
            .unwrap();
        body(ingest)["buckets"].clone()
    }
}

fn fixture() -> Fixture {
    let store = memory_store();
    let secrets = Arc::new(MemorySecretStore::default());
    let policy = Arc::new(Mutex::new(
        json!({"alias": "alice", "generation": GENERATION, "historyStart": null, "shareTools": false, "shareCost": false}),
    ));
    let status = Arc::new(Mutex::new(200));
    let client = ScriptedClient::new({
        let (policy, status) = (policy.clone(), status.clone());
        move |request| {
            let body = if request.url.ends_with("/api/device-policy") {
                json!({"publication": *policy.lock().unwrap()})
            } else {
                json!({"accepted": 0})
            };
            respond_json(*status.lock().unwrap(), body)
        }
    });
    let sync = CloudSync::new(store.clone(), secrets.clone(), client.clone());
    Fixture {
        sync,
        secrets,
        client,
        store,
        policy,
        status,
    }
}

/// The hosted policy answers with alias `alice` and the first generation; ingests answer as `ingest` says.
fn policy_then(fixture: &Fixture, ingest: impl Fn(&tokentracky_local_api::HttpRequest) -> Fetch + Send + 'static) {
    fixture.client.script(move |request| {
        if request.url.ends_with("/api/device-policy") {
            respond_json(
                200,
                json!({"publication": {"alias": "alice", "generation": GENERATION, "historyStart": null, "shareTools": false, "shareCost": false}}),
            )
        } else {
            ingest(request)
        }
    });
}

#[test]
fn normalizes_a_calendar_date_and_rejects_malformed_or_extra_fields() {
    let valid = validate_cloud_link(Some(&input_json(json!({"historyStart": "2026-01-01"})))).unwrap();
    assert_eq!(valid.history_start.as_deref(), Some("2026-01-01T00:00:00.000Z"));
    for history_start in ["garbage", "2026-02-30", "2026-01-01T01:00:00Z", "9999-01-01"] {
        assert!(validate_cloud_link(Some(&input_json(json!({"historyStart": history_start})))).is_err());
    }
    assert!(validate_cloud_link(Some(&input_json(json!({"generation": GENERATION})))).is_err());
    assert!(validate_cloud_link(Some(&input_json(json!({"url": "https://cloud.example/redirect"})))).is_err());
}

#[tokio::test]
async fn fetches_consent_before_linking_and_authenticates_even_empty_history() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    f.sync.sync().await.unwrap();
    assert_eq!(f.secrets.get().await.unwrap().unwrap().generation, GENERATION);
    let url = &input().url;
    assert_eq!(
        f.client.urls(),
        [
            format!("{url}/api/device-policy"),
            format!("{url}/api/device-policy"),
            format!("{url}/api/ingest")
        ]
    );
    let ingest = body(&f.client.calls()[2]);
    assert!(ingest["collectorId"].is_string() && ingest["receipt"].is_string());
    assert_eq!(
        ingest,
        json!({"generation": GENERATION, "collectorId": ingest["collectorId"], "checkpoint": 0, "baseReceipt": null, "receipt": ingest["receipt"], "buckets": [], "hours": []})
    );
}

#[tokio::test]
async fn checks_the_device_policy_every_sync_but_uploads_only_when_usage_changed() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    let count = |path: &str| f.client.urls().iter().filter(|url| url.ends_with(path)).count();
    f.sync.sync().await.unwrap();
    assert_eq!((count("/api/device-policy"), count("/api/ingest")), (2, 1));
    // Nothing scanned since: the policy is read again, so a revoked device still applies, but nothing is posted.
    f.sync.sync().await.unwrap();
    assert_eq!((count("/api/device-policy"), count("/api/ingest")), (3, 1));
    commit(&f.store, "/authorized/a.jsonl", &[claude("s", "/synthetic", 1, 1)]);
    f.sync.sync().await.unwrap();
    assert_eq!((count("/api/device-policy"), count("/api/ingest")), (4, 2));
    // A new link starts afresh.
    f.sync.unlink().await.unwrap();
    f.sync.set_link(input()).await.unwrap();
    f.sync.sync().await.unwrap();
    assert_eq!(count("/api/ingest"), 3);
}

#[tokio::test]
async fn sends_the_last_days_hours_with_the_first_chunk_only() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    // A minute ago, then one a day from two days back: 501 day buckets, so two chunks, and one recent hour.
    let now = time::OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    let recent = now - time::Duration::minutes(1);
    let events: Vec<_> = (0..501)
        .map(|i| UsageEvent {
            event_id: format!("claude:day-{i}"),
            occurred_at: Some(
                if i == 0 {
                    recent
                } else {
                    now - time::Duration::days(i + 1)
                }
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
            ),
            ..claude("days", "/synthetic", 1, 1)
        })
        .collect();
    commit(&f.store, "/days.jsonl", &events);
    f.sync.sync().await.unwrap();
    let calls = f.client.calls();
    let ingests: Vec<Value> = calls
        .iter()
        .filter(|call| call.url.ends_with("/api/ingest"))
        .map(body)
        .collect();
    assert_eq!(ingests.len(), 2);
    let hour = format!(
        "{:04}-{:02}-{:02}T{:02}:00:00.000Z",
        recent.year(),
        recent.month() as u8,
        recent.day(),
        recent.hour()
    );
    // Without the tool split the hour is every tool's, as the day buckets are.
    assert_eq!(
        ingests[0]["hours"],
        json!([{"hour": hour, "tool": "all", "tokens": 132}])
    );
    assert!(ingests[1].get("hours").is_none(), "{}", ingests[1]);
}

#[tokio::test]
async fn never_uploads_usage_limits() {
    use tokentracky_collector::limits::{LimitReading, LimitWindow};
    let reading = |tool: ToolId, name: &str, used_percent: f64| LimitReading {
        tool,
        as_of_ms: 1_792_490_640_123,
        windows: vec![LimitWindow {
            name: name.to_owned(),
            used_percent,
            window_minutes: Some(299),
            resets_at_ms: Some(1_792_504_800_321),
        }],
    };
    let (plain, limited) = (fixture(), fixture());
    for f in [&plain, &limited] {
        commit(&f.store, "/authorized/a.jsonl", &[claude("s", "/synthetic", 1, 1)]);
    }
    {
        let mut store = limited.store.lock().unwrap();
        store.update_limits(&reading(ToolId::Codex, "primary", 37.25)).unwrap();
        store
            .replace_limits(ToolId::Claude, Some(&reading(ToolId::Claude, "five_hour", 41.75)))
            .unwrap();
    }
    for f in [&plain, &limited] {
        f.sync.set_link(input()).await.unwrap();
        f.sync.sync().await.unwrap();
    }
    // The same buckets with or without limits stored, and no limit figure or name in any ingest body.
    assert_eq!(limited.sent(), plain.sent());
    assert_eq!(plain.sent().as_array().unwrap().len(), 1);
    let calls = limited.client.calls();
    let ingests: Vec<&str> = calls
        .iter()
        .filter(|call| call.url.ends_with("/api/ingest"))
        .map(|call| call.body.as_deref().unwrap())
        .collect();
    assert_eq!(ingests.len(), 1);
    let body: Value = serde_json::from_str(ingests[0]).unwrap();
    let mut keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "baseReceipt",
            "buckets",
            "checkpoint",
            "collectorId",
            "generation",
            "hours",
            "receipt"
        ]
    );
    // Inspect usage separately: random receipt/collector UUIDs can legitimately contain the digits "299".
    let buckets = body["buckets"].to_string();
    for text in [
        "37.25",
        "41.75",
        "299",
        "1792504800321",
        "1792490640123",
        "primary",
        "five_hour",
        "usedPercent",
        "resets",
        "limit",
    ] {
        assert!(!buckets.contains(text), "{text}: {buckets}");
    }
}

#[tokio::test]
async fn keeps_the_hosted_services_retry_after_for_the_refresh_cycle() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    for (status, header, expected) in [
        (429, "900", Some(900)),
        (503, " 60 ", Some(60)),
        (429, "soon", None),
        (500, "900", None),
    ] {
        policy_then(&f, move |_| {
            Box::pin(async move {
                Ok(tokentracky_local_api::HttpResponse {
                    status: axum::http::StatusCode::from_u16(status).unwrap(),
                    headers: [(axum::http::header::RETRY_AFTER, header.parse().unwrap())]
                        .into_iter()
                        .collect(),
                    body: b"{}".to_vec(),
                })
            })
        });
        assert!(f.sync.sync().await.is_err());
        assert_eq!(
            f.sync.retry_after(),
            expected.map(std::time::Duration::from_secs),
            "{status} {header}"
        );
    }
    // A later sync clears it.
    policy_then(&f, |_| respond_json(200, json!({"accepted": 0})));
    f.sync.sync().await.unwrap();
    assert_eq!(f.sync.retry_after(), None);
}

#[tokio::test]
async fn never_uploads_when_publication_is_withdrawn_or_device_revoked() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    f.client.clear();
    f.set_status(401);
    assert_eq!(code(f.sync.sync().await), "RELINK_REQUIRED");
    assert_eq!(f.client.calls().len(), 1);
    assert_eq!(f.sync.status().last_sync_at, None);
}

#[tokio::test]
async fn reports_local_state_reset_without_claiming_a_successful_sync() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    policy_then(&f, |_| {
        respond_json(409, json!({"error": {"code": "LOCAL_STATE_RESET"}}))
    });
    assert_eq!(code(f.sync.sync().await), "LOCAL_STATE_RESET");
    assert_eq!(
        f.sync.status(),
        SyncStatus {
            last_sync_at: None,
            sync_error: Some("LOCAL_STATE_RESET"),
            alias: Some("alice".to_owned())
        }
    );
}

#[tokio::test]
async fn reuses_the_pending_receipt_after_an_unreadable_success_response() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    let broken = Arc::new(Mutex::new(true));
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    policy_then(&f, {
        let (broken, requests) = (broken.clone(), requests.clone());
        move |request| {
            requests.lock().unwrap().push(request.body.clone().unwrap());
            respond(
                200,
                if *broken.lock().unwrap() {
                    "{".to_owned()
                } else {
                    json!({"accepted": 0}).to_string()
                },
            )
        }
    });
    assert_eq!(code(f.sync.sync().await), "SYNC_FAILED");
    assert_eq!(f.sync.status().last_sync_at, None);
    *broken.lock().unwrap() = false;
    f.sync.sync().await.unwrap();
    let sent = requests.lock().unwrap().clone();
    assert_eq!(sent[1], sent[0]);
    // New usage: the next batch builds on the acknowledged receipt.
    commit(&f.store, "/authorized/a.jsonl", &[claude("s", "/synthetic", 1, 1)]);
    f.sync.sync().await.unwrap();
    let sent: Vec<Value> = requests
        .lock()
        .unwrap()
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .collect();
    assert_eq!(sent[2]["baseReceipt"], sent[1]["receipt"]);
    assert_ne!(sent[2]["receipt"], sent[1]["receipt"]);
}

#[tokio::test]
async fn uploads_the_model_mix_only_while_both_the_link_and_the_hosted_policy_approve_it() {
    let f = fixture();
    let event = UsageEvent {
        event_id: "e1".to_owned(),
        tool: ToolId::Claude,
        session_id: "private-session".to_owned(),
        project: Some("/private/project".to_owned()),
        model: "claude-sonnet-4-6".to_owned(),
        occurred_at: Some("2026-10-20T12:00:00.000Z".to_owned()),
        tokens: TokenCounts {
            input: 1,
            output: 2,
            cache_read: 0,
            cache_write: 0,
            reasoning: None,
            cache_write_1h: None,
        },
        service_tier: None,
        claude_mirror_id: None,
        cost_microusd: None,
        pricing_version: None,
    };
    commit(&f.store, "/authorized/a.jsonl", &[event]);
    // Token types are always uploaded, whatever else is shared.
    let kinds = json!({"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0});
    f.set_policy(json!({"shareModels": true}));
    assert_eq!(code(f.sync.set_link(input()).await), "SCOPE_NOT_PUBLISHED");
    f.sync
        .set_link(LinkInput {
            share_models: true,
            ..input()
        })
        .await
        .unwrap();
    f.sync.sync().await.unwrap();
    let sent = f.sent();
    assert!(sent[0]["revision"].is_u64());
    assert_eq!(
        sent,
        json!([{"day": "2026-10-20", "tool": "all", "model": "claude-sonnet-4-6", "tokens": 3, "costMicrousd": null, "revision": sent[0]["revision"], "breakdown": kinds}])
    );
    let wire = format!("{:?}", f.client.calls());
    assert!(!wire.contains("private-session") && !wire.contains("private/project"));
    // The hosted review turned model sharing off: narrow automatically.
    f.set_policy(json!({"shareModels": false, "generation": "22222222-2222-4222-8222-222222222222"}));
    f.sync.sync().await.unwrap();
    let sent = f.sent();
    assert_eq!(
        sent,
        json!([{"day": "2026-10-20", "tool": "all", "tokens": 3, "costMicrousd": null, "revision": sent[0]["revision"], "breakdown": kinds}])
    );
    assert!(!f.secrets.get().await.unwrap().unwrap().share_models);
    // Turning it back on in the hosted review needs a local re-link.
    f.set_policy(json!({"shareModels": true, "generation": "33333333-3333-4333-8333-333333333333"}));
    assert_eq!(code(f.sync.sync().await), "RELINK_REQUIRED");
}

#[tokio::test]
async fn narrows_changed_consent_but_requires_review_before_expansion() {
    let f = fixture();
    f.set_policy(json!({"shareTools": true}));
    f.sync
        .set_link(LinkInput {
            share_tools: true,
            ..input()
        })
        .await
        .unwrap();
    f.set_policy(json!({"shareTools": false, "generation": "22222222-2222-4222-8222-222222222222"}));
    f.sync.sync().await.unwrap();
    assert!(!f.secrets.get().await.unwrap().unwrap().share_tools);
    f.client.clear();
    f.set_policy(json!({"shareTools": true, "generation": "33333333-3333-4333-8333-333333333333"}));
    assert_eq!(code(f.sync.sync().await), "RELINK_REQUIRED");
    assert_eq!(f.client.calls().len(), 1);
}

#[tokio::test]
async fn requires_matching_hosted_scope_rejects_incompatible_relinks_and_clears_credentials_on_unlink() {
    let f = fixture();
    let start = |day: &str| LinkInput {
        history_start: Some(format!("{day}T00:00:00.000Z")),
        ..input()
    };
    f.set_policy(json!({"historyStart": "2026-01-01T00:00:00.000Z"}));
    assert_eq!(code(f.sync.set_link(input()).await), "SCOPE_NOT_PUBLISHED");
    f.sync.set_link(start("2026-01-01")).await.unwrap();
    assert_eq!(code(f.sync.set_link(start("2026-01-02")).await), "SCOPE_NOT_PUBLISHED");
    assert_eq!(
        f.secrets.get().await.unwrap().unwrap().history_start.as_deref(),
        Some("2026-01-01T00:00:00.000Z")
    );
    f.sync.unlink().await.unwrap();
    assert_eq!(f.secrets.get().await.unwrap(), None);
    assert_eq!(code(f.sync.sync().await), "CLOUD_NOT_LINKED");
}

#[tokio::test]
async fn aborts_pending_transport_before_erasing_a_device_link() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    let started = Arc::new(Notify::new());
    f.client.once({
        let started = started.clone();
        move |_| {
            started.notify_one();
            Box::pin(std::future::pending())
        }
    });
    let active = tokio::spawn({
        let sync = f.sync.clone();
        async move { sync.sync().await }
    });
    started.notified().await;
    f.sync.unlink().await.unwrap();
    assert_eq!(code(active.await.unwrap()), "SYNC_FAILED");
    assert_eq!(f.secrets.get().await.unwrap(), None);
    assert_eq!(f.client.calls().len(), 2);
}

#[tokio::test]
async fn incomplete_fork_history_never_reaches_ingest_and_restored_history_resumes() {
    use tokentracky_collector::store::SourceConfiguration;
    use tokentracky_collector::{IngestionOptions, IngestionService};
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("opencode.db")).unwrap();
    db.execute_batch(include_str!(
        "../../../fixtures/opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql"
    ))
    .unwrap();
    db.execute_batch("CREATE TEMP TABLE saved AS SELECT * FROM session_message WHERE session_id='ses_before'; DELETE FROM session_message WHERE session_id='ses_before';").unwrap();
    let service = IngestionService::new(f.store.clone(), IngestionOptions::default()).unwrap();
    service
        .configure_source(
            ToolId::OpenCode,
            &SourceConfiguration {
                enabled: true,
                paths: vec![root.path().to_str().unwrap().to_owned()],
            },
        )
        .unwrap();
    service.scan().unwrap();
    assert_eq!(code(f.sync.sync().await), "ACCOUNTING_HISTORY_INCOMPLETE");
    assert_eq!(f.sync.status().sync_error, Some("ACCOUNTING_HISTORY_INCOMPLETE"));
    assert!(!f.client.calls().iter().any(|call| call.url.ends_with("/api/ingest")));
    db.execute_batch("INSERT INTO session_message SELECT * FROM saved;")
        .unwrap();
    service.scan().unwrap();
    f.sync.sync().await.unwrap();
    assert_eq!(f.sync.status().sync_error, None);
    assert_eq!(
        f.sent()
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["tokens"].as_u64().unwrap())
            .sum::<u64>(),
        339
    );
}

#[tokio::test]
async fn lineage_discovered_during_upload_holds_between_chunks_and_before_acknowledging_the_final_chunk() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokentracky_collector::store::SourceConfiguration;
    use tokentracky_collector::{IngestionOptions, IngestionService};

    for bucket_count in [1, 501] {
        let f = fixture();
        f.sync.set_link(input()).await.unwrap();
        let events: Vec<_> = (0..bucket_count)
            .map(|i| UsageEvent {
                event_id: format!("claude:ordinary-{i}"),
                occurred_at: Some(
                    time::OffsetDateTime::from_unix_timestamp(1_790_000_000 + i * 86_400)
                        .unwrap()
                        .format(&time::format_description::well_known::Rfc3339)
                        .unwrap(),
                ),
                ..claude("ordinary", "/synthetic", 1, 1)
            })
            .collect();
        commit(&f.store, "/ordinary.jsonl", &events);
        let root = tempfile::tempdir().unwrap();
        let db = rusqlite::Connection::open(root.path().join("opencode.db")).unwrap();
        db.execute_batch(include_str!(
            "../../../fixtures/opencode/v2-assistant-and-compaction-rows/pinned-fork-lineage.sql"
        ))
        .unwrap();
        db.execute_batch("CREATE TEMP TABLE saved AS SELECT * FROM session_message WHERE session_id='ses_before'")
            .unwrap();
        let db = Arc::new(Mutex::new(db));
        let service = Arc::new(IngestionService::new(f.store.clone(), IngestionOptions::default()).unwrap());
        service
            .configure_source(
                ToolId::OpenCode,
                &SourceConfiguration {
                    enabled: true,
                    paths: vec![root.path().to_str().unwrap().to_owned()],
                },
            )
            .unwrap();
        policy_then(&f, {
            let (db, service) = (db.clone(), service.clone());
            let first = AtomicBool::new(true);
            move |_| {
                if first.swap(false, Ordering::SeqCst) {
                    db.lock()
                        .unwrap()
                        .execute("DELETE FROM session_message WHERE session_id='ses_before'", [])
                        .unwrap();
                    assert_eq!(service.scan().unwrap().diagnostics, ["fork_lineage_unavailable"]);
                }
                respond_json(200, json!({"accepted": 0}))
            }
        });
        assert_eq!(code(f.sync.sync().await), "ACCOUNTING_HISTORY_INCOMPLETE");
        assert_eq!(f.sync.status().last_sync_at, None);
        let ingests: Vec<_> = f
            .client
            .calls()
            .into_iter()
            .filter(|r| r.url.ends_with("/api/ingest"))
            .collect();
        assert_eq!(ingests.len(), 1);
        let first_body = body(&ingests[0]);
        db.lock()
            .unwrap()
            .execute_batch("INSERT INTO session_message SELECT * FROM saved")
            .unwrap();
        assert!(service.scan().unwrap().diagnostics.is_empty());
        f.client.clear();
        f.sync.sync().await.unwrap();
        let retried: Vec<_> = f
            .client
            .calls()
            .into_iter()
            .filter(|r| r.url.ends_with("/api/ingest"))
            .collect();
        assert_eq!(retried.len(), if bucket_count == 1 { 1 } else { 2 });
        assert_eq!(body(&retried[0]), first_body);
        assert!(retried.iter().all(|r| body(r)["receipt"] == first_body["receipt"]));
    }
}

/// Synthetic pre-policy ledger: the old parser counted Kilo rows without recording exclusions.
/// This does not claim a nonzero imported Roo producer exists.
fn legacy_kilo_source(f: &Fixture) -> (tempfile::TempDir, tokentracky_collector::IngestionService) {
    use tokentracky_collector::store::{FileCheckpoint, SourceConfiguration};
    use tokentracky_collector::{IngestionOptions, IngestionService};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("kilo.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../../../fixtures/kilo/v7-database/pinned-roo-import.sql"))
        .unwrap();
    db.execute(
        "INSERT INTO message VALUES('msg_native','ses_native',1792746001000,?)",
        [json!({
            "role":"assistant","modelID":"synthetic-model","time":{"created":1792746001000_i64},
            "tokens":{"input":75,"output":0,"cache":{"read":0,"write":0}}
        })
        .to_string()],
    )
    .unwrap();
    let events = tokentracky_collector::readers::read_opencode_database(ToolId::Kilo, &path, &[])
        .unwrap()
        .events;
    let checkpoint: FileCheckpoint = serde_json::from_value(json!({
        "path":path.to_str().unwrap(),"tool":"kilo","identity":"old","offset":0,"prefixHash":"0".repeat(64),"parserVersion":4,
        "state":{"sessionId":null,"project":null,"model":"unknown","turnId":null,"previous":null,"baselines":[],"seenDeltaIds":[]}
    })).unwrap();
    f.store
        .lock()
        .unwrap()
        .commit_file(&checkpoint, &events, false)
        .unwrap();
    let service = IngestionService::new(f.store.clone(), IngestionOptions::default()).unwrap();
    service
        .configure_source(
            ToolId::Kilo,
            &SourceConfiguration {
                enabled: true,
                paths: vec![path.to_str().unwrap().into()],
            },
        )
        .unwrap();
    (root, service)
}

#[tokio::test]
async fn exclusions_discovered_during_successful_or_unknown_upload_stop_chunks_and_final_ack_and_cannot_retry() {
    for bucket_count in [1, 501] {
        for unknown_response in [false, true] {
            let f = fixture();
            f.sync.set_link(input()).await.unwrap();
            let (_root, service) = legacy_kilo_source(&f);
            let service = Arc::new(service);
            let events: Vec<_> = (0..bucket_count)
                .map(|i| UsageEvent {
                    event_id: format!("claude:day-{i}"),
                    occurred_at: Some(
                        time::OffsetDateTime::from_unix_timestamp(1_792_746_001 + i * 86_400)
                            .unwrap()
                            .format(&time::format_description::well_known::Rfc3339)
                            .unwrap(),
                    ),
                    ..claude("synthetic", "/synthetic", 1, 1)
                })
                .collect();
            commit(&f.store, "/synthetic/ordinary.jsonl", &events);
            policy_then(&f, {
                let service = service.clone();
                move |_| {
                    service.scan().unwrap();
                    if unknown_response {
                        offline()
                    } else {
                        respond_json(200, json!({"accepted":0}))
                    }
                }
            });
            assert_eq!(code(f.sync.sync().await), "PUBLICATION_REVIEW_REQUIRED");
            assert_eq!(f.sync.status().sync_error, Some("PUBLICATION_REVIEW_REQUIRED"));
            assert_eq!(f.sync.status().last_sync_at, None);
            let calls = f.client.calls();
            let ingests: Vec<_> = calls.iter().filter(|r| r.url.ends_with("/api/ingest")).collect();
            assert_eq!(ingests.len(), 1, "no next chunk after provenance changed");
            let frozen = body(ingests[0]);
            assert_eq!(
                frozen["buckets"].as_array().unwrap().len(),
                bucket_count.min(500) as usize
            );
            f.client.clear();
            assert_eq!(code(f.sync.sync().await), "PUBLICATION_REVIEW_REQUIRED");
            assert!(!f.client.calls().iter().any(|r| r.url.ends_with("/api/ingest")));
            // Pausing a source cannot release the publication review hold.
            let source = service
                .status()
                .unwrap()
                .sources
                .into_iter()
                .find(|s| s.id == ToolId::Kilo)
                .unwrap();
            service
                .configure_source(
                    ToolId::Kilo,
                    &tokentracky_collector::store::SourceConfiguration {
                        enabled: false,
                        paths: source.paths,
                    },
                )
                .unwrap();
            assert_eq!(code(f.sync.sync().await), "PUBLICATION_REVIEW_REQUIRED");
        }
    }
}

#[tokio::test]
async fn new_hosted_generation_clears_old_totals_and_accepts_filtered_snapshot_after_acknowledged_or_unknown_receipts()
{
    use std::collections::HashMap;
    for unknown_response in [false, true] {
        let f = fixture();
        f.sync.set_link(input()).await.unwrap();
        let (_root, service) = legacy_kilo_source(&f);
        commit(
            &f.store,
            "/synthetic/ordinary.jsonl",
            &[claude("ordinary", "/synthetic", 1, 1)],
        );
        let hosted = Arc::new(Mutex::new(HashMap::<String, u64>::new()));
        let unknown = Arc::new(std::sync::atomic::AtomicBool::new(unknown_response));
        f.client.script({
            let (policy, hosted, unknown) = (f.policy.clone(), hosted.clone(), unknown.clone());
            move |request| {
                if request.url.ends_with("/api/device-policy") {
                    return respond_json(200, json!({"publication":*policy.lock().unwrap()}));
                }
                let value = body(request);
                assert_eq!(value["generation"], policy.lock().unwrap()["generation"]);
                let mut saved = hosted.lock().unwrap();
                for bucket in value["buckets"].as_array().unwrap() {
                    let key = json!([bucket["day"], bucket["tool"], bucket["model"]]).to_string();
                    saved.insert(key, bucket["tokens"].as_u64().unwrap());
                }
                // Even a lost response may have applied every bucket at the host.
                if unknown.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    offline()
                } else {
                    respond_json(200, json!({"accepted":value["buckets"].as_array().unwrap().len()}))
                }
            }
        });
        let initial = f.sync.sync().await;
        if unknown_response {
            assert_eq!(code(initial), "SYNC_FAILED");
        } else {
            initial.unwrap();
        }
        assert_eq!(hosted.lock().unwrap().values().sum::<u64>(), 207);
        let first = f
            .client
            .calls()
            .iter()
            .find(|r| r.url.ends_with("/api/ingest"))
            .map(body)
            .unwrap();
        service.scan().unwrap();
        f.client.clear();
        assert_eq!(code(f.sync.sync().await), "PUBLICATION_REVIEW_REQUIRED");
        // Reconnecting or rotating credentials without saving a new hosted generation cannot bypass the hold.
        let rotated = LinkInput {
            device_token: "synthetic-rotated-token-12345".into(),
            ..input()
        };
        f.sync.set_link(rotated).await.unwrap();
        assert_eq!(code(f.sync.sync().await), "PUBLICATION_REVIEW_REQUIRED");
        assert!(!f.client.calls().iter().any(|r| r.url.ends_with("/api/ingest")));
        // Hosted privacy-review contract: changing generation clears every prior bucket before new ingest.
        f.set_policy(json!({"generation":"22222222-2222-4222-8222-222222222222"}));
        hosted.lock().unwrap().clear();
        f.sync.set_link(input()).await.unwrap();
        f.sync.sync().await.unwrap();
        assert_eq!(hosted.lock().unwrap().values().sum::<u64>(), 132);
        assert_eq!(
            f.store.lock().unwrap().summary(&Default::default()).unwrap().tokens,
            207
        );
        let new = f
            .client
            .calls()
            .iter()
            .rev()
            .find(|r| r.url.ends_with("/api/ingest"))
            .map(body)
            .unwrap();
        assert!(new["baseReceipt"].is_null());
        assert_ne!(new["receipt"], first["receipt"]);
        assert_ne!(new["generation"], first["generation"]);
        assert_eq!(new["collectorId"], first["collectorId"]);
        assert_eq!(
            new["buckets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b["tokens"].as_u64().unwrap())
                .sum::<u64>(),
            132
        );
    }
}

#[tokio::test]
async fn first_link_after_exclusion_discovery_publishes_verified_history_directly() {
    let f = fixture();
    let (_root, service) = legacy_kilo_source(&f);
    service.scan().unwrap();
    commit(
        &f.store,
        "/synthetic/ordinary.jsonl",
        &[claude("ordinary", "/synthetic", 1, 1)],
    );
    f.sync.set_link(input()).await.unwrap();
    f.sync.sync().await.unwrap();
    assert_eq!(
        f.sent()
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["tokens"].as_u64().unwrap())
            .sum::<u64>(),
        132
    );
    assert_eq!(
        f.store.lock().unwrap().summary(&Default::default()).unwrap().tokens,
        207
    );
}

#[tokio::test]
async fn an_unbound_legacy_receipt_requires_an_observed_new_hosted_generation_even_after_its_link_was_forgotten() {
    let f = fixture();
    let (_root, service) = legacy_kilo_source(&f);
    let frozen = f
        .store
        .lock()
        .unwrap()
        .pending_publication("forgotten-legacy-scope", &Default::default())
        .unwrap();
    service.scan().unwrap();
    // No saved credential can identify the legacy scope's generation. A newly supplied token is not evidence
    // that its hosted generation was reset, even though its opaque target differs from the archived one.
    f.sync.set_link(input()).await.unwrap();
    assert_eq!(code(f.sync.sync().await), "PUBLICATION_REVIEW_REQUIRED");
    assert!(!f.client.calls().iter().any(|r| r.url.ends_with("/api/ingest")));
    f.set_policy(json!({"generation":"33333333-3333-4333-8333-333333333333"}));
    f.sync.set_link(input()).await.unwrap();
    f.sync.sync().await.unwrap();
    assert_eq!(
        f.sent()
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["tokens"].as_u64().unwrap())
            .sum::<u64>(),
        0
    );
    assert_eq!(
        f.store
            .lock()
            .unwrap()
            .acknowledge_publication("forgotten-legacy-scope", &frozen.receipt)
            .unwrap_err()
            .to_string(),
        "publication_review_required"
    );
}

#[tokio::test]
async fn exclusion_during_policy_fetch_holds_a_new_token_scope_until_hosted_generation_reset() {
    let f = fixture();
    f.sync.set_link(input()).await.unwrap();
    let (_root, service) = legacy_kilo_source(&f);
    commit(
        &f.store,
        "/synthetic/ordinary.jsonl",
        &[claude("ordinary", "/synthetic", 1, 1)],
    );
    f.sync.sync().await.unwrap();
    let previous = f
        .client
        .calls()
        .iter()
        .find(|r| r.url.ends_with("/api/ingest"))
        .map(body)
        .unwrap();
    f.sync
        .set_link(LinkInput {
            device_token: "synthetic-rotated-token-12345".into(),
            ..input()
        })
        .await
        .unwrap();
    f.client.script({
        let policy = f.policy.clone();
        move |request| {
            if request.url.ends_with("/api/device-policy") {
                service.scan().unwrap();
                respond_json(200, json!({"publication":*policy.lock().unwrap()}))
            } else {
                respond_json(200, json!({"accepted":0}))
            }
        }
    });
    f.client.clear();
    assert_eq!(code(f.sync.sync().await), "PUBLICATION_REVIEW_REQUIRED");
    assert!(!f.client.calls().iter().any(|r| r.url.ends_with("/api/ingest")));
    f.set_policy(json!({"generation":"44444444-4444-4444-8444-444444444444"}));
    f.sync.set_link(input()).await.unwrap();
    f.sync.sync().await.unwrap();
    let fresh = f
        .client
        .calls()
        .iter()
        .find(|r| r.url.ends_with("/api/ingest"))
        .map(body)
        .unwrap();
    assert_ne!(fresh["receipt"], previous["receipt"]);
    assert!(fresh["baseReceipt"].is_null());
    assert_eq!(
        fresh["buckets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["tokens"].as_u64().unwrap())
            .sum::<u64>(),
        132
    );
    assert_eq!(
        f.store.lock().unwrap().summary(&Default::default()).unwrap().tokens,
        207
    );
}
