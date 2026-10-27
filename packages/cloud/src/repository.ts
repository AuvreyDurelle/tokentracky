import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { activityStats, BADGE_IDS, BADGE_TIERS, checkedSum, rankingWindow, type AchievementRarity, type BadgeId, type CommunityStats, type LeaderboardResponse, type Period, type ProfileStats, type Publication, type PublicBucket, type PublicProfile, type TokenCounts, type ToolId } from '@tokentracky/core';
import type { AccountIdentity } from './auth.ts';
import { CloudError, invalid, safe } from './errors.ts';
import { ingestionInput, object, publicationInput } from './validation.ts';
import { cloudSchema } from './schema.ts';
import { createModerationRules, parseModerationPolicy, type ModerationPolicy, type DaySignals, type Finding, type FlagStatus, type ModerationEvent, type Reason, type StoredFlag } from './moderation.ts';
import { rarity, storeBadges, topBadges } from './badge-store.ts';
import {publicAggregates, sumWide, wide, type WideKinds} from './public-aggregates.ts';

interface PublicationRow {account_id: string; alias: string; history_start: Date | null; share_tools: boolean; share_cost: boolean; share_models: boolean; generation: string}
interface DeviceRow {id: string; account_id: string; name: string; last_seen_at: Date | null}
/** Shown only to the member. Absent when the account is neither hidden nor banned. */
export type AccountModeration = {state: 'banned'} | {state: 'hidden'; days: string[]};
export interface AccountResponse {publication: Publication | null; devices: Array<{id: string; name: string; lastSeenAt: string | null}>; moderation?: AccountModeration; integrity?: {state: 'unavailable'; reason: 'COUNTER_OVERFLOW'}}
/**
 * `sort: 'cost'` reorders by estimated cost (unknown last); ranks always follow tokens. `around` replaces the page with
 * that alias and the builders ranked just above and below it.
 */
export interface LeaderboardQuery {period: Period; tool: ToolId | 'all'; q: string; page: number; pageSize: number; sort?: 'tokens' | 'cost'; around?: string}
export interface DeviceAuthorizationStart {pollToken: string; userCode: string; expiresAt: string; interval: number}
export interface DeviceAuthorizationRequest {userCode: string; deviceName: string; expiresAt: string; approved: boolean; replaces: string | null}
/** An open flag for review, with its figures when flagged and recomputed now against members who are visible today. */
export interface QueueItem {accountId: string; alias: string | null; day: string; status: 'review' | 'hidden'; reasons: Reason[]; detectedAt: string;
  tokens: number; rival: number; cohort: number; tokensNow: number; rivalNow: number; cohortNow: number}
export interface ModerationSummary {accountId: string; alias: string | null; tokens: number; days: number; devices: number; banned: boolean;
  flags: Array<{day: string; status: FlagStatus; reasons: Reason[]; reviewed: boolean}>}
/** Counts only: safe to print anywhere. */
export interface ModerationAudit {staleHidden: number; openReviews: number; bans: number; bansWithoutFlag: number}
export interface CounterAudit {invalidAccounts: number; overflowFamilies: number}
export type DeviceAuthorizationPoll = {status: 'pending'} | {status: 'approved'; deviceToken: string; publication: Publication};
/** Who is liking: a signed-in account, or a computer's credential (the Mac app has no browser session). */
export type Liker = {identity: AccountIdentity} | {deviceToken: string};
// Unambiguous consonants: no vowels (no accidental words), no 0/O or 1/I confusion.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const AUTHORIZATION_TTL_MS = 10 * 60_000;
const MAX_COMPUTERS = 10;
const TREND_DAYS = 30;
const DAILY_DAYS = 14;
const PROFILE_DAYS = 365;
const HOUR_MS = 3_600_000;
/** The leaderboard's 24-hour column: the 24 whole UTC hours before the hour under way, `[since, until)`. */
const lastDay = (now: Date) => {
  const until = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return {since: new Date(until - 24 * HOUR_MS), until: new Date(until)};
};
/** The last `count` UTC day keys ending today, oldest first. */
const recentDays = (now: Date, count: number) => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({length: count}, (_, index) => new Date(today - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));
};
const codeNotFound = () => new CloudError(404, 'NOT_FOUND', 'This connection code is invalid or has expired. Start again from the app.');
const deviceNotFound = () => new CloudError(404, 'NOT_FOUND', 'Device not found');
const deviceLimit = () => new CloudError(409, 'DEVICE_LIMIT', `Remove a computer first. An account can connect up to ${MAX_COMPUTERS} computers.`);
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileNotFound = () => new CloudError(404, 'NOT_FOUND', 'Published profile not found');
/** For bucket queries inside an account transaction: hidden and banned accounts are not anyone's peers. */
const VISIBLE_BUCKET = 'NOT EXISTS (SELECT 1 FROM cloud_public_exclusions h WHERE h.account_id = b.account_id)';
/**
 * Totals per account and day (or per `group`) for the moderation checks: the one place that decides what a member's usage adds up to.
 * F4 (several computers) changes this to count a bucket reported identically by two of a member's computers once.
 */
const bucketTotals = (where: string, group = 'b.account_id, b.day_key') => `SELECT ${group}, sum(b.tokens) AS tokens FROM cloud_account_buckets b WHERE ${where} GROUP BY ${group}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const accountKey = (identity: AccountIdentity) => {
  if (!identity.issuer || !identity.subject || identity.issuer.length > 2048 || identity.subject.length > 512) throw new CloudError(401, 'UNAUTHORIZED', 'Invalid account identity');
  return hash(JSON.stringify([identity.issuer, identity.subject]));
};
const deviceName = (name: unknown): string => {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80 || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid('Device name must contain 1–80 printable characters');
  return name.trim();
};
/** Optional: SHA-256 of the computer's hardware id and a fixed salt, as lowercase hex. Older apps send none. */
const machineId = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid('Invalid machine id');
  return value;
};
/** Accept the code as typed (any case, with or without the dash); store one canonical form. */
export function normalizeUserCode(value: unknown): string {
  const compact = typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : '';
  if (!new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`).test(compact)) throw codeNotFound();
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
const publication = (p: PublicationRow): Publication => ({alias: p.alias, historyStart: p.history_start?.toISOString() ?? null, shareTools: p.share_tools, shareCost: p.share_cost, shareModels: p.share_models, generation: p.generation});
/** Bucket counts and token-kind sums over buckets `b`; `typed` counts the buckets that carry kinds (older apps upload none). */
const KIND_SUMS = `count(*) AS buckets, count(b.input_tokens) AS typed, sum(b.input_tokens) AS input, sum(b.output_tokens) AS output,
  sum(b.cache_read_tokens) AS cache_read, sum(b.cache_write_tokens) AS cache_write, sum(b.reasoning_tokens) AS reasoning`;
interface KindSums {buckets: string; typed: string; input: string | null; output: string | null; cache_read: string | null; cache_write: string | null; reasoning: string | null}
const kindSums = (row: KindSums): TokenCounts => ({input: safe(row.input ?? 0), output: safe(row.output ?? 0), cacheRead: safe(row.cache_read ?? 0), cacheWrite: safe(row.cache_write ?? 0), reasoning: safe(row.reasoning ?? 0)});

export class PostgresCloudRepository {
  private readonly schema: string;
  private readonly rules: ReturnType<typeof createModerationRules>;
  /** For queries over publications `p`: hidden and banned accounts are absent from every public read. */
  private get visible(): string { return `NOT EXISTS (SELECT 1 FROM ${this.schema}.cloud_public_exclusions h WHERE h.account_id = p.account_id)`; }
  /** Account buckets with identical copied usage counted once. */
  private get buckets(): string { return `${this.schema}.cloud_account_buckets`; }
  /** `log` receives count/reason events only; policy defaults to the required private server environment. */
  constructor(readonly pool: Pool, private readonly now: () => Date = () => new Date(), schema = 'tokentracky_cloud', private readonly log: (event: ModerationEvent) => void = () => {}, policy: ModerationPolicy = parseModerationPolicy(process.env.TOKENTRACKY_MODERATION_POLICY)) {
    this.schema = cloudSchema(schema);
    this.rules = createModerationRules(policy);
  }

  private async transaction<T>(accountId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${this.schema}, pg_catalog`);
      // All privacy/device operations use the same lock, even when publication is absent.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [accountId]);
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new CloudError(409, 'CONFLICT', 'Alias is already in use');
      throw error;
    } finally { client.release(); }
  }

  async account(identity: AccountIdentity): Promise<AccountResponse> {
    const id = accountKey(identity);
    return this.transaction(id, async client => {
      await client.query('INSERT INTO cloud_accounts(id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      const p = await client.query<PublicationRow>('SELECT * FROM cloud_publications WHERE account_id = $1', [id]);
      const devices = await client.query<DeviceRow>('SELECT id, name, last_seen_at FROM cloud_devices WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at, id', [id]);
      const moderation = await this.moderation(client, id);
      const invalid = await client.query('SELECT 1 FROM cloud_invalid_counter_accounts WHERE account_id = $1', [id]);
      return {publication: p.rows[0] ? publication(p.rows[0]) : null, devices: devices.rows.map(d => ({id: d.id, name: d.name, lastSeenAt: d.last_seen_at?.toISOString() ?? null})), ...(moderation ? {moderation} : {}), ...(invalid.rowCount ? {integrity: {state: 'unavailable', reason: 'COUNTER_OVERFLOW'} as const} : {})};
    });
  }

  /** `githubLogin` is the verified login to store (null clears it); undefined keeps the stored one. */
  async putPublication(identity: AccountIdentity, input: unknown, githubLogin?: string | null): Promise<Publication> {
    const v = publicationInput(input);
    const id = accountKey(identity);
    return this.transaction(id, async client => {
      await client.query('INSERT INTO cloud_accounts(id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      await this.refuseBanned(client, id);
      if (githubLogin !== undefined) await client.query('UPDATE cloud_accounts SET github_login = $2 WHERE id = $1', [id, githubLogin]);
      // Sharing is fixed: all history, with the tool split, model mix and cost.
      const result = await client.query<PublicationRow>(`
        INSERT INTO cloud_publications(account_id, alias, history_start, share_tools, share_cost, share_models, generation)
        VALUES ($1,$2,NULL,true,true,true,$3)
        ON CONFLICT(account_id) DO UPDATE SET alias = EXCLUDED.alias, history_start = EXCLUDED.history_start,
          share_tools = EXCLUDED.share_tools, share_cost = EXCLUDED.share_cost, share_models = EXCLUDED.share_models, generation = EXCLUDED.generation, updated_at = now()
        RETURNING *`, [id, v.alias, randomUUID()]);
      // Every save starts a new generation with no old buckets, which also clears a held collector (docs/ACCOUNTING_PUBLICATION_SCOPE.md).
      await client.query('DELETE FROM cloud_buckets WHERE account_id = $1', [id]);
      await client.query('DELETE FROM cloud_hours WHERE account_id = $1', [id]);
      await client.query('UPDATE cloud_devices SET collector_id = NULL, receipt = NULL, checkpoint = 0 WHERE account_id = $1', [id]);
      await storeBadges(client, this.schema, id, this.now().toISOString().slice(0, 10));
      return publication(result.rows[0]!);
    });
  }

  async deleteAccount(identity: AccountIdentity): Promise<void> {
    const id = accountKey(identity);
    await this.transaction(id, async client => {
      // FK cascades erase publication, buckets and all device grants, including revoked ones.
      await client.query('DELETE FROM cloud_accounts WHERE id = $1', [id]);
    });
  }

  async createDevice(identity: AccountIdentity, name: string): Promise<{id: string; token: string}> {
    const validName = deviceName(name);
    const accountId = accountKey(identity);
    return this.transaction(accountId, async client => {
      await client.query('INSERT INTO cloud_accounts(id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
      await this.refuseBanned(client, accountId);
      await this.refuseFull(client, accountId, null);
      return this.mintDevice(client, accountId, validName, null);
    });
  }

  /** Callers hold the account lock and have checked the cap. A new computer adds to the account's totals. */
  private async mintDevice(client: PoolClient, accountId: string, name: string, machine: string | null): Promise<{id: string; token: string}> {
    const id = randomUUID();
    const token = `ttd_${randomBytes(32).toString('base64url')}`;
    await client.query('INSERT INTO cloud_devices(id, account_id, name, token_hash, machine_id) VALUES ($1,$2,$3,$4,$5)', [id, accountId, name, hash(token), machine]);
    return {id, token};
  }

  /** Callers hold the account lock. A computer that replaces one of the account's own does not need a free slot. */
  private async refuseFull(client: PoolClient, accountId: string, machine: string | null): Promise<void> {
    const active = await client.query<{count: string}>('SELECT count(*) AS count FROM cloud_devices WHERE account_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR machine_id IS DISTINCT FROM $2)', [accountId, machine]);
    if (Number(active.rows[0]!.count) >= MAX_COMPUTERS) throw deviceLimit();
  }

  /** Unauthenticated: a collector asks to be connected. Only the poll secret can later collect a credential. */
  async startDeviceAuthorization(input: unknown): Promise<DeviceAuthorizationStart> {
    const body = object(input, ['deviceName', 'machineId']);
    const name = deviceName(body.deviceName);
    const machine = machineId(body.machineId);
    const now = this.now();
    await this.pool.query(`DELETE FROM ${this.schema}.cloud_device_authorizations WHERE expires_at <= $1`, [now]);
    const pollToken = `ttp_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_MS);
    for (let attempt = 0; ; attempt++) {
      const code = normalizeUserCode(Array.from({length: 8}, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join(''));
      try {
        await this.pool.query(`INSERT INTO ${this.schema}.cloud_device_authorizations(id, poll_hash, user_code, device_name, machine_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), hash(pollToken), code, name, machine, expiresAt]);
        return {pollToken, userCode: code, expiresAt: expiresAt.toISOString(), interval: 3};
      } catch (error) {
        // Retry a user-code collision; anything else is a real failure.
        if (attempt < 3 && error && typeof error === 'object' && 'code' in error && error.code === '23505') continue;
        throw error;
      }
    }
  }

  /** What the signed-in browser is about to approve, including the account's earlier connection of the same computer. */
  async deviceAuthorization(identity: AccountIdentity, code: unknown): Promise<DeviceAuthorizationRequest> {
    const userCode = normalizeUserCode(code);
    const id = accountKey(identity);
    return this.transaction(id, async client => {
      const found = await client.query<{device_name: string; machine_id: string | null; expires_at: Date; account_id: string | null}>(
        'SELECT device_name, machine_id, expires_at, account_id FROM cloud_device_authorizations WHERE user_code = $1 AND expires_at > $2', [userCode, this.now()]);
      const row = found.rows[0];
      if (!row || (row.account_id !== null && row.account_id !== id)) throw codeNotFound();
      const same = await client.query<{name: string}>('SELECT name FROM cloud_devices WHERE account_id = $1 AND machine_id = $2 ORDER BY created_at DESC LIMIT 1', [id, row.machine_id]);
      return {userCode, deviceName: row.device_name, expiresAt: row.expires_at.toISOString(), approved: row.account_id !== null, replaces: same.rows[0]?.name ?? null};
    });
  }

  /** `githubLogin` as for `putPublication`. */
  async approveDeviceAuthorization(identity: AccountIdentity, code: unknown, githubLogin?: string | null): Promise<void> {
    const userCode = normalizeUserCode(code);
    const id = accountKey(identity);
    await this.transaction(id, async client => {
      await this.refuseBanned(client, id);
      const joined = await client.query('SELECT 1 FROM cloud_publications WHERE account_id = $1', [id]);
      if (!joined.rowCount) throw new CloudError(409, 'NOT_PUBLISHED', 'Join the leaderboard before connecting a device.');
      const found = await client.query<{machine_id: string | null}>('SELECT machine_id FROM cloud_device_authorizations WHERE user_code = $1 AND expires_at > $2 AND (account_id IS NULL OR account_id = $3)', [userCode, this.now(), id]);
      if (!found.rows[0]) throw codeNotFound();
      await this.refuseFull(client, id, found.rows[0].machine_id);
      if (githubLogin !== undefined) await client.query('UPDATE cloud_accounts SET github_login = $2 WHERE id = $1', [id, githubLogin]);
      // First approval wins; a code can never be moved to another account.
      const result = await client.query('UPDATE cloud_device_authorizations SET account_id = $1 WHERE user_code = $2 AND expires_at > $3 AND (account_id IS NULL OR account_id = $1)', [id, userCode, this.now()]);
      if (!result.rowCount) throw codeNotFound();
    });
  }

  /** The collector collects its credential once. It replaces the account's earlier connection of the same computer, if any. */
  async pollDeviceAuthorization(pollToken: string): Promise<DeviceAuthorizationPoll> {
    const pollHash = hash(pollToken);
    const expired = () => new CloudError(410, 'EXPIRED', 'This connection request expired. Start again from the app.');
    const found = await this.pool.query<{id: string; account_id: string | null; expires_at: Date}>(
      `SELECT id, account_id, expires_at FROM ${this.schema}.cloud_device_authorizations WHERE poll_hash = $1`, [pollHash]);
    const row = found.rows[0];
    if (!row || row.expires_at <= this.now()) throw expired();
    if (row.account_id === null) return {status: 'pending'};
    const accountId = row.account_id;
    return this.transaction(accountId, async client => {
      await this.refuseBanned(client, accountId);
      // Consuming under the account lock means concurrent polls mint at most one credential.
      const consumed = await client.query<{device_name: string; machine_id: string | null}>('DELETE FROM cloud_device_authorizations WHERE id = $1 AND poll_hash = $2 AND account_id = $3 RETURNING device_name, machine_id', [row.id, pollHash, accountId]);
      if (!consumed.rowCount) throw expired();
      const p = await client.query<PublicationRow>('SELECT * FROM cloud_publications WHERE account_id = $1', [accountId]);
      if (!p.rows[0]) throw new CloudError(409, 'NOT_PUBLISHED', 'Join the leaderboard before connecting a device.');
      const {device_name: name, machine_id: machine} = consumed.rows[0]!;
      // Approvals that each saw a free slot: only the first pickup gets it.
      await this.refuseFull(client, accountId, machine);
      // The same computer again (a reinstall or a new data folder) re-uploads a full snapshot, so its earlier totals go.
      const replaced = await client.query<{id: string}>('UPDATE cloud_devices SET revoked_at = coalesce(revoked_at, now()), machine_id = NULL WHERE account_id = $1 AND machine_id = $2 RETURNING id', [accountId, machine]);
      if (replaced.rowCount) {
        await client.query('DELETE FROM cloud_buckets WHERE account_id = $1 AND device_id = ANY($2)', [accountId, replaced.rows.map(device => device.id)]);
        await client.query('DELETE FROM cloud_hours WHERE account_id = $1 AND device_id = ANY($2)', [accountId, replaced.rows.map(device => device.id)]);
      }
      try { await this.validateAccountTotals(client, accountId); }
      catch (error) {
        if (error instanceof CloudError && error.code === 'COUNTER_OVERFLOW') throw new CloudError(422, 'COUNTER_OVERFLOW', 'Connecting this computer would expose costs above the account limit. Correct the usage, or save your listing and sync again, then retry connecting.');
        throw error;
      }
      const device = await this.mintDevice(client, accountId, name, machine);
      return {status: 'approved', deviceToken: device.token, publication: publication(p.rows[0])};
    });
  }

  /** Stops the computer's uploads. What it already published stays and keeps counting. */
  async revokeDevice(identity: AccountIdentity, deviceId: string): Promise<void> {
    if (!DEVICE_ID.test(deviceId)) throw deviceNotFound();
    const id = accountKey(identity);
    await this.transaction(id, async client => {
      const result = await client.query('UPDATE cloud_devices SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL', [deviceId, id]);
      if (!result.rowCount) throw deviceNotFound();
    });
  }

  async renameDevice(identity: AccountIdentity, deviceId: string, name: unknown): Promise<void> {
    const validName = deviceName(name);
    if (!DEVICE_ID.test(deviceId)) throw deviceNotFound();
    const id = accountKey(identity);
    await this.transaction(id, async client => {
      const result = await client.query('UPDATE cloud_devices SET name = $3 WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL', [deviceId, id, validName]);
      if (!result.rowCount) throw deviceNotFound();
    });
  }

  /** Let the linked collector check the current publication before constructing a payload. */
  async devicePublication(token: string): Promise<Publication> {
    const tokenHash = hash(token);
    const found = await this.pool.query<DeviceRow>(`SELECT id, account_id FROM ${this.schema}.cloud_devices WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
    const device = found.rows[0];
    if (!device) throw new CloudError(401, 'UNAUTHORIZED', 'Invalid or revoked device credential');
    return this.transaction(device.account_id, async client => {
      const active = await client.query('SELECT 1 FROM cloud_devices WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL', [device.id,tokenHash]);
      if (!active.rowCount) throw new CloudError(401, 'UNAUTHORIZED', 'Invalid or revoked device credential');
      await this.refuseBanned(client, device.account_id);
      const result = await client.query<PublicationRow>('SELECT * FROM cloud_publications WHERE account_id = $1', [device.account_id]);
      if (!result.rows[0]) throw new CloudError(409, 'NOT_PUBLISHED', 'Review and join the leaderboard before linking this device.');
      return publication(result.rows[0]);
    });
  }
  async ingest(token: string, input: unknown): Promise<{accepted: number}> {
    const v = ingestionInput(input, this.now());
    const tokenHash = hash(token);
    // This lookup grants no authority; recheck revocation after obtaining the account lock.
    const found = await this.pool.query<DeviceRow>(`SELECT id, account_id FROM ${this.schema}.cloud_devices WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
    const device = found.rows[0];
    if (!device) throw new CloudError(401, 'UNAUTHORIZED', 'Invalid or revoked device credential');
    return this.transaction(device.account_id, async client => {
      const active = await client.query<{collector_id:string|null;checkpoint:string;receipt:string|null}>('SELECT collector_id, checkpoint, receipt FROM cloud_devices WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL', [device.id, tokenHash]);
      if (!active.rowCount) throw new CloudError(401, 'UNAUTHORIZED', 'Invalid or revoked device credential');
      await this.refuseBanned(client, device.account_id);
      const publications = await client.query<PublicationRow>('SELECT * FROM cloud_publications WHERE account_id = $1', [device.account_id]);
      const p = publications.rows[0];
      if (!p || p.generation !== v.generation) throw new CloudError(409, 'STALE_PUBLICATION', 'The current publication generation is required');
      const state = active.rows[0]!;
      if ((state.collector_id !== null && state.collector_id !== v.collectorId) || Number(state.checkpoint) > v.checkpoint) {
        throw new CloudError(409, 'LOCAL_STATE_RESET', 'Local history was reset or restored. Save the hosted privacy review to clear previous totals, then relink this device.');
      }
      const legacy = state.receipt === null ? await client.query('SELECT 1 FROM cloud_buckets WHERE account_id = $1 AND device_id = $2 LIMIT 1',[device.account_id,device.id]) : null;
      if (legacy?.rowCount || (state.receipt !== v.baseReceipt && state.receipt !== v.receipt) || (state.receipt === v.receipt && Number(state.checkpoint) !== v.checkpoint)) {
        throw new CloudError(409, 'LOCAL_STATE_RESET', 'Local sync history is out of date. Save the hosted privacy review to clear previous totals, then relink this device.');
      }
      const previous = wide((await client.query<{tokens: string}>('SELECT coalesce(sum(tokens),0) AS tokens FROM cloud_account_buckets WHERE account_id = $1', [device.account_id])).rows[0]!.tokens);
      // A restored invalid account may correct its totals. The prior total is only used for moderation lead crossings.
      const before = Number(previous > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : previous);
      let accepted = 0;
      for (const b of v.buckets) {
        this.validateScope(b, p);
        // Token kinds are always published with the bucket (no sharing flag); a bucket from an older app has none.
        const k = b.breakdown;
        const result = await client.query(`
          INSERT INTO cloud_buckets(account_id, device_id, day_key, tool, model, tokens, cost_microusd, revision,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT(account_id,device_id,day_key,tool,model) DO UPDATE SET tokens = EXCLUDED.tokens, cost_microusd = EXCLUDED.cost_microusd,
            revision = EXCLUDED.revision, input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
            cache_read_tokens = EXCLUDED.cache_read_tokens, cache_write_tokens = EXCLUDED.cache_write_tokens, reasoning_tokens = EXCLUDED.reasoning_tokens
          WHERE cloud_buckets.revision < EXCLUDED.revision`,
        [device.account_id, device.id, b.day ?? 'unknown', b.tool, b.model ?? '', b.tokens, b.costMicrousd, b.revision,
          k?.input ?? null, k?.output ?? null, k?.cacheRead ?? null, k?.cacheWrite ?? null, k?.reasoning ?? null]);
        accepted += result.rowCount ?? 0;
      }
      // Per computer: another computer on an older app may split the same day differently without double counting.
      const mixed = await client.query(`SELECT 1 FROM cloud_buckets WHERE account_id = $1 AND device_id = $2 GROUP BY day_key
        HAVING (bool_or(tool = 'all') AND bool_or(tool <> 'all')) OR (bool_or(model = '') AND bool_or(model <> '')) LIMIT 1`, [device.account_id, device.id]);
      if (mixed.rowCount) invalid('A day cannot combine aggregated and split buckets');
      const {since} = lastDay(this.now());
      if (v.hours) {
        for (const h of v.hours) {
          if (!p.share_tools && h.tool !== 'all') invalid('Tool breakdown was not approved');
          if (p.history_start && h.hour < p.history_start.toISOString()) invalid('Hour is outside the approved history scope');
        }
        // An upload's hours replace the computer's; hours already outside the window are not kept.
        const kept = v.hours.filter(h => Date.parse(h.hour) >= since.getTime() && h.tokens > 0);
        await client.query('DELETE FROM cloud_hours WHERE device_id = $1', [device.id]);
        await client.query(`INSERT INTO cloud_hours(account_id, device_id, hour, tool, tokens)
          SELECT $1, $2, h.hour, h.tool, h.tokens FROM unnest($3::timestamptz[], $4::text[], $5::bigint[]) AS h(hour, tool, tokens)`,
        [device.account_id, device.id, kept.map(h => h.hour), kept.map(h => h.tool), kept.map(h => h.tokens)]);
        await client.query('UPDATE cloud_devices SET hours_at = now() WHERE id = $1', [device.id]);
      }
      // Every upload deletes everyone's hours that have left the window, skipping rows another upload holds.
      await client.query('DELETE FROM cloud_hours WHERE ctid IN (SELECT ctid FROM cloud_hours WHERE hour < $1 FOR UPDATE SKIP LOCKED)', [since]);
      const after = await this.validateAccountTotals(client, device.account_id);
      if (v.buckets.length) await this.moderate(client, device.account_id, [...new Set(v.buckets.map(b => b.day ?? 'unknown'))], before, after);
      // Ingest only upserts buckets, so an upload that changed none cannot change a badge.
      if (accepted) await storeBadges(client, this.schema, device.account_id, this.now().toISOString().slice(0, 10));
      await client.query('UPDATE cloud_devices SET last_seen_at = now(), collector_id = $2, checkpoint = $3, receipt = $4 WHERE id = $1', [device.id,v.collectorId,v.checkpoint,v.receipt]);
      return {accepted};
    });
  }

  /** Every operation that changes the deduplicated projection validates it while holding the account lock. */
  private async validateAccountTotals(client: PoolClient, accountId: string): Promise<number> {
    const totals = (await client.query<{tokens: string; cost: string | null}>('SELECT coalesce(sum(tokens),0) AS tokens, sum(cost_microusd) AS cost FROM cloud_account_buckets WHERE account_id = $1', [accountId])).rows[0]!;
    const tokens = safe(totals.tokens);
    if (totals.cost !== null) safe(totals.cost);
    return tokens;
  }

  /** Callers hold the account lock. A ban refuses every route that publishes or links a computer. */
  private async refuseBanned(client: PoolClient, accountId: string): Promise<void> {
    if ((await client.query('SELECT 1 FROM cloud_bans WHERE account_id = $1', [accountId])).rowCount) {
      throw new CloudError(403, 'BANNED', 'This account can no longer publish to the leaderboard.');
    }
  }

  private async moderation(client: PoolClient, accountId: string): Promise<AccountModeration | null> {
    if ((await client.query('SELECT 1 FROM cloud_bans WHERE account_id = $1', [accountId])).rowCount) return {state: 'banned'};
    const hidden = await client.query<{day_key: string}>(`SELECT day_key FROM cloud_flags WHERE account_id = $1 AND status = 'hidden' ORDER BY day_key`, [accountId]);
    return hidden.rowCount ? {state: 'hidden', days: hidden.rows.map(row => row.day_key)} : null;
  }

  /**
   * Upload checks, under the account lock, after the buckets are written. They only flag
   * and hide; the upload is accepted either way, so a member can still send corrected totals.
   */
  private async moderate(client: PoolClient, accountId: string, uploaded: string[], before: number, after: number): Promise<void> {
    const extra = new Map<string, Reason[]>();
    const add = (day: string, reason: Reason) => extra.set(day, [...(extra.get(day) ?? []), reason]);
    const template = await client.query<{day: string}>(`SELECT coalesce(max(day_key) FILTER (WHERE day_key <> 'unknown'), 'unknown') AS day
      FROM cloud_account_buckets WHERE account_id = $1 AND tokens >= $2 GROUP BY tokens HAVING count(*) >= $3 ORDER BY 1 DESC LIMIT 1`,
    [accountId, this.rules.LIMITS.templateTokens, this.rules.LIMITS.templateCount]);
    if (template.rows[0]) add(template.rows[0].day, 'template');
    const from = this.rules.leadCheck(before, after);
    if (from !== null) {
      const rival = await client.query<{tokens: string | null}>(`SELECT max(t.tokens) AS tokens FROM (${bucketTotals(`b.account_id <> $1 AND ${VISIBLE_BUCKET}`, 'b.account_id')}) t`, [accountId]);
      if (this.rules.crossesLead(from, after, rival.rows[0]!.tokens === null ? 0 : safe(rival.rows[0]!.tokens))) add(uploaded.filter(day => day !== 'unknown').sort().at(-1) ?? 'unknown', 'lead');
    }
    const own = await client.query<{day: string; tokens: string}>(`SELECT day_key AS day, tokens FROM (${bucketTotals('b.account_id = $1 AND b.day_key = ANY($2)')}) t`,
      [accountId, [...new Set([...uploaded, ...extra.keys()])]]);
    const totals = new Map(own.rows.map(row => [row.day, safe(row.tokens)]));
    const days = [...totals.keys()].filter(day => extra.has(day) || totals.get(day)! >= this.rules.DAY_GATE);
    if (!days.length) return;
    const peers = await client.query<{day: string; rival: string; cohort: number; history: string[] | null}>(`
      WITH others AS (${bucketTotals(`b.day_key = ANY($2) AND b.account_id <> $1 AND ${VISIBLE_BUCKET}`)} HAVING sum(b.tokens) > 0),
        mine AS (${bucketTotals(`b.account_id = $1 AND b.day_key <> 'unknown'`)} HAVING sum(b.tokens) > 0)
      SELECT d.day, coalesce((SELECT max(o.tokens) FROM others o WHERE o.day_key = d.day), 0) AS rival,
        (SELECT count(*)::int FROM others o WHERE o.day_key = d.day) AS cohort,
        CASE WHEN d.day = 'unknown' THEN NULL ELSE ARRAY(SELECT m.tokens FROM mine m WHERE m.day_key < d.day ORDER BY m.day_key DESC LIMIT $3) END AS history
      FROM unnest($2::text[]) AS d(day)`, [accountId, days, this.rules.LIMITS.baselineDays]);
    const findings = peers.rows.flatMap(row => {
      const signals: DaySignals = {day: row.day, tokens: totals.get(row.day)!, rival: safe(row.rival), cohort: row.cohort, baseline: row.history === null ? null : this.rules.median(row.history.map(safe))};
      return this.rules.assess(signals, extra.get(row.day)) ?? [];
    });
    if (!findings.length) return;
    const stored = await client.query<{day: string; tokens: string; status: FlagStatus; reasons: Reason[]; reviewed: boolean}>(
      'SELECT day_key AS day, tokens, status, reasons, reviewed_at IS NOT NULL AS reviewed FROM cloud_flags WHERE account_id = $1 AND day_key = ANY($2)',
      [accountId, findings.map(finding => finding.day)]);
    const existing = new Map<string, StoredFlag>(stored.rows.map(row => [row.day, {...row, tokens: safe(row.tokens)}]));
    for (const finding of findings) {
      const previous = existing.get(finding.day);
      const write = this.rules.nextFlag(previous, finding);
      if (!write) continue;
      if (write.status === 'hidden' && write.detected && await this.breakerTripped(client, accountId)) {
        write.status = 'review';
        write.detected = !previous || previous.reviewed || previous.status !== 'review';
        this.log({event: 'moderation_breaker'});
      }
      await this.writeFlag(client, accountId, write, write.detected);
      if (write.detected) this.log({event: 'moderation_flag', status: write.status, reasons: write.reasons});
    }
  }

  /** Serialized across accounts, so concurrent uploads cannot each slip under the limit. */
  private async breakerTripped(client: PoolClient, accountId: string): Promise<boolean> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${this.schema}:tokentracky:moderation:breaker`]);
    const recent = await client.query<{count: number}>(`SELECT count(DISTINCT account_id)::int AS count FROM cloud_flags
      WHERE status = 'hidden' AND reviewed_at IS NULL AND account_id <> $1 AND detected_at > $2`, [accountId, new Date(this.now().getTime() - this.rules.LIMITS.breakerWindowMs)]);
    return recent.rows[0]!.count >= this.rules.LIMITS.breakerHides;
  }

  private async writeFlag(client: PoolClient, accountId: string, flag: Finding, detected: boolean): Promise<void> {
    await client.query(`
      INSERT INTO cloud_flags(account_id, day_key, tokens, rival_tokens, cohort_size, baseline_tokens, reasons, status, detected_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (account_id, day_key) DO UPDATE SET tokens = EXCLUDED.tokens, rival_tokens = EXCLUDED.rival_tokens, cohort_size = EXCLUDED.cohort_size,
        baseline_tokens = EXCLUDED.baseline_tokens, reasons = EXCLUDED.reasons, status = EXCLUDED.status,
        detected_at = CASE WHEN $10 THEN EXCLUDED.detected_at ELSE cloud_flags.detected_at END,
        reviewed_at = CASE WHEN $10 THEN NULL ELSE cloud_flags.reviewed_at END,
        note = CASE WHEN $10 THEN NULL ELSE cloud_flags.note END`,
    [accountId, flag.day, flag.tokens, flag.rival, flag.cohort, flag.baseline === null ? null : Math.round(flag.baseline), flag.reasons, flag.status, this.now(), detected]);
  }

  /** Recomputes one account's badges under its lock, unless it has no profile or is banned (a ban clears them). */
  private async refreshBadges(client: PoolClient, accountId: string): Promise<boolean> {
    const p = (await client.query('SELECT 1 FROM cloud_publications WHERE account_id = $1', [accountId])).rowCount;
    if (!p || (await client.query('SELECT 1 FROM cloud_bans WHERE account_id = $1', [accountId])).rowCount) return false;
    if ((await client.query('SELECT 1 FROM cloud_invalid_counter_accounts WHERE account_id = $1', [accountId])).rowCount) return false;
    await storeBadges(client, this.schema, accountId, this.now().toISOString().slice(0, 10));
    return true;
  }

  private validateScope(bucket: PublicBucket, p: PublicationRow): void {
    if (!p.share_tools && bucket.tool !== 'all') invalid('Tool breakdown was not approved');
    if (!p.share_cost && bucket.costMicrousd !== null) invalid('Cost sharing was not approved');
    if (!p.share_models && bucket.model !== undefined) invalid('Model mix was not approved');
    if (p.history_start && (!bucket.day || bucket.day < p.history_start.toISOString().slice(0, 10))) invalid('Bucket is outside the approved history scope');
  }

  async leaderboard(query: LeaderboardQuery): Promise<LeaderboardResponse> {
    return this.snapshot(client => this.rankings(client, query));
  }

  /** One read-only snapshot keeps rankings, trend, sparklines and community totals coherent during mutations. */
  private async snapshot<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  /** One shared cohort calculation for exact ranks, independent of community-only statistics. */
  private async cohort(client: PoolClient, period: Period, tool: ToolId | 'all', now: Date): Promise<PublicProfile[]> {
    const windowStart = rankingWindow(period, now);
    const today = now.toISOString().slice(0, 10);
    const result = await client.query<{alias: string; share_tools: boolean; share_cost: boolean; tool: ToolId | 'all' | null; tokens: string | null; before: string | null; cost: string | null}>(`
      SELECT p.alias, p.share_tools, p.share_cost, b.tool, sum(b.tokens) AS tokens,
        sum(b.tokens) FILTER (WHERE b.day_key < $3 OR b.day_key = 'unknown') AS before,
        CASE WHEN count(*) FILTER (WHERE b.cost_microusd IS NULL) > 0 THEN NULL ELSE sum(b.cost_microusd) END AS cost
      FROM ${this.schema}.cloud_publications p LEFT JOIN ${this.buckets} b ON b.account_id = p.account_id
        AND ($1::text IS NULL OR b.day_key >= $1) AND ($1::text IS NULL OR b.day_key <> 'unknown')
        AND (p.history_start IS NULL OR (b.day_key <> 'unknown' AND b.day_key >= to_char(p.history_start AT TIME ZONE 'UTC', 'YYYY-MM-DD')))
      WHERE ($2 = 'all' OR p.share_tools) AND ${this.visible}
      GROUP BY p.account_id, p.alias, p.share_tools, p.share_cost, b.tool`, [windowStart?.slice(0, 10) ?? null, tool, today]);
    const profiles = new Map<string, {profile: PublicProfile; costs: Array<number | null>; before: number}>();
    for (const row of result.rows) {
      let entry = profiles.get(row.alias);
      if (!entry) {
        const profile: PublicProfile = {alias: row.alias, rank: 0, tokens: 0, previousRank: null, daily: []};
        if (row.share_tools) profile.toolTokens = {};
        if (row.share_cost) profile.costMicrousd = null;
        entry = {profile, costs: [], before: 0};
        profiles.set(row.alias, entry);
      }
      const tokens = row.tokens === null ? 0 : safe(row.tokens);
      if (row.tool && row.tool !== 'all' && row.share_tools) entry.profile.toolTokens![row.tool] = tokens;
      if (tool === 'all' || row.tool === tool) {
        entry.profile.tokens = safe(entry.profile.tokens + tokens);
        entry.before = safe(entry.before + (row.before === null ? 0 : safe(row.before)));
      }
      // Cost always covers every tool in the window, like `toolTokens`; ranking by one tool only reorders builders.
      entry.costs.push(row.cost === null ? null : safe(row.cost));
    }
    // Yesterday's standings in the same window and cohort; builders with nothing before today have no previous rank.
    [...profiles.values()].filter(entry => entry.before > 0)
      .sort((a, b) => b.before - a.before || (a.profile.alias < b.profile.alias ? -1 : a.profile.alias > b.profile.alias ? 1 : 0))
      .forEach((entry, index) => { entry.profile.previousRank = index + 1; });
    const cohort = [...profiles.values()].map(({profile, costs}) => {
      if ('costMicrousd' in profile) profile.costMicrousd = costs.length === 0 || costs.some(v => v === null) ? null : this.sum(costs as number[]);
      return profile;
    }).sort((a, b) => b.tokens - a.tokens || (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
    cohort.forEach((profile, index) => { profile.rank = index + 1; });
    return cohort;
  }

  private scope(): string {
    return `b.day_key >= $1 AND b.day_key <> 'unknown' AND ${this.visible}
      AND (p.history_start IS NULL OR b.day_key >= to_char(p.history_start AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
      AND ($2 = 'all' OR (p.share_tools AND b.tool = $2))`;
  }

  private async publicTrend(client: PoolClient, tool: ToolId | 'all', now: Date): Promise<Array<{day: string; tokens: bigint}>> {
    const days = recentDays(now, TREND_DAYS);
    const rows = await client.query<{day: string; tokens: string}>(`
      SELECT b.day_key AS day, sum(b.tokens) AS tokens
      FROM ${this.schema}.cloud_publications p JOIN ${this.buckets} b ON b.account_id = p.account_id
      WHERE ${this.scope()} GROUP BY b.day_key`, [days[0], tool]);
    const byDay = new Map(rows.rows.map(row => [row.day, wide(row.tokens)]));
    return days.map(day => ({day, tokens: byDay.get(day) ?? 0n}));
  }

  /** Only selected account data: no shared trend, tool sum or spend calculation. */
  private async hydrateProfiles(client: PoolClient, items: PublicProfile[], period: Period, tool: ToolId | 'all', now: Date): Promise<void> {
    if (!items.length) return;
    const days = recentDays(now, DAILY_DAYS);
    const daily = await client.query<{alias: string; day: string; tokens: string}>(`
      SELECT p.alias, b.day_key AS day, sum(b.tokens) AS tokens
      FROM ${this.schema}.cloud_publications p JOIN ${this.buckets} b ON b.account_id = p.account_id
      WHERE ${this.scope()} AND p.alias = ANY($3) GROUP BY p.alias, b.day_key`, [days[0], tool, items.map(p => p.alias)]);
    const byDay = new Map(daily.rows.map(row => [`${row.alias} ${row.day}`, safe(row.tokens)]));
    for (const item of items) item.daily = days.map(day => byDay.get(`${item.alias} ${day}`) ?? 0);
    if (period !== 'all') {
      const lifetime = await client.query<{alias: string; tokens: string}>(`
        SELECT p.alias, sum(b.tokens) AS tokens
        FROM ${this.schema}.cloud_publications p JOIN ${this.buckets} b ON b.account_id = p.account_id
        WHERE ${this.visible} AND p.alias = ANY($1)
          AND (p.history_start IS NULL OR (b.day_key <> 'unknown' AND b.day_key >= to_char(p.history_start AT TIME ZONE 'UTC', 'YYYY-MM-DD')))
        GROUP BY p.alias`, [items.map(p => p.alias)]);
      const byAlias = new Map(lifetime.rows.map(row => [row.alias, safe(row.tokens)]));
      for (const item of items) item.lifetimeTokens = byAlias.get(item.alias) ?? 0;
    }
    // The last day across every tool, like the lifetime, for members with a computer that sends hours; a total beyond
    // the safe range is left out.
    const {since, until} = lastDay(now);
    const hours = await client.query<{alias: string; tokens: string | null}>(`
      SELECT p.alias, sum(h.tokens) AS tokens
      FROM ${this.schema}.cloud_publications p LEFT JOIN ${this.schema}.cloud_account_hours h ON h.account_id = p.account_id
        AND h.hour >= $2 AND h.hour < $3
      WHERE p.alias = ANY($1) AND EXISTS (SELECT 1 FROM ${this.schema}.cloud_devices d WHERE d.account_id = p.account_id AND d.hours_at IS NOT NULL)
      GROUP BY p.alias`, [items.map(p => p.alias), since, until]);
    const lastHours = new Map(hours.rows.map(row => [row.alias, wide(row.tokens ?? '0')]));
    for (const item of items) {
      const tokens = lastHours.get(item.alias);
      if (tokens !== undefined && tokens <= BigInt(Number.MAX_SAFE_INTEGER)) item.last24hTokens = Number(tokens);
    }
    const top = await topBadges(client, this.schema, items.map(p => p.alias));
    for (const item of items) if (top.has(item.alias)) item.topBadges = top.get(item.alias);
  }

  private async rankings(client: PoolClient, query: LeaderboardQuery): Promise<LeaderboardResponse> {
    const now = this.now();
    const cohort = await this.cohort(client, query.period, query.tool, now);
    const searched = cohort.filter(p => p.alias.includes(query.q.toLowerCase()));
    if (query.sort === 'cost') searched.sort((a, b) => (b.costMicrousd ?? -1) - (a.costMicrousd ?? -1) || a.rank - b.rank);
    const at = query.around === undefined ? -1 : cohort.findIndex(p => p.alias === query.around);
    const items = query.around === undefined ? searched.slice((query.page - 1) * query.pageSize, query.page * query.pageSize) : at < 0 ? [] : cohort.slice(Math.max(0, at - 1), at + 2);
    await this.hydrateProfiles(client, items, query.period, query.tool, now);
    const tools: Partial<Record<ToolId, bigint>> = {};
    for (const profile of cohort) for (const [tool, tokens] of Object.entries(profile.toolTokens ?? {}) as Array<[ToolId, number]>) tools[tool] = (tools[tool] ?? 0n) + wide(tokens);
    const costs = cohort.flatMap(p => typeof p.costMicrousd === 'number' ? [p.costMicrousd] : []);
    return {
      items, total: searched.length, builders: cohort.length, page: query.page, pageSize: query.pageSize, period: query.period,
      windowStart: rankingWindow(query.period, now), updatedAt: now.toISOString(),
      ...publicAggregates({totalTokens: sumWide(cohort.map(p => p.tokens)), totalCostMicrousd: costs.length ? sumWide(costs) : null,
        toolTotals: tools, trend: await this.publicTrend(client, query.tool, now)}),
    };
  }

  private sum(values: number[]): number {
    try { return checkedSum(values); } catch { throw new CloudError(422, 'COUNTER_OVERFLOW', 'Aggregate exceeds the safe integer range'); }
  }

  /** Landing-page totals: every published builder, all time, plus the 30-day community trend and the totals by token kind. */
  async community(): Promise<CommunityStats> {
    return this.snapshot(client => this.communitySummary(client, this.now()));
  }

  private async communitySummary(client: PoolClient, now: Date): Promise<CommunityStats> {
    const published = `(p.history_start IS NULL OR (b.day_key <> 'unknown' AND b.day_key >= to_char(p.history_start AT TIME ZONE 'UTC', 'YYYY-MM-DD')))`;
    const totals = (await client.query<{builders: number; tokens: string; cost: string | null}>(`
      SELECT count(*)::int AS builders, coalesce(sum(tokens), 0) AS tokens, sum(cost) AS cost FROM (
        SELECT p.account_id, coalesce(sum(b.tokens), 0) AS tokens,
          CASE WHEN NOT p.share_cost OR count(*) FILTER (WHERE b.cost_microusd IS NULL) > 0 THEN NULL ELSE sum(b.cost_microusd) END AS cost
        FROM ${this.schema}.cloud_publications p LEFT JOIN ${this.buckets} b ON b.account_id = p.account_id AND ${published}
        WHERE ${this.visible} GROUP BY p.account_id
      ) totals`)).rows[0]!;
    const fresh = await client.query<{count: number}>(`SELECT count(*)::int AS count FROM ${this.schema}.cloud_publications p
      JOIN ${this.schema}.cloud_accounts a ON a.id = p.account_id WHERE a.created_at > $1 AND ${this.visible}`, [new Date(now.getTime() - 7 * 86_400_000)]);
    const tools = await client.query<{tool: ToolId; tokens: string}>(`SELECT b.tool, sum(b.tokens) AS tokens
      FROM ${this.schema}.cloud_publications p JOIN ${this.buckets} b ON b.account_id = p.account_id
      WHERE ${this.visible} AND ${published} AND p.share_tools AND b.tool <> 'all' GROUP BY b.tool`);
    const kinds = (await client.query<KindSums>(`SELECT ${KIND_SUMS}
      FROM ${this.schema}.cloud_publications p JOIN ${this.buckets} b ON b.account_id = p.account_id
      WHERE ${this.visible} AND ${published}`)).rows[0]!;
    const breakdown: WideKinds | null = Number(kinds.typed) > 0 ? {
      input: wide(kinds.input ?? '0'), output: wide(kinds.output ?? '0'), cacheRead: wide(kinds.cache_read ?? '0'),
      cacheWrite: wide(kinds.cache_write ?? '0'), reasoning: wide(kinds.reasoning ?? '0'),
    } : null;
    const aggregates = publicAggregates({totalTokens: wide(totals.tokens), totalCostMicrousd: totals.cost === null ? null : wide(totals.cost),
      toolTotals: Object.fromEntries(tools.rows.map(row => [row.tool, wide(row.tokens)])), trend: await this.publicTrend(client, 'all', now), breakdown});
    return {builders: totals.builders, newBuilders: fresh.rows[0]!.count, updatedAt: now.toISOString(), ...aggregates, breakdown: aggregates.breakdown ?? null};
  }

  /** Count-only telemetry: no request path, profile name, identity or uploaded content. */
  publicCounterFailure(): void {
    this.log({event: 'public_counter_overflow', count: 1});
  }

  /** A read-only diagnostic; wide valid community totals are reported, not treated as bad accounts. */
  async counterAudit(): Promise<CounterAudit> {
    return this.snapshot(async client => {
      const now = this.now();
      const count = (await client.query<{count: number}>(`SELECT count(*)::int AS count FROM ${this.schema}.cloud_invalid_counter_accounts`)).rows[0]!.count;
      const summary = await this.communitySummary(client, now);
      const families = new Set(Object.keys(summary.exactAggregates ?? {}));
      // Unknown costs can hide all-time costs that are known within a shorter window.
      for (const period of ['week', 'month'] as const) {
        const cohort = await this.cohort(client, period, 'all', now);
        if (sumWide(cohort.flatMap(p => typeof p.costMicrousd === 'number' ? [p.costMicrousd] : [])) > BigInt(Number.MAX_SAFE_INTEGER)) families.add('totalCostMicrousd');
      }
      return {invalidAccounts: count, overflowFamilies: families.size};
    });
  }

  /** How many visible members hold each badge at each tier, from stored badges. */
  async achievementRarity(): Promise<AchievementRarity> {
    return rarity(this.pool, this.schema);
  }

  /** A public profile page: ranks per window, a year of daily totals and, when shared, tool and model mix. */
  async profileStats(alias: string): Promise<ProfileStats> {
    return this.snapshot(async client => {
      const now = this.now();
      const name = alias.toLowerCase();
      const ranks = [];
      for (const period of ['week', 'month', 'all'] as const) {
        const {profile, builders} = await this.ranked(client, name, period, now, false);
        ranks.push({...profile, builders});
      }
      const [week, month, all] = ranks;
      const days = recentDays(now, PROFILE_DAYS);
      const scope = `FROM ${this.schema}.cloud_publications p JOIN ${this.buckets} b ON b.account_id = p.account_id
        WHERE p.alias = $1 AND (p.history_start IS NULL OR (b.day_key <> 'unknown' AND b.day_key >= to_char(p.history_start AT TIME ZONE 'UTC', 'YYYY-MM-DD')))`;
      const daily = await client.query<{day: string; tokens: string}>(`SELECT b.day_key AS day, sum(b.tokens) AS tokens ${scope} AND b.day_key >= $2 GROUP BY b.day_key`, [name, days[0]]);
      const byDay = new Map(daily.rows.map(row => [row.day, safe(row.tokens)]));
      const year = days.map(day => ({day, tokens: byDay.get(day) ?? 0}));
      // Likes from hidden or banned members do not count.
      const extras = await client.query<{share_cost: boolean; share_models: boolean; likes: number; member_since: string; github_login: string | null;
        badges: Partial<Record<BadgeId, [number, number]>> | null}>(`
        SELECT p.share_cost, p.share_models, (SELECT count(*)::int FROM ${this.schema}.cloud_likes l WHERE l.target_id = p.account_id
            AND NOT EXISTS (SELECT 1 FROM ${this.schema}.cloud_public_exclusions h WHERE h.account_id = l.liker_id)) AS likes,
          to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS member_since, a.github_login,
          (SELECT json_object_agg(b.badge, json_build_array(b.tier, b.value)) FROM ${this.schema}.cloud_badges b WHERE b.account_id = p.account_id) AS badges
        FROM ${this.schema}.cloud_publications p JOIN ${this.schema}.cloud_accounts a ON a.id = p.account_id WHERE p.alias = $1`, [name]);
      const extra = extras.rows[0];
      if (!extra) throw profileNotFound();
      const stats: ProfileStats = {alias: name, periods: {week: {rank: week!.rank, tokens: week!.tokens, builders: week!.builders}, month: {rank: month!.rank, tokens: month!.tokens, builders: month!.builders}, all: {rank: all!.rank, tokens: all!.tokens, builders: all!.builders}},
        daily: year, activity: activityStats(year, days.at(-1)!), likes: extra.likes, memberSince: extra.member_since,
        // The stored tier, as on leaderboard rows and in rarity, even before a threshold change is recomputed.
        badges: BADGE_IDS.map(id => {
          const [tier, value] = extra.badges?.[id] ?? [0, 0];
          return {id, tier, value, next: BADGE_TIERS[id][tier] ?? null};
        })};
      if (extra.github_login !== null) stats.githubLogin = extra.github_login;
      if (all!.toolTokens) stats.toolTokens = all!.toolTokens;
      if ('costMicrousd' in all!) stats.costMicrousd = all!.costMicrousd;
      if (extra.share_models) {
        const models = await client.query<{model: string; tokens: string; cost: string | null}>(`
          SELECT b.model, sum(b.tokens) AS tokens, CASE WHEN count(*) FILTER (WHERE b.cost_microusd IS NULL) > 0 THEN NULL ELSE sum(b.cost_microusd) END AS cost
          ${scope} AND b.model <> '' GROUP BY b.model HAVING sum(b.tokens) > 0`, [name]);
        const withCost = extra.share_cost;
        stats.models = models.rows.map(row => ({model: row.model, tokens: safe(row.tokens), ...(withCost ? {costMicrousd: row.cost === null ? null : safe(row.cost)} : {})}))
          .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
      }
      // The all-time split by kind, only when every published bucket carries kinds, so it adds up to the all-time total.
      const kinds = (await client.query<KindSums>(`SELECT ${KIND_SUMS} ${scope}`, [name])).rows[0]!;
      if (Number(kinds.buckets) > 0 && kinds.typed === kinds.buckets) stats.breakdown = kindSums(kinds);
      return stats;
    });
  }

  /**
   * Sets (`true`), clears (`false`) or only reads (`undefined`) the liker's like of a visible profile, and returns whether
   * it is liked now. A computer must be active, and banned accounts are refused, as on the device routes.
   */
  async like(liker: Liker, alias: string, liked?: boolean): Promise<boolean> {
    let accountId: string;
    if ('identity' in liker) accountId = accountKey(liker.identity);
    else {
      const found = await this.pool.query<{account_id: string}>(`SELECT account_id FROM ${this.schema}.cloud_devices WHERE token_hash = $1 AND revoked_at IS NULL`, [hash(liker.deviceToken)]);
      if (!found.rows[0]) throw new CloudError(401, 'UNAUTHORIZED', 'Invalid or revoked device credential');
      accountId = found.rows[0].account_id;
    }
    return this.transaction(accountId, async client => {
      if ('deviceToken' in liker && !(await client.query('SELECT 1 FROM cloud_devices WHERE account_id = $1 AND token_hash = $2 AND revoked_at IS NULL', [accountId, hash(liker.deviceToken)])).rowCount) {
        throw new CloudError(401, 'UNAUTHORIZED', 'Invalid or revoked device credential');
      }
      await this.refuseBanned(client, accountId);
      const target = (await client.query<{account_id: string}>(`SELECT p.account_id FROM cloud_publications p WHERE p.alias = $1 AND ${this.visible}`, [alias.toLowerCase()])).rows[0];
      if (!target) throw profileNotFound();
      const pair = [accountId, target.account_id];
      if (liked === true) {
        if (target.account_id === accountId) invalid('You cannot like your own profile');
        await client.query('INSERT INTO cloud_accounts(id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
        await client.query('INSERT INTO cloud_likes(liker_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', pair).catch((error: unknown) => {
          // The profile was withdrawn after it was found.
          throw error && typeof error === 'object' && 'code' in error && error.code === '23503' ? profileNotFound() : error;
        });
      } else if (liked === false) await client.query('DELETE FROM cloud_likes WHERE liker_id = $1 AND target_id = $2', pair);
      return liked ?? !!(await client.query('SELECT 1 FROM cloud_likes WHERE liker_id = $1 AND target_id = $2', pair)).rowCount;
    });
  }

  /** An alias and the builders ranked just above and below it in a window: two rows at either end of the board. */
  async around(alias: string, period: Period): Promise<{items: PublicProfile[]}> {
    return this.snapshot(async client => {
      const now = this.now();
      const cohort = await this.cohort(client, period, 'all', now);
      const at = cohort.findIndex(p => p.alias === alias.toLowerCase());
      if (at < 0) await this.unavailableProfile(client, alias);
      const items = cohort.slice(Math.max(0, at - 1), at + 2);
      await this.hydrateProfiles(client, items, period, 'all', now);
      return {items};
    });
  }

  /** One visit from a tagged link: only the UTC day, the tag and a count are kept. */
  async countVisit(tag: unknown): Promise<void> {
    if (tag !== 'share' && tag !== 'readme') invalid('Unknown link tag');
    await this.pool.query(`INSERT INTO ${this.schema}.cloud_share_visits(day, tag, count) VALUES ($1, $2, 1)
      ON CONFLICT (day, tag) DO UPDATE SET count = cloud_share_visits.count + 1`, [this.now().toISOString().slice(0, 10), tag]);
  }

  async profile(alias: string, period: Period): Promise<PublicProfile> {
    return this.snapshot(async client => (await this.ranked(client, alias, period, this.now())).profile);
  }

  private async ranked(client: PoolClient, alias: string, period: Period, now: Date, hydrate = true): Promise<{profile: PublicProfile; builders: number}> {
    const cohort = await this.cohort(client, period, 'all', now);
    const profile = cohort.find(p => p.alias === alias.toLowerCase());
    if (!profile) return this.unavailableProfile(client, alias);
    if (hydrate) await this.hydrateProfiles(client, [profile], period, 'all', now);
    return {profile, builders: cohort.length};
  }

  private async unavailableProfile(client: PoolClient, alias: string): Promise<never> {
    const invalid = await client.query(`SELECT 1 FROM ${this.schema}.cloud_publications p
      JOIN ${this.schema}.cloud_invalid_counter_accounts i ON i.account_id = p.account_id
      WHERE p.alias = $1 AND NOT EXISTS (SELECT 1 FROM ${this.schema}.cloud_hidden_accounts h WHERE h.account_id = p.account_id)`, [alias.toLowerCase()]);
    if (invalid.rowCount) throw new CloudError(503, 'PROFILE_DATA_UNAVAILABLE', 'This profile is unavailable until its owner corrects its usage totals.');
    throw profileNotFound();
  }

  // Operator moderation, run by scripts/moderation.ts. Never routed.

  /** Open flags, hidden first. "Now" figures exclude every hidden or banned member, as a ban review should. */
  async moderationQueue(): Promise<QueueItem[]> {
    return this.operatorRead(async client => {
      const rows = await client.query<{account_id: string; alias: string | null; day: string; status: 'review' | 'hidden'; reasons: Reason[]; detected_at: Date;
        tokens: string; rival: string; cohort: number; tokens_now: string | null; rival_now: string | null; cohort_now: number}>(`
        SELECT f.account_id, p.alias, f.day_key AS day, f.status, f.reasons, f.detected_at, f.tokens, f.rival_tokens AS rival, f.cohort_size AS cohort,
          (SELECT t.tokens FROM (${bucketTotals('b.account_id = f.account_id AND b.day_key = f.day_key')}) t) AS tokens_now,
          peers.rival AS rival_now, peers.cohort AS cohort_now
        FROM cloud_flags f LEFT JOIN cloud_publications p ON p.account_id = f.account_id
        CROSS JOIN LATERAL (SELECT max(t.tokens) AS rival, count(*)::int AS cohort
          FROM (${bucketTotals(`b.day_key = f.day_key AND b.account_id <> f.account_id AND ${VISIBLE_BUCKET}`)} HAVING sum(b.tokens) > 0) t) peers
        WHERE f.reviewed_at IS NULL AND f.status <> 'cleared'
        ORDER BY f.status = 'hidden' DESC, f.tokens DESC, f.account_id, f.day_key`);
      return rows.rows.map(row => ({accountId: row.account_id, alias: row.alias, day: row.day, status: row.status, reasons: row.reasons, detectedAt: row.detected_at.toISOString(),
        tokens: safe(row.tokens), rival: safe(row.rival), cohort: row.cohort, tokensNow: safe(row.tokens_now ?? 0), rivalNow: safe(row.rival_now ?? 0), cohortNow: row.cohort_now}));
    });
  }

  /** The account behind an alias, or a 64-hex account id as given (a banned member may have deleted their profile). */
  async moderationSummary(target: string): Promise<ModerationSummary> {
    const accountId = /^[0-9a-f]{64}$/.test(target) ? target : await this.accountForAlias(target);
    return this.operatorRead(async client => {
      const found = await client.query<{alias: string | null; tokens: string; days: number; devices: number; banned: boolean}>(`
        SELECT (SELECT alias FROM cloud_publications WHERE account_id = $1) AS alias,
          (SELECT coalesce(sum(tokens), 0) FROM cloud_account_buckets WHERE account_id = $1) AS tokens,
          (SELECT count(DISTINCT day_key)::int FROM cloud_account_buckets WHERE account_id = $1 AND tokens > 0) AS days,
          (SELECT count(*)::int FROM cloud_devices WHERE account_id = $1 AND revoked_at IS NULL) AS devices,
          EXISTS (SELECT 1 FROM cloud_bans WHERE account_id = $1) AS banned`, [accountId]);
      const flags = await client.query<{day: string; status: FlagStatus; reasons: Reason[]; reviewed: boolean}>(
        'SELECT day_key AS day, status, reasons, reviewed_at IS NOT NULL AS reviewed FROM cloud_flags WHERE account_id = $1 ORDER BY day_key', [accountId]);
      const row = found.rows[0]!;
      return {accountId, alias: row.alias, tokens: safe(row.tokens), days: row.days, devices: row.devices, banned: row.banned, flags: flags.rows};
    });
  }

  /**
   * A person's decision on one day of one named member. Clearing records the day's current total as the reviewed total,
   * so the day is flagged again only once it has grown well past what was looked at.
   */
  async reviewFlag(alias: string, day: string, status: 'cleared' | 'hidden', note: string): Promise<void> {
    if (note.trim().length === 0 || note.trim().length > 500) invalid('A note of 1–500 characters is required');
    const accountId = await this.accountForAlias(alias);
    await this.transaction(accountId, async client => {
      const flagged = await client.query<{tokens: string}>('SELECT tokens FROM cloud_flags WHERE account_id = $1 AND day_key = $2', [accountId, day]);
      const updated = await client.query<{tokens: string}>(`UPDATE cloud_flags f SET status = $3, reviewed_at = $4, note = $5,
          tokens = CASE WHEN $3 = 'cleared' THEN coalesce((SELECT t.tokens FROM (${bucketTotals('b.account_id = f.account_id AND b.day_key = f.day_key')}) t), 0) ELSE f.tokens END
        WHERE f.account_id = $1 AND f.day_key = $2 RETURNING f.tokens`, [accountId, day, status, this.now(), note.trim()]);
      if (!updated.rowCount) throw new CloudError(404, 'NOT_FOUND', 'No flag for this member and day');
      // A best rank reached with a day a person hid, or with a total the member has since corrected downwards, is not kept.
      if (status === 'hidden' || safe(updated.rows[0]!.tokens) < safe(flagged.rows[0]!.tokens)) {
        await client.query('UPDATE cloud_publications SET best_rank = NULL WHERE account_id = $1', [accountId]);
        await this.refreshBadges(client, accountId);
      }
    });
  }

  async moderationAudit(): Promise<ModerationAudit> {
    return this.operatorRead(async client => {
      const counts = await client.query<ModerationAudit>(`SELECT
        (SELECT count(*)::int FROM cloud_flags WHERE status = 'hidden' AND reviewed_at IS NULL AND detected_at < $1) AS "staleHidden",
        (SELECT count(*)::int FROM cloud_flags WHERE status = 'review' AND reviewed_at IS NULL) AS "openReviews",
        (SELECT count(*)::int FROM cloud_bans) AS bans,
        (SELECT count(*)::int FROM cloud_bans b JOIN cloud_accounts a ON a.id = b.account_id
          WHERE NOT EXISTS (SELECT 1 FROM cloud_flags f WHERE f.account_id = b.account_id)) AS "bansWithoutFlag"`,
      [new Date(this.now().getTime() - this.rules.LIMITS.reviewWithinMs)]);
      return counts.rows[0]!;
    });
  }

  private async operatorRead<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL search_path TO ${this.schema}, pg_catalog`);
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  /** Bans one named member: every publishing route refuses them, their computers are revoked and open flags are closed. */
  async ban(alias: string, reason: string): Promise<{accountId: string; devicesRevoked: number}> {
    if (reason.trim().length === 0 || reason.trim().length > 500) invalid('A reason of 1–500 characters is required');
    const accountId = await this.accountForAlias(alias);
    return this.transaction(accountId, async client => {
      await client.query('INSERT INTO cloud_bans(account_id, reason) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET reason = EXCLUDED.reason', [accountId, reason.trim()]);
      const revoked = await client.query('UPDATE cloud_devices SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [accountId]);
      await client.query(`UPDATE cloud_flags SET reviewed_at = now(), note = 'banned' WHERE account_id = $1 AND reviewed_at IS NULL`, [accountId]);
      // A ban clears the account's stored badges and best rank.
      await client.query('DELETE FROM cloud_badges WHERE account_id = $1', [accountId]);
      await client.query('UPDATE cloud_publications SET best_rank = NULL WHERE account_id = $1', [accountId]);
      return {accountId, devicesRevoked: revoked.rowCount ?? 0};
    });
  }

  /** Every member's badges again, each under its account lock: after migration 0009 and after any `BADGE_TIERS` change. */
  async recomputeAllBadges(): Promise<number> {
    const accounts = await this.pool.query<{account_id: string}>(`SELECT account_id FROM ${this.schema}.cloud_publications ORDER BY account_id`);
    let count = 0;
    for (const {account_id: accountId} of accounts.rows) if (await this.transaction(accountId, client => this.refreshBadges(client, accountId))) count++;
    return count;
  }

  /** Takes the account id because a banned member may have deleted their account and alias. Revoked computers stay revoked. */
  async unban(accountId: string): Promise<void> {
    await this.transaction(accountId, async client => {
      if (!(await client.query('DELETE FROM cloud_bans WHERE account_id = $1', [accountId])).rowCount) throw new CloudError(404, 'NOT_FOUND', 'No ban for this account');
    });
  }

  private async accountForAlias(alias: string): Promise<string> {
    const found = await this.pool.query<{account_id: string}>(`SELECT account_id FROM ${this.schema}.cloud_publications WHERE alias = $1`, [alias.toLowerCase()]);
    if (!found.rows[0]) throw profileNotFound();
    return found.rows[0].account_id;
  }
}
