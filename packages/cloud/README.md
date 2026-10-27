# @tokentracky/cloud

Real PostgreSQL hosted API. No local endpoints, in-memory persistence, demo data, provider provisioning, public cache, or listener. The hosted server registers health and calls this package.

```ts
import {Pool} from 'pg';
import {migrateCloud, PostgresCloudRepository, registerCloudRoutes} from '@tokentracky/cloud';

const pool = new Pool({connectionString: process.env.DATABASE_URL});
await migrateCloud(pool);
const repository = new PostgresCloudRepository(pool);
await registerCloudRoutes(app, {
  repository,
  auth: {
    issuer: process.env.AUTH_ISSUER,
    audience: process.env.AUTH_AUDIENCE,
    jwksUrl: process.env.AUTH_JWKS_URL,
  },
});
```

Exports: `migrateCloud(pool, {schema?})`, `PostgresCloudRepository(pool, now?, schema?, log?, policy?)`, `registerCloudRoutes(app, options)`, `createAccountVerifier(config, testKeyResolver?)`, `CloudError`, and their public option/result types. `verifyAccount` is a trusted injection point `(token) => Promise<{issuer,subject}>`; it is not a development authentication fallback. Repository methods: `account`, `putPublication`, `createDevice`, `revokeDevice`, `ingest`, `leaderboard`, `profile`.

Default namespace is `tokentracky_cloud`. Migrate using a dedicated application database role that owns this schema/tables; use the same role for the server. Do not use a superuser or a public Data API role in production. Never add this namespace to an exposed Data API schema list. Tests supply unique schema names to both migration and repository. Migrations transactionally create the schema, revoke schema/table access from `PUBLIC` and existing `anon`/`authenticated` roles, and enable RLS on every table. There are no public RLS policies; the trusted owning server role performs narrow parameterized queries and builds allowlisted public DTOs. The migration is replay-safe and serialized per namespace. Tables are accounts, publications, devices, revisioned daily buckets, and the migration ledger.

All account/privacy/device operations and uploads serialize on a transaction-level account advisory lock. Ingestion rechecks device revocation inside that lock. Sharing is fixed: `PUT /api/publication` takes only `{alias}` and stores all history with tool, cost and model sharing on, and migration `0010_fixed_sharing.sql` widened older, narrower publications the same way. The narrower-scope checks below still guard uploads. Publication edits always rotate generation and conservatively delete all previous buckets, including when only alias changes. The collector must fetch/review the new publication generation and rebuild its approved snapshot after an edit. There is no withdrawal route: account deletion cascades all buckets, and no record remains in any public window. Revocation retains existing published aggregates but immediately invalidates that device. Replacing a revoked device clears old buckets so copied histories cannot add to existing totals. Up to ten active computers are supported. A reconnect with the same machine identifier replaces its old grants and buckets under the account lock; the final deduplicated account projection is validated before committing.

Tokens, token types and costs use PostgreSQL bigint with safe-JavaScript-integer bounds, plus aggregate overflow checks that roll back the entire upload. Revision replacements accept only a higher revision per original day/tool; stale and identical revisions are ignored. `accepted` counts changed buckets. A zero replacement removes that bucket's contribution. Buckets are limited to 10,000 per upload with a 2 MiB HTTP body limit. When tool sharing is off, only `all` is accepted; when cost sharing is off, costs must be null. Approved tool sharing also permits `all`, but a given day cannot combine an all-tool bucket with per-tool buckets (that would risk double counting). Changing representation requires a fresh publication generation. Unknown days are allowed only without a history cutoff and never enter calendar windows. Pre-cutoff/future days, invalid UTC calendar dates, duplicate bucket keys, unsafe counters, and all unknown input fields are rejected. Each bucket may carry its tokens by type (`breakdown`, migration 0008: nullable `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` and `reasoning_tokens`, all set or all null, the first four adding up to `tokens`, reasoning at most output); buckets without types from older apps stay valid. Types are always published, with no sharing flag. Profiles show an all-time split only when every bucket carries types; community totals by type sum the buckets that do.

Aliases are 3–30 ASCII letters/digits/underscores/hyphens, begin with a letter/digit, are normalized lowercase, and are uniquely owned while published. Ranking sorts exact tokens descending, then lowercase aliases in ASCII ascending order. Search and pagination run after cohort ranking. Tool filters include only publications with approved tool sharing. `totalTokens` is the complete selected period/tool cohort total before search/pagination; `total` counts matching aliases. Public ranking/profile reads use original UTC days and eligible active publications in one read-only repeatable-read snapshot. Cost remains null when any contributing bucket is unknown. Optional public fields are absent unless approved. No account, device, project, session, contact or authentication identity is included in public results. Private responses and errors specify `Cache-Control: no-store`; successful community and SVG responses may be cached for 60 seconds, and rarity for an hour. Community and rarity also share an internal minute snapshot.

Managed identity requires issuer, audience and HTTPS JWKS URL. Missing config returns explicit `AUTH_NOT_CONFIGURED`/503. JOSE verifies asymmetric signatures, issuer, audience, expiry and required subject/issued-at claims. Anonymous and service-role tokens are rejected; user metadata is never used for authorization. Account identity is keyed by a hash of verified issuer + subject. Device tokens use 256 random bits, are returned only on creation, and are stored only as SHA-256 hashes. The server must redact Authorization headers and request bodies in operational logs.

Operational limits: JWT verification is stateless until token expiry and does not immediately detect provider signout/account deletion; use short token lifetimes or an injected provider-freshness verifier if required. This package does not provision identity, database credentials, TLS, edge rate limits, moderation policy/operations or retention/backups; those are deployment/integration responsibilities. Client-reported usage is not independently verified. Identical copied buckets across a member's computers count once; this is a consistency heuristic, not proof of independent use.

Shared public totals use exact integer arithmetic. Above JavaScript's safe integer range, existing numeric aggregate fields remain safe lower bounds and optional `exactAggregates` decimal strings carry the exact values. Profiles and embeds do not calculate shared community sums. Per-account unsafe totals still roll back an upload; restored invalid accounts are excluded from public cohorts until corrected, with an explicit unavailable response for their own profiles. Exact tool maps, trends and token-kind families are complete when present. Older installed clients remain operational but can show capped headline totals. Migration 0015 uses invoker-security views and requires PostgreSQL 15 or newer; CI uses PostgreSQL 17. Run the read-only `counter-audit` operator command for count-only integrity diagnostics; record rollout and rollback procedures in your private operations runbook.

Tests use only an isolated PostgreSQL database on loopback, named `tokentracky_test` with user `tokentracky`, selected explicitly with `TEST_DATABASE_URL`. No environment files are read. The test suite creates and drops its own schema. The access-isolation test creates its own NOLOGIN/NOBYPASSRLS role and removes it by transaction rollback. Without `TEST_DATABASE_URL`, PostgreSQL cases are explicitly skipped; JWT crypto tests still run. Run from the repository root:

```sh
TEST_DATABASE_URL=postgres://tokentracky:test-only-password@127.0.0.1:5432/tokentracky_test npm test --workspace=@tokentracky/cloud
npm run typecheck
npx --no-install eslint packages/cloud
```

## Local resets and sync receipts

Ingestion also requires `collectorId` (the local database UUID), `checkpoint`, `receipt` and nullable `baseReceipt`. The device stores its latest accepted receipt/checkpoint. A new snapshot must descend from that receipt; chunk retries must repeat the same receipt, collector ID and checkpoint. UUID changes, backward counters or stale receipt ancestry return `LOCAL_STATE_RESET` without changing totals. Equal bucket revisions can still be idempotent retries; lower bucket revisions never overwrite newer values.

The collector persists a frozen pending aggregate snapshot before sending it and advances its local acknowledgment only after all chunks succeed. This covers restart, lost response and a restored backup whose numeric counter has caught up. Migration 2 adds lineage fields; legacy devices with existing totals must save their hosted privacy review to clear old buckets before first sync with this protocol. Device replacement starts a new lineage. Changing hosted review resets buckets and lineage under the same account lock, so queued old-generation uploads remain invalid.

Recovery: save the hosted privacy review, then relink the local device. The protocol reports an explicit error rather than treating discarded snapshots as successful sync. It still trusts client-reported aggregate content; receipts are consistency checks, not proof of spending. Upload checks compare each day with other members' (`src/moderation.ts`) and hide outliers until an operator reviews them (`scripts/moderation.ts`); they make cheating harder, not impossible.

## Moderation policy

The repository and operator CLI read `TOKENTRACKY_MODERATION_POLICY` from the server environment at construction, or accept an explicitly injected policy as the fifth repository argument. Hosted app callers can provide `moderationPolicy`. There are no bundled production defaults: missing or malformed configuration fails startup, with value-free errors. Inject the JSON through your deployment secret/configuration manager; never put policy values in public environment files, health responses, browser bundles or logs.

The JSON must contain exactly the numeric fields in `ModerationPolicy` (`src/moderation.ts`):

| Fields | Meaning |
| --- | --- |
| `hideFloor`, `hideRatio`, `hideCohort` | Day size, peer multiple and minimum peer cohort for hiding |
| `volumeFloor`, `jumpRatio`, `jumpFloor`, `baselineDays` | Large-day and recent-baseline review criteria |
| `templateTokens`, `templateCount` | Minimum repeated bucket size and repetition count |
| `leadRatio`, `leadFloor`, `leadStep` | All-time lead review and query increment |
| `breakerHides`, `breakerWindowMs` | Recent automatic hides that suppress further hiding |
| `reflagGrowth`, `reviewWithinMs` | Growth required after clearance and review deadline |

Ratios must be finite and greater than one. Other fields must be positive safe integers; `baselineDays` is at most 366, and `leadStep` cannot exceed `leadFloor`. Millisecond durations use the server clock. Test policy values are deliberately synthetic and are not deployment recommendations.

Before upgrading, privately preserve the deployment's reviewed policy and provision it for both the hosted server and operator environment. Validate configuration in staging before shifting traffic; do not silently fall back to disabled checks. Existing flags, bans, account locks and human review semantics are unchanged. Operator `queue`, `audit`, `clear`, `hide`, `ban` and `unban` remain CLI-only; writes require the named member to be typed again. `audit` uses the configured review deadline, and structured events contain reasons/counts rather than member identities.
