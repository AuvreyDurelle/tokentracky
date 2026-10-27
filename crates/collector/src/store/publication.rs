//! Durable local-only provenance and publication receipt migration. Never exported as usage payloads.
use super::*;
use rusqlite::Transaction;

pub(super) fn migrate(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS publication_exclusions(event_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS local_only_files(path TEXT PRIMARY KEY, reason TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS publication_scopes(scope TEXT PRIMARY KEY, state TEXT NOT NULL, review_required INTEGER NOT NULL DEFAULT 0, generation TEXT);
         CREATE TABLE IF NOT EXISTS publication_generation_reviews(generation TEXT PRIMARY KEY);",
    )?;
    // The old single-scope receipt may have reached the host, even without a local ACK. Preserve it byte-for-byte.
    let legacy: Option<String> = tx
        .query_row("SELECT value FROM metadata WHERE key='publication_sync'", [], |r| {
            r.get(0)
        })
        .optional()?;
    if let Some(legacy) = legacy {
        let state: PublicationSyncState = serde_json::from_str(&legacy)?;
        tx.execute(
            "INSERT OR IGNORE INTO publication_scopes(scope,state) VALUES(?,?)",
            params![state.scope, legacy],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Mark both old ledger records (even absent from the source now) and every newly observed record atomically
/// with its checkpoint. Event identity, never counters or timestamps, propagates exclusions across physical copies.
pub(super) fn exclude<'a>(
    tx: &Transaction<'_>,
    file_key: &str,
    checkpoint: &FileCheckpoint,
    previous: impl Iterator<Item = &'a String>,
    events: impl Iterator<Item = &'a UsageEvent>,
) -> Result<()> {
    const REASON: &str = "kilo_history_local_only";
    let newly_local_only = if checkpoint.tool == ToolId::Kilo && checkpoint.diagnostics.iter().any(|d| d == REASON) {
        tx.execute(
            "INSERT OR IGNORE INTO local_only_files(path,reason) VALUES(?,?)",
            params![file_key, REASON],
        )?
    } else {
        0
    };
    let local_only: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_only_files WHERE path=?)",
        [file_key],
        |r| r.get(0),
    )?;
    if !local_only {
        return Ok(());
    }
    let mut added = 0;
    for id in previous.map(String::as_str).chain(events.map(|e| e.event_id.as_str())) {
        added += tx.execute(
            "INSERT OR IGNORE INTO publication_exclusions(event_id,reason) VALUES(?,?)",
            params![id, REASON],
        )?;
    }
    if added != 0 || newly_local_only != 0 {
        // Even an unacknowledged first chunk may already have been applied remotely. Never repair that receipt
        // in place or assume a retry failed remotely. A new hosted review must clear the generation first.
        tx.execute("UPDATE publication_scopes SET review_required=1", [])?;
        tx.execute("DELETE FROM publication_generation_reviews", [])?;
        next_revision(tx)?;
    }
    Ok(())
}

impl UsageStore {
    pub(super) fn save_publication_sync(&mut self, scope: &str, state: &str) -> Result<()> {
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO publication_scopes(scope,state) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET state=excluded.state", params![scope, state])?;
        // Compatibility mirror. The per-scope table retains frozen receipts when a new generation starts.
        tx.execute("INSERT INTO metadata(key,value) VALUES('publication_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [state])?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn has_publication_provenance(&self) -> Result<bool> {
        Ok(self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='publication_exclusions')",
            [],
            |r| r.get(0),
        )?)
    }

    pub(super) fn has_local_only_kilo(&self) -> Result<bool> {
        Ok(self.has_publication_provenance()?
            && self
                .db
                .query_row("SELECT EXISTS(SELECT 1 FROM local_only_files)", [], |r| r.get(0))?)
    }

    pub(crate) fn is_local_only_file(&self, path: &str, tool: ToolId) -> Result<bool> {
        Ok(self.has_publication_provenance()?
            && self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM local_only_files WHERE path=?)",
                [format!("{}:{path}", text(tool))],
                |r| r.get(0),
            )?)
    }

    pub(super) fn publication_exclusions(&self) -> Result<HashSet<String>> {
        if !self.has_publication_provenance()? {
            return Ok(HashSet::new());
        }
        Ok(self
            .db
            .prepare("SELECT event_id FROM publication_exclusions")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Whether a batch for `scope` was built but not acknowledged; it must be sent again before anything new.
    pub fn has_pending_publication(&self, scope: &str) -> Result<bool> {
        Ok(self.publication_sync_state(scope)?.pending.is_some())
    }
    /// Scope is an opaque digest of the hosted URL, credential and publication generation.
    /// Keep checks before each chunk, after every response and under the final ACK's store lock.
    pub fn ensure_publication_scope_ready(&self, scope: &str) -> Result<()> {
        self.ensure_publication_ready()?;
        let saved: Option<(bool, Option<String>)> = self
            .db
            .query_row(
                "SELECT review_required,generation FROM publication_scopes WHERE scope=?",
                [scope],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((blocked, generation)) = saved {
            if blocked {
                return Err(StoreError::PublicationReviewRequired);
            }
            // A scope registered after exclusion discovery can still belong to a blocked generation.
            // Recheck at every upload/ACK guard, including scopes created by an earlier uploader.
            if let Some(generation) = generation {
                self.ensure_publication_generation_ready(&generation)?;
            }
        }
        Ok(())
    }

    /// Bind a known scope to an opaque generation digest, so rotating a token or changing the host cannot
    /// make a previously blocked generation reusable. Call for the saved link before accepting a new policy.
    /// A link alone creates no publication state.
    pub fn bind_publication_generation(&mut self, scope: &str, generation: &str) -> Result<()> {
        self.db.execute(
            "UPDATE publication_scopes SET generation=? WHERE scope=? AND (generation IS NULL OR generation=?)",
            params![generation, scope, generation],
        )?;
        Ok(())
    }

    /// A generation transition reported by the same hosted URL and credential is evidence of a hosted review.
    /// Necessary when a legacy receipt survives but its old credential/generation binding was already forgotten.
    pub fn observe_publication_generation_change(&mut self, previous: &str, current: &str) -> Result<()> {
        if previous != current {
            self.db.execute(
                "INSERT OR IGNORE INTO publication_generation_reviews(generation) VALUES(?)",
                [current],
            )?;
        }
        Ok(())
    }

    pub fn ensure_publication_generation_ready(&self, generation: &str) -> Result<()> {
        let blocked: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM publication_scopes WHERE generation=?1 AND review_required=1)
             OR (EXISTS(SELECT 1 FROM publication_scopes WHERE generation IS NULL AND review_required=1)
                 AND NOT EXISTS(SELECT 1 FROM publication_generation_reviews WHERE generation=?1))",
            [generation],
            |r| r.get(0),
        )?;
        if blocked {
            return Err(StoreError::PublicationReviewRequired);
        }
        Ok(())
    }

    pub(super) fn complete_public_lineage(&self) -> Result<bool> {
        let excluded = self.publication_exclusions()?;
        let origins = self.usage_origins()?;
        // An excluded database's unresolved edges do not hold unrelated verified histories. Retain every ancestor
        // needed by an eligible event, so exclusion cannot hide missing ancestry or conflicting OpenCode identities.
        Ok(origins::complete_lineage(&origins::relevant_lineage(
            &origins,
            origins
                .iter()
                .filter(|o| !excluded.contains(&o.event_id))
                .map(|o| o.event_id.as_str()),
        )))
    }
}
