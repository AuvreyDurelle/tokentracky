//! Cloud sync (`CloudSync`): link changes, the hosted consent policy, and uploads of the frozen pending batch with its
//! receipts.
//!
//! Link changes (`set_link`, `unlink`, `stop`) run one at a time in call order behind a fair async mutex, each first
//! cancelling and awaiting the sync in flight. While any change is queued or running, `sync` answers 409
//! `LINK_CHANGING`. Concurrent `sync` calls share one upload. Work runs on spawned tasks, so a caller that goes away (a
//! closed HTTP connection) does not cut a change or an upload short.
use crate::error::LocalError;
use crate::http::{HttpClient, HttpRequest, HttpResponse};
use crate::link::{CloudLink, LinkInput, Scope, SecretStore, broader, cutoff, validate_cloud_link};
use axum::http::{Method, StatusCode, header};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use time::OffsetDateTime;
use tokentracky_collector::store::{StoreError, UsageStore};
use tokentracky_core::{PublicBucket, PublicHour, is_public_model, is_safe_count, iso_timestamp};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// Each request to the hosted service gives up after this long.
pub const HOSTED_TIMEOUT: Duration = Duration::from_secs(15);
/// Buckets per ingest request; an empty history still sends one, which authenticates the device.
pub const CHUNK: usize = 500;

const LINK_CHANGING: LocalError =
    LocalError::new(409, "LINK_CHANGING", "Device settings are being changed. Try again.");
const NOT_LINKED: LocalError = LocalError::new(409, "CLOUD_NOT_LINKED", "Link a publishing device before syncing.");
const RELINK: LocalError = LocalError::new(
    409,
    "RELINK_REQUIRED",
    "The device or publication changed. Review the hosted account and link again to approve expanded sharing.",
);
const POLICY_UNAVAILABLE: LocalError =
    LocalError::new(502, "SYNC_FAILED", "Hosted publication settings are unavailable.");
const SCOPE_NOT_PUBLISHED: LocalError = LocalError::new(
    400,
    "SCOPE_NOT_PUBLISHED",
    "Match the history and fields in your hosted privacy review. To change them, edit the hosted review first; this removes previously published values.",
);
const LOCAL_STATE_RESET: LocalError = LocalError::new(
    409,
    "LOCAL_STATE_RESET",
    "Local history was reset or restored. Save your hosted privacy review to clear previous totals, then relink this device.",
);
const ACCOUNTING_INCOMPLETE: LocalError = LocalError::new(
    409,
    "ACCOUNTING_HISTORY_INCOMPLETE",
    "Fork history is incomplete. Local totals are provisional; restore the missing history before syncing.",
);
const PUBLICATION_REVIEW: LocalError = LocalError::new(
    409,
    "PUBLICATION_REVIEW_REQUIRED",
    "Some history is now local-only. Save your hosted privacy review to clear previously published totals, then reconnect this device before syncing.",
);
fn publication_scope(link: &CloudLink) -> Result<String, Failure> {
    serde_json::to_string(&[&link.url, &link.device_token, &link.generation])
        .map(|scope| hex::encode(Sha256::digest(scope)))
        .map_err(|_| Failure::Other)
}
fn publication_generation(generation: &str) -> String {
    hex::encode(Sha256::digest(generation))
}
fn accounting_failure(error: StoreError) -> Failure {
    match error {
        StoreError::PublicationReviewRequired => Failure::Local(PUBLICATION_REVIEW),
        StoreError::AccountingHistoryIncomplete => Failure::Local(ACCOUNTING_INCOMPLETE),
        _ => Failure::Other,
    }
}
const INGEST_FAILED: LocalError = LocalError::new(
    502,
    "SYNC_FAILED",
    "Hosted sync failed. Local tracking continues; the backlog will retry.",
);
const SYNC_UNAVAILABLE: LocalError = LocalError::new(
    502,
    "SYNC_FAILED",
    "Hosted sync is unavailable. Local tracking continues; the backlog will retry.",
);

/// The sync fields of `GET /api/local/status`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub last_sync_at: Option<String>,
    pub sync_error: Option<&'static str>,
    pub alias: Option<String>,
}

/// The answer of `POST /api/local/sync`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    pub synced_at: String,
}

/// The shared outcome of a spawned operation, `None` until it settles.
pub(crate) type Outcome<T> = watch::Receiver<Option<Result<T, LocalError>>>;

/// Waits for a shared outcome; `fallback` if its task ended without one.
pub(crate) async fn outcome<T: Clone>(mut done: Outcome<T>, fallback: LocalError) -> Result<T, LocalError> {
    match done.wait_for(Option::is_some).await {
        Ok(value) => value.clone().unwrap_or(Err(fallback)),
        Err(_) => Err(fallback),
    }
}

/// A failure TypeScript does not raise as a `LocalError` (network, timeout, abort, unreadable or invalid answers,
/// store and credential errors); each caller decides what it becomes.
enum Failure {
    Local(LocalError),
    Other,
}

impl From<LocalError> for Failure {
    fn from(error: LocalError) -> Self {
        Self::Local(error)
    }
}

/// The hosted publication, as `/api/device-policy` reports it.
struct Policy {
    alias: String,
    generation: String,
    history_start: Option<String>,
    share_tools: bool,
    share_cost: bool,
    share_models: bool,
}

impl Policy {
    fn scope(&self) -> Scope<'_> {
        Scope {
            history_start: self.history_start.as_deref(),
            share_tools: self.share_tools,
            share_cost: self.share_cost,
            share_models: self.share_models,
        }
    }
}

#[derive(Clone)]
struct ActiveSync {
    cancel: CancellationToken,
    done: Outcome<Synced>,
}

#[derive(Default)]
struct State {
    /// Link changes queued or running.
    changes: usize,
    active: Option<ActiveSync>,
    status: SyncStatus,
    /// The usage epoch, scope and generation of the last acknowledged upload. In memory only, so the first sync after
    /// a launch always uploads.
    pushed: Option<(u64, String, String)>,
    /// The hosted service's `Retry-After` from the last sync's 429 or 503.
    retry_after: Option<Duration>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ingest<'a> {
    generation: &'a str,
    collector_id: &'a str,
    checkpoint: u64,
    receipt: &'a str,
    base_receipt: Option<&'a str>,
    buckets: &'a [PublicBucket],
    /// With the first chunk only: each upload replaces the computer's hours on the host.
    #[serde(skip_serializing_if = "Option::is_none")]
    hours: Option<&'a [PublicHour]>,
}

pub struct CloudSync {
    store: Arc<Mutex<UsageStore>>,
    secrets: Arc<dyn SecretStore>,
    client: Arc<dyn HttpClient>,
    /// Link changes take turns here, in call order (tokio's mutex is fair).
    control: tokio::sync::Mutex<()>,
    state: Mutex<State>,
}

/// Counts a link change from the call until its task ends, however it ends.
struct Changing(Arc<CloudSync>);

impl Drop for Changing {
    fn drop(&mut self) {
        self.0.state().changes -= 1;
    }
}

fn relinks(status: StatusCode) -> bool {
    [401, 403, 404, 409].contains(&status.as_u16())
}

pub(crate) fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

impl CloudSync {
    /// The store is locked for one store call at a time.
    pub fn new(store: Arc<Mutex<UsageStore>>, secrets: Arc<dyn SecretStore>, client: Arc<dyn HttpClient>) -> Arc<Self> {
        Arc::new(Self {
            store,
            secrets,
            client,
            control: tokio::sync::Mutex::new(()),
            state: Mutex::default(),
        })
    }

    pub fn secrets(&self) -> &Arc<dyn SecretStore> {
        &self.secrets
    }

    pub fn status(&self) -> SyncStatus {
        self.state().status.clone()
    }

    /// The hosted service's `Retry-After` from the last sync, when it answered 429 or 503 with one.
    pub fn retry_after(&self) -> Option<Duration> {
        self.state().retry_after
    }

    /// Keeps a 429 or 503's `Retry-After`, in whole seconds, for the refresh cycle's backoff.
    fn note_retry_after(&self, response: &HttpResponse) {
        if matches!(
            response.status,
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
        ) {
            let seconds = response
                .headers
                .get(header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok());
            self.state().retry_after = seconds.map(Duration::from_secs);
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn store(&self) -> MutexGuard<'_, UsageStore> {
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `action` after earlier changes, once the sync in flight has been cancelled and has settled.
    async fn mutate<T, F, Fut>(self: &Arc<Self>, action: F) -> Result<T, LocalError>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Self>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, LocalError>> + Send + 'static,
    {
        self.state().changes += 1;
        let changing = Changing(self.clone());
        let task = tokio::spawn(async move {
            let this = changing.0.clone();
            let _turn = this.control.lock().await;
            let active = this.state().active.clone();
            if let Some(active) = active {
                active.cancel.cancel();
                let _ = outcome(active.done, SYNC_UNAVAILABLE).await;
            }
            let result = action(this.clone()).await;
            drop(changing);
            result
        });
        task.await.unwrap_or(Err(LocalError::internal()))
    }

    /// Saves a link once the hosted publication has exactly its scope; the hosted review is changed first.
    pub async fn set_link(self: &Arc<Self>, input: LinkInput) -> Result<(), LocalError> {
        self.mutate(move |this| async move {
            // TypeScript answers 500 when the service cannot be reached or answers nonsense; 502 is the sensible
            // reading of the same failure (tests/contract/README.md, first quirk).
            let policy = this
                .policy(&input.url, &input.device_token, None)
                .await
                .map_err(|failure| match failure {
                    Failure::Local(error) => error,
                    Failure::Other => POLICY_UNAVAILABLE,
                })?;
            // Matching the published scope prevents old aggregate and per-tool buckets from coexisting.
            if input.history_start != policy.history_start
                || input.share_tools != policy.share_tools
                || input.share_cost != policy.share_cost
                || input.share_models != policy.share_models
            {
                return Err(SCOPE_NOT_PUBLISHED);
            }
            if let Some(saved) = this.secrets.get().await.map_err(|_| LocalError::internal())? {
                let scope = publication_scope(&saved).map_err(|_| LocalError::internal())?;
                this.store()
                    .bind_publication_generation(&scope, &publication_generation(&saved.generation))
                    .map_err(|_| LocalError::internal())?;
                if saved.url == input.url && saved.device_token == input.device_token {
                    this.store()
                        .observe_publication_generation_change(
                            &publication_generation(&saved.generation),
                            &publication_generation(&policy.generation),
                        )
                        .map_err(|_| LocalError::internal())?;
                }
            }
            let alias = policy.alias;
            this.secrets
                .set(input.with_generation(policy.generation))
                .await
                .map_err(|_| LocalError::internal())?;
            let mut state = this.state();
            state.status = SyncStatus {
                alias: Some(alias),
                ..SyncStatus::default()
            };
            state.pushed = None;
            Ok(())
        })
        .await
    }

    /// Forgets the link and the credential.
    pub async fn unlink(self: &Arc<Self>) -> Result<(), LocalError> {
        self.mutate(|this| async move {
            // A pre-upgrade receipt has an opaque scope but no generation binding yet. Preserve that binding before
            // forgetting the credential, so unlink/reconnect cannot accidentally reuse its blocked generation.
            if let Some(saved) = this.secrets.get().await.map_err(|_| LocalError::internal())? {
                let scope = publication_scope(&saved).map_err(|_| LocalError::internal())?;
                this.store()
                    .bind_publication_generation(&scope, &publication_generation(&saved.generation))
                    .map_err(|_| LocalError::internal())?;
            }
            this.secrets.clear().await.map_err(|_| LocalError::internal())?;
            let mut state = this.state();
            state.status = SyncStatus::default();
            state.pushed = None;
            Ok(())
        })
        .await
    }

    /// Drains link changes and cancels the sync in flight. Later syncs may start again.
    pub async fn stop(self: &Arc<Self>) {
        let _ = self.mutate(|_| async { Ok(()) }).await;
    }

    /// Uploads the pending batch, or joins the upload in flight.
    pub async fn sync(self: &Arc<Self>) -> Result<Synced, LocalError> {
        let done = {
            let mut state = self.state();
            if state.changes > 0 {
                return Err(LINK_CHANGING);
            }
            match &state.active {
                Some(active) => active.done.clone(),
                None => {
                    let cancel = CancellationToken::new();
                    let (sender, done) = watch::channel(None);
                    state.active = Some(ActiveSync {
                        cancel: cancel.clone(),
                        done: done.clone(),
                    });
                    let this = self.clone();
                    tokio::spawn(async move {
                        let result = this.perform_sync(&cancel).await;
                        this.state().active = None;
                        sender.send_replace(Some(result));
                    });
                    done
                }
            }
        };
        outcome(done, SYNC_UNAVAILABLE).await
    }

    async fn perform_sync(&self, cancel: &CancellationToken) -> Result<Synced, LocalError> {
        self.state().retry_after = None;
        let result = self.upload(cancel).await;
        let mut state = self.state();
        match result {
            Ok(()) => {
                let synced_at = iso_timestamp(OffsetDateTime::now_utc());
                state.status.last_sync_at = Some(synced_at.clone());
                state.status.sync_error = None;
                Ok(Synced { synced_at })
            }
            Err(Failure::Local(error)) => {
                // Nothing linked is not a sync failure, so it leaves no error in the status. TypeScript records
                // CLOUD_NOT_LINKED until a link or unlink (tests/contract/README.md, third quirk).
                state.status.sync_error = (error != NOT_LINKED).then_some(error.code);
                Err(error)
            }
            Err(Failure::Other) => {
                state.status.sync_error = Some(SYNC_UNAVAILABLE.code);
                Err(SYNC_UNAVAILABLE)
            }
        }
    }

    async fn upload(&self, cancel: &CancellationToken) -> Result<(), Failure> {
        let saved = self
            .secrets
            .get()
            .await
            .map_err(|_| Failure::Other)?
            .ok_or(NOT_LINKED)?;
        let mut input = serde_json::to_value(&saved).map_err(|_| Failure::Other)?;
        if let Some(fields) = input.as_object_mut() {
            fields.remove("generation");
        }
        let approved = validate_cloud_link(Some(&input))?.with_generation(saved.generation);
        self.store()
            .bind_publication_generation(
                &publication_scope(&approved)?,
                &publication_generation(&approved.generation),
            )
            .map_err(accounting_failure)?;
        let policy = self.policy(&approved.url, &approved.device_token, Some(cancel)).await?;
        self.state().status.alias = Some(policy.alias.clone());
        // A changed publication can narrow consent automatically, but expansion requires local review.
        if policy.generation != approved.generation && broader(policy.scope(), approved.scope()) {
            return Err(RELINK.into());
        }
        self.store()
            .observe_publication_generation_change(
                &publication_generation(&approved.generation),
                &publication_generation(&policy.generation),
            )
            .map_err(accounting_failure)?;
        let history_start = match (&approved.history_start, &policy.history_start) {
            (None, start) | (start, None) => start.clone(),
            (Some(mine), Some(theirs)) => Some(mine.max(theirs).clone()),
        };
        let link = CloudLink {
            history_start,
            share_tools: approved.share_tools && policy.share_tools,
            share_cost: approved.share_cost && policy.share_cost,
            share_models: approved.share_models && policy.share_models,
            generation: policy.generation,
            ..approved
        };
        if cancel.is_cancelled() {
            return Err(Failure::Other);
        }
        self.secrets.set(link.clone()).await.map_err(|_| Failure::Other)?;
        let target = publication_scope(&link)?;
        let generation = publication_generation(&link.generation);
        // Read before the batch is built: usage committed meanwhile is either in it or advances the epoch.
        let epoch = self.store().usage_epoch();
        let pushed = Some((epoch, target.clone(), generation.clone()));
        let frozen = self
            .store()
            .has_pending_publication(&target)
            .map_err(accounting_failure)?;
        // Nothing changed since the last acknowledged upload: the policy was still checked, but nothing is posted.
        if !frozen && self.state().pushed == pushed {
            return Ok(());
        }
        let batch = {
            // A scan must not block the generation between checking it and registering the new scope.
            // Once registered, exclusion growth holds this scope before another chunk or final ACK.
            let mut store = self.store();
            store
                .ensure_publication_generation_ready(&generation)
                .map_err(accounting_failure)?;
            let batch = store
                .pending_publication(&target, &link.publication_options())
                .map_err(accounting_failure)?;
            store
                .bind_publication_generation(&target, &generation)
                .map_err(accounting_failure)?;
            batch
        };
        let chunks: Vec<&[PublicBucket]> = if batch.buckets.is_empty() {
            vec![&[]]
        } else {
            batch.buckets.chunks(CHUNK).collect()
        };
        for (index, chunk) in chunks.into_iter().enumerate() {
            self.store()
                .ensure_publication_scope_ready(&target)
                .map_err(accounting_failure)?;
            if cancel.is_cancelled() {
                return Err(Failure::Other);
            }
            // `invalid_projection`. A tool outside TOOL_IDS cannot be represented, so only models need checking.
            let leaks = |bucket: &PublicBucket| {
                bucket
                    .model
                    .as_deref()
                    .is_some_and(|model| !link.share_models || !is_public_model(model))
            };
            if chunk.iter().any(leaks) {
                return Err(Failure::Other);
            }
            let body = serde_json::to_string(&Ingest {
                generation: &link.generation,
                collector_id: &batch.collector_id,
                checkpoint: batch.checkpoint,
                receipt: &batch.receipt,
                base_receipt: batch.base_receipt.as_deref(),
                buckets: chunk,
                hours: (index == 0).then_some(batch.hours.as_slice()),
            })
            .map_err(|_| Failure::Other)?;
            let request = HttpRequest::new(Method::POST, format!("{}/api/ingest", link.url), HOSTED_TIMEOUT)
                .header(header::AUTHORIZATION, bearer(&link.device_token))
                .json(body);
            let response = self.send(request, Some(cancel)).await;
            // A failed/unknown response may still mean the host applied the chunk. Preserve the frozen receipt.
            self.store()
                .ensure_publication_scope_ready(&target)
                .map_err(accounting_failure)?;
            let response = response?;
            self.note_retry_after(&response);
            if response.status == StatusCode::CONFLICT {
                let answer = serde_json::from_slice::<Value>(&response.body).ok();
                if answer.as_ref().and_then(|answer| answer.pointer("/error/code"))
                    == Some(&Value::from("LOCAL_STATE_RESET"))
                {
                    return Err(LOCAL_STATE_RESET.into());
                }
            }
            if !response.ok() {
                return Err(if relinks(response.status) {
                    RELINK
                } else {
                    INGEST_FAILED
                }
                .into());
            }
            // `invalid_sync_confirmation`: a safe count of accepted buckets, at most the chunk's.
            let confirmation = serde_json::from_slice::<Value>(&response.body).map_err(|_| Failure::Other)?;
            let accepted = confirmation.get("accepted").filter(|accepted| {
                is_safe_count(accepted) && accepted.as_f64().is_some_and(|count| count <= chunk.len() as f64)
            });
            if accepted.is_none() {
                return Err(Failure::Other);
            }
        }
        // A scan can discover incomplete history while the final HTTP request is in flight. Keep the receipt
        // frozen and report the hold until restoration, just as between chunks.
        let mut store = self.store();
        store
            .ensure_publication_scope_ready(&target)
            .map_err(accounting_failure)?;
        store
            .acknowledge_publication(&target, &batch.receipt)
            .map_err(accounting_failure)?;
        drop(store);
        // A frozen batch sent again predates `epoch`, so the next sync builds a fresh one.
        self.state().pushed = if frozen { None } else { pushed };
        Ok(())
    }

    /// The hosted publication for a device token. A malformed history start is 400 `INVALID_HISTORY`, as in TypeScript.
    async fn policy(&self, url: &str, token: &str, cancel: Option<&CancellationToken>) -> Result<Policy, Failure> {
        let request = HttpRequest::new(Method::GET, format!("{url}/api/device-policy"), HOSTED_TIMEOUT)
            .header(header::AUTHORIZATION, bearer(token));
        let response = self.send(request, cancel).await?;
        self.note_retry_after(&response);
        if !response.ok() {
            return Err(if relinks(response.status) {
                RELINK
            } else {
                POLICY_UNAVAILABLE
            }
            .into());
        }
        let data = serde_json::from_slice::<Value>(&response.body).map_err(|_| Failure::Other)?;
        let publication = data.get("publication");
        let field = |key| publication.and_then(|publication| publication.get(key));
        let generation = field("generation").and_then(Value::as_str).filter(|generation| {
            generation.len() == 36 && generation.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
        });
        let (Some(generation), Some(share_tools), Some(share_cost), Some(alias)) = (
            generation,
            field("shareTools").and_then(Value::as_bool),
            field("shareCost").and_then(Value::as_bool),
            field("alias").and_then(Value::as_str),
        ) else {
            return Err(Failure::Other);
        };
        Ok(Policy {
            alias: alias.to_owned(),
            generation: generation.to_owned(),
            // Servers from before model sharing omit the field: nothing is shared by model.
            share_models: field("shareModels") == Some(&Value::Bool(true)),
            history_start: cutoff(field("historyStart"))?,
            share_tools,
            share_cost,
        })
    }

    async fn send(&self, request: HttpRequest, cancel: Option<&CancellationToken>) -> Result<HttpResponse, Failure> {
        let sent = self.client.send(request);
        let response = match cancel {
            None => sent.await,
            Some(cancel) => tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Failure::Other),
                response = sent => response,
            },
        };
        response.map_err(|_| Failure::Other)
    }
}
