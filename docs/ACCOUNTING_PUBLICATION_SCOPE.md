# Accounting publication scope

The policy is **exclude ambiguous histories with clear disclosure**, preserving publication of verified histories. This describes the Rust collector/local API and its disclosure in the Mac app's Settings. It does not establish exact identity for every historical producer.

## Eligible and local-only histories

Native Roo task documents and Kilo v5 task documents remain eligible under the existing verified readers. OpenCode/Kilo v2 databases with complete explicit lineage remain eligible unless they share a physical database with Kilo's recognized v1 schema. Other existing readers retain their accounting rules.

**Every event derived from a Kilo SQLite database containing `message(id,session_id,time_created,data)` is local-only.** Recognition depends on the schema, even if its v1 table is empty. This includes imported rows, fork snapshots, ordinary independent requests, new post-fork usage and v2 rows in that database. Distinct requests with identical counters remain distinct locally. No counter, timestamp or ID-pattern heuristic determines Kilo v1 publication eligibility.

The boundary is deliberately broad. Pinned Kilo forks generate fresh session/message IDs without a durable parent relationship. Their transient fork metadata does not survive in the persisted message/event formats; deletion can remove the aggregate event log. Both the first Roo importer and the current pinned importer write zero counters. A nonzero historical importer was not reproduced or verified.

Token types follow the same boundary: each public bucket carries the input, output, cache read, cache write and reasoning totals of exactly the events that make up its `tokens`, so excluded history contributes to neither. The one-hour cache-write part and the service tier stay local.

The local ledger, summaries, totals, CSV and JSON exports retain excluded history and its existing accounting behavior. Their totals can therefore exceed leaderboard totals. The source message in Settings explains this difference and identifies Roo and Kilo v5 tasks as eligible histories. Local-only status remains disclosed when the source is paused or removed.

## Achievements, likes and the GitHub username

Nothing new leaves the computer for these. Achievements are computed on the hosted service from the daily totals a member already publishes, and every member's badges and their rarity are public. The GitHub username is the verified login of the account's GitHub sign-in, read by the hosted service when the member publishes or approves a device, and shown on the public profile. A like stores the pair of accounts; only the count is public.

Session times and project identities stay local. Connected computers also send recent UTC hourly tool totals for the public last-24-hours figure; these contain no session or project identities.

## Durable provenance and upgrades

Parser version **4** invalidates earlier checkpoints. Any older OpenCode/Kilo `.db` checkpoint holds publication until revalidated, even when the source is disabled, missing, or a pending batch already exists. Missing or unreadable sources cannot establish eligibility. Local tracking and exports continue.

Recognition commits a durable `local_only_files` marker and `publication_exclusions` entries keyed by event identity in the same SQLite transaction as the checkpoint and ledger changes. It covers both new observations and **all already-counted rows for that file**, including rows no longer present upstream. If the old table itself disappeared, retained Kilo database records without observed v2 lineage cannot become eligible merely because the current schema no longer exposes v1.

Exclusions are monotonic. An event ID excluded in any physical source remains excluded if replayed from an eligible source. Source pause, row/file deletion, restart and checkpoint withdrawal cannot clear the exclusion. A previously classified path also stays local-only if its schema later changes. This may exclude additional legitimate usage; automatic guessing or reclassification is intentionally unavailable.

Public projection filters excluded events before creating buckets; it does not subtract or modify local ledger events. Excluded Kilo ancestry does not hold unrelated verified histories. An eligible v2 copy still needs its complete ancestry, including an excluded ancestor if needed to establish identity. The existing whole-device hold for incomplete eligible OpenCode ancestry remains: `ACCOUNTING_HISTORY_INCOMPLETE`, provisional local totals, frozen receipts and no further upload until restoration. Checkpoint diagnostics are evaluated against the lineage relevant to that physical file, so an unrelated excluded database cannot make a verified database appear incomplete.

## Existing hosted publications and receipts

Exclusion growth, including first classification of an empty v1 database, conservatively holds **every existing publication receipt scope**, even if a previous upload was never locally acknowledged. A failed response can still mean the host applied a partial or complete batch. The collector does not alter, discard or acknowledge that frozen content. Legacy single-scope receipt state migrates byte-for-byte into a per-scope archive; blocked old scopes remain archived when a new scope starts.

The local API reports HTTP 409 `PUBLICATION_REVIEW_REQUIRED`:

> Some history is now local-only. Save your hosted privacy review to clear previously published totals, then reconnect this device before syncing.

Saving the hosted review produces a **new publication generation**, deletes prior account buckets and resets hosted device receipt state. This contract is implemented by `packages/cloud/src/repository.ts` in `putPublication`. An account can have several computers: the review clears the buckets and receipt state of every one of them, so each connected computer re-uploads its own snapshot. A computer that was removed cannot re-upload, so its earlier totals are gone after a review. A new generation can receive a filtered snapshot with a new receipt and no base receipt. Simply reconnecting, narrowing the local projection or rotating credentials within the blocked generation does not clear the hold.

CloudSync scopes receipts using a SHA-256 digest of the hosted URL, device token and generation; those raw values are not stored in publication provenance. A separate generation digest binds existing scopes before replacing or clearing saved credentials. It prevents another token/host scope from reusing a known blocked generation. Previously used scopes remain registered, so switching away and back cannot resurrect them. If an archived legacy scope has already lost its credential/generation binding, the collector conservatively requires an observed hosted generation change on the same URL and credential. The first reconnect establishes the baseline; save the review again and reconnect if needed. A new token alone cannot establish that the unknown old generation was cleared.

The scope/accounting hold is checked when obtaining pending content, before **every** HTTP chunk, after every response or transport failure, and under the store lock before final ACK. An HTTP request already in flight cannot be recalled; its possible remote effect is why the new hosted generation must clear old buckets. No success or local ACK is reported when exclusion is discovered during the request.

Generation readiness, receipt freezing and generation binding share one store lock, so a scan cannot hold an old generation just before a new token scope registers. Every later scope guard also checks its bound generation, including scopes retained from earlier uploaders.

A new initial link with no prior publication receipt may publish the filtered snapshot directly. Later exclusion growth requires another hosted review for previously used scopes; this conservative implementation does not infer which daily bucket or receipt might have contained a newly excluded identity.

## Verification and residual limits

`accounting_reconciliation.rs` tests mixed Kilo v1/v2, separate complete v2, Roo and Kilo v5 histories with exact local/CSV/public totals. It covers fork copies, independent identical usage, pause/deletion/restart, physical replay, old v3 upgrades, retained rows and removed tables, migration of pending and acknowledged receipts, immutable archives, and transactional rollback using a failing SQLite trigger.

`cloud_link.rs` tests no-ingest retries, first-link filtered publication, discovery during one or multiple chunks, lost/successful responses and final-ACK protection. A hosted-contract stub applies old totals before losing the response, clears them on privacy-review generation reset, and accepts only the filtered new snapshot. This verifies the recovery protocol without claiming a live hosted correction upload.

The narrowed scope does not recover an original Kilo v1 request identity, prove an unknown historical nonzero Roo producer, recover source/event provenance already deleted by an earlier collector, or repair a corrupted local ledger. Data purged before revalidation may keep publication held until trusted history is restored. Existing OpenCode v1 approximation limits remain unchanged. Local-only totals are retained observations, not a claim that every imported or copied row represents a distinct real request. No personal logs, real accounts, deployment or production publication were used.
