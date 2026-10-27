import {TEST_MODERATION_POLICY} from './moderation-policy.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import { Pool, type PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { BADGE_IDS } from '@tokentracky/core';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudError, createAccountVerifier, migrateCloud, migrationsDirectory, moderationCommand, PostgresCloudRepository, registerCloudRoutes, supabaseGithubLogin, type AccountIdentity } from '../src/index.ts';
import type { ModerationEvent } from '../src/moderation.ts';
import { totalTokens } from '@tokentracky/core';

const databaseUrl = process.env.TEST_DATABASE_URL;
const now = new Date('2026-10-23T12:00:00.000Z');
const collectorId = '11111111-1111-4111-8111-111111111111';
const identities: Record<string, AccountIdentity> = {
  alice: {issuer: 'https://identity.test', subject: 'alice-private-subject'},
  bob: {issuer: 'https://identity.test', subject: 'bob-private-subject'},
  carol: {issuer: 'https://identity.test', subject: 'carol-private-subject'},
  ...Object.fromEntries(Array.from({length: 8}, (_, index) => [`peer${index + 1}`, {issuer: 'https://identity.test', subject: `peer-${index + 1}-private-subject`}])),
};
const publish = (alias: string) => ({alias});
/** The version of `NNNN_fixed_sharing.sql`, so a renumbered file keeps these tests pointed at it. */
const fixedSharing = Number(readdirSync(migrationsDirectory()).find(name => /^\d{4}_fixed_sharing\.sql$/.test(name))!.slice(0, 4));
const bucket = (tokens: number, extra = {}) => ({day: '2026-10-23', tool: 'all', tokens, costMicrousd: null, revision: 1, ...extra});
const kinds = (input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number) => ({input, output, cacheRead, cacheWrite, reasoning});
// Public 14-day activity: nothing, or the given tokens on the test's "today".
const quiet = Array(14).fill(0);
const today = (tokens: number) => [...Array(13).fill(0), tokens];
/** Returns a migrated schema to version 11: one active computer per account. */
const BEFORE_MULTI_COMPUTER = `DROP VIEW cloud_public_exclusions; DROP VIEW cloud_invalid_counter_accounts; DELETE FROM cloud_migrations WHERE version = 15; DROP VIEW cloud_account_buckets; DROP INDEX cloud_one_active_machine;
  ALTER TABLE cloud_devices DROP COLUMN machine_id; ALTER TABLE cloud_device_authorizations DROP COLUMN machine_id;
  ALTER TABLE cloud_buckets DROP CONSTRAINT cloud_buckets_pkey; ALTER TABLE cloud_buckets ADD PRIMARY KEY (account_id, day_key, tool, model);
  CREATE UNIQUE INDEX cloud_one_active_device ON cloud_devices(account_id) WHERE revoked_at IS NULL; DELETE FROM cloud_migrations WHERE version = 12;`;

describe.skipIf(!databaseUrl)('actual PostgreSQL hosted routes', () => {
  const schema = `cloud_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let repository: PostgresCloudRepository;
  let app: FastifyInstance;
  const events: ModerationEvent[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/tokentracky_test' || url.username !== 'tokentracky') throw new Error('Tests require the manager-provided isolated PostgreSQL database on 127.0.0.1');
    admin = new Pool({connectionString: databaseUrl, max: 2});
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, application_name: schema, max: 12});
    await migrateCloud(pool, {schema});
    repository = new PostgresCloudRepository(pool, () => now, schema, event => events.push(event), TEST_MODERATION_POLICY);
    app = Fastify();
    await registerCloudRoutes(app, {repository, verifyAccount: async token => {
      const identity = identities[token];
      if (!identity) throw new CloudError(401, 'UNAUTHORIZED', 'Invalid account token');
      return identity;
    }});
    await app.ready();
  });
  beforeEach(async () => { await pool.query('TRUNCATE cloud_accounts, cloud_bans CASCADE'); events.length = 0; });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  const receipts=new Map<string,{generation:string;receipt:string}>();
  async function request(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, token?: string, payload?: unknown) {
    if (url === '/api/ingest' && payload && typeof payload === 'object') {
      const batches = (payload as {buckets?:Array<{revision?:number}>}).buckets;
      const generation=(payload as {generation?:string}).generation;
      const prior=receipts.get(token ?? '');
      payload = {collectorId,checkpoint:Math.max(0,...(Array.isArray(batches)?batches.map(b=>b.revision ?? 0):[])),baseReceipt:prior && prior.generation===generation ? prior.receipt : null,receipt:randomUUID(),...payload};
    }
    const response=await app.inject({method, url, ...(token ? {headers: {authorization: `Bearer ${token}`}} : {}), ...(payload !== undefined ? {payload: payload as object} : {})});
    if (url === '/api/ingest' && response.statusCode === 200) receipts.set(token!,payload as {generation:string;receipt:string});
    return response;
  }
  async function joined(who = 'alice', alias = who) {
    const publication = (await request('PUT', '/api/publication', who, publish(alias))).json().publication;
    const device = await addComputer(who, 'Publishing desktop');
    return {publication, device};
  }
  async function upload(join: {publication: {generation: string}; device: {token: string}}, buckets: unknown[] = [bucket(100)], hours?: unknown[]) {
    return request('POST', '/api/ingest', join.device.token, {generation: join.publication.generation, buckets, ...(hours ? {hours} : {})});
  }
  async function board(query = '') { return (await request('GET', `/api/leaderboard?period=all${query}`)).json(); }

  it('returns device publication without account identity and fails after account deletion or revocation', async () => {
    const join = await joined();
    const policy = await request('GET', '/api/device-policy', join.device.token);
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toEqual({publication:join.publication});
    expect((await request('GET', '/api/device-policy', 'invalid')).statusCode).toBe(401);
    await request('DELETE', '/api/account', 'alice');
    expect([401,409]).toContain((await request('GET', '/api/device-policy', join.device.token)).statusCode);
    const next = await joined();
    await request('DELETE', '/api/devices/'+next.device.id, 'alice');
    expect((await request('GET', '/api/device-policy', next.device.token)).statusCode).toBe(401);
  });

  it('migrates a fresh schema and replays without destroying records', async () => {
    const join = await joined();
    expect((await upload(join)).statusCode).toBe(200);
    await Promise.all([migrateCloud(pool, {schema}), migrateCloud(pool, {schema})]);
    const versions = readdirSync(migrationsDirectory()).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort().map(name => ({version: Number(name.slice(0, 4))}));
    expect((await pool.query('SELECT version FROM cloud_migrations ORDER BY version')).rows).toEqual(versions);
    expect((await board()).items[0].tokens).toBe(100);
  });
  it('refuses duplicate migration versions even when that number has already been applied', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-applied-duplicate-'));
    const before = (await pool.query('SELECT version FROM cloud_migrations ORDER BY version')).rows;
    try {
      cpSync(migrationsDirectory(), directory, {recursive: true});
      writeFileSync(join(directory, '0008_conflicting_branch.sql'), 'DROP TABLE cloud_accounts CASCADE;');
      await expect(migrateCloud(pool, {schema, directory})).rejects.toThrow('Duplicate cloud migration version 8');
      expect((await pool.query('SELECT version FROM cloud_migrations ORDER BY version')).rows).toEqual(before);
      expect((await pool.query("SELECT to_regclass('cloud_accounts') IS NOT NULL AS present")).rows[0].present).toBe(true);
    } finally { rmSync(directory, {recursive: true, force: true}); }
  });
  it('adds a GitHub login, a best rank, stored badges and likes that cannot be self-likes', async () => {
    await joined('alice');
    await joined('bob');
    const columns = await pool.query<{table_name: string; column_name: string}>(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name IN ('cloud_accounts', 'cloud_publications', 'cloud_badges', 'cloud_likes') ORDER BY table_name, ordinal_position`, [schema]);
    const of = (table: string) => columns.rows.filter(row => row.table_name === table).map(row => row.column_name);
    expect(of('cloud_accounts')).toContain('github_login');
    expect(of('cloud_publications')).toContain('best_rank');
    expect(of('cloud_badges')).toEqual(['account_id', 'badge', 'tier', 'value', 'computed_at']);
    expect(of('cloud_likes')).toEqual(['liker_id', 'target_id', 'created_at']);
    const indexes = await pool.query<{indexname: string}>(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname IN ('cloud_likes_target', 'cloud_buckets_model_day') ORDER BY 1`, [schema]);
    expect(indexes.rows.map(row => row.indexname)).toEqual(['cloud_buckets_model_day', 'cloud_likes_target']);
    const [alice, bob] = [accountId('alice'), accountId('bob')];
    await expect(pool.query('INSERT INTO cloud_likes(liker_id, target_id) VALUES ($1, $1)', [alice])).rejects.toMatchObject({code: '23514'});
    await pool.query('INSERT INTO cloud_likes(liker_id, target_id) VALUES ($1, $2)', [bob, alice]);
    await pool.query(`INSERT INTO cloud_badges(account_id, badge, tier, value) VALUES ($1, 'token-titan', 4, 100000000000) ON CONFLICT (account_id, badge) DO UPDATE SET tier = 4`, [alice]);
    for (const [sql, values] of [
      [`UPDATE cloud_accounts SET github_login = '-octo' WHERE id = $1`, [alice]],
      [`UPDATE cloud_publications SET best_rank = 0 WHERE account_id = $1`, [alice]],
      [`INSERT INTO cloud_badges(account_id, badge, tier, value) VALUES ($1, 'Token Titan', 1, 1)`, [bob]],
      [`INSERT INTO cloud_badges(account_id, badge, tier, value) VALUES ($1, 'streak', 5, 1)`, [bob]],
    ] as const) await expect(pool.query(sql, [...values])).rejects.toMatchObject({code: '23514'});
    await pool.query(`UPDATE cloud_accounts SET github_login = 'octo-cat' WHERE id = $1`, [alice]);
    // Deleting an account removes its badges and the likes it received.
    await request('DELETE', '/api/account', 'alice');
    expect((await pool.query('SELECT 1 FROM cloud_badges WHERE account_id = $1 UNION ALL SELECT 1 FROM cloud_likes WHERE target_id = $1', [alice])).rowCount).toBe(0);
  });
  it('widens the bucket tool constraint for the batch 1 tools once, on schemas created before version 4', async () => {
    await pool.query(`ALTER TABLE cloud_buckets DROP CONSTRAINT cloud_buckets_tool_check;
      ALTER TABLE cloud_buckets ADD CONSTRAINT cloud_buckets_tool_check CHECK (tool IN ('all', 'claude', 'codex', 'cursor', 'gemini'));
      DELETE FROM cloud_migrations WHERE version = 4;`);
    const join = await joined();
    expect((await upload(join, [bucket(5, {tool: 'opencode'})])).statusCode).not.toBe(200);
    await migrateCloud(pool, {schema}); await migrateCloud(pool, {schema});
    const tools = ['gemini', 'cline', 'roo', 'kilo', 'opencode'];
    expect((await upload(join, tools.map((tool, index) => bucket(10 + index, {tool, revision: 2})))).statusCode).toBe(200);
    expect((await board()).toolTotals).toEqual({gemini: 10, cline: 11, roo: 12, kilo: 13, opencode: 14});
    expect((await request('GET', '/api/leaderboard?period=all&tool=kilo')).json().items[0].tokens).toBe(13);
  });

  it('upgrades a schema from before model sharing without losing published totals', async () => {
    const join = await joined();
    expect((await upload(join)).statusCode).toBe(200);
    await pool.query(`${BEFORE_MULTI_COMPUTER} DELETE FROM cloud_migrations WHERE version = 5; ALTER TABLE cloud_buckets DROP COLUMN model;
      ALTER TABLE cloud_buckets ADD PRIMARY KEY (account_id, day_key, tool); ALTER TABLE cloud_publications DROP COLUMN share_models`);
    await migrateCloud(pool, {schema});
    expect((await pool.query("SELECT model, tokens FROM cloud_buckets")).rows).toEqual([{model: '', tokens: '100'}]);
    expect((await request('GET', '/api/device-policy', join.device.token)).json().publication.shareModels).toBe(false);
    expect((await board()).items[0].tokens).toBe(100);
  });

  /** Applies the fixed-sharing migration again, as on a database whose publications were saved before it. */
  async function rerunFixedSharing() {
    await pool.query('DELETE FROM cloud_migrations WHERE version = $1', [fixedSharing]);
    await migrateCloud(pool, {schema});
  }

  it('widens each publication with a history cutoff or a share flag off once, with a new generation and no old buckets', async () => {
    const wide = await joined('alice');
    expect((await upload(wide, [bucket(500, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 40})])).statusCode).toBe(200);
    // Publications as saved before sharing was fixed, each narrower in one way, with buckets in their scope.
    const narrowed = [];
    for (const [who, change] of [['bob', `history_start = '2026-10-19T00:00:00Z'`], ['carol', 'share_tools = false'], ['peer1', 'share_cost = false'], ['peer2', 'share_models = false']] as const) {
      const join = await joined(who);
      await pool.query(`UPDATE cloud_publications SET ${change} WHERE alias = $1`, [who]);
      expect((await upload(join, [bucket(100)])).statusCode).toBe(200);
      narrowed.push(join);
    }
    const untouched = async () => [
      (await pool.query(`SELECT * FROM cloud_publications WHERE alias = 'alice'`)).rows,
      (await pool.query('SELECT * FROM cloud_buckets WHERE device_id = $1', [wide.device.id])).rows,
      (await pool.query('SELECT collector_id, receipt, checkpoint FROM cloud_devices WHERE id = $1', [wide.device.id])).rows,
      (await request('GET', '/api/profiles/alice/stats')).json(),
    ];
    const before = await untouched();
    await rerunFixedSharing();
    for (const join of narrowed) {
      const {publication} = (await request('GET', '/api/device-policy', join.device.token)).json();
      expect(publication).toEqual({alias: join.publication.alias, historyStart: null, shareTools: true, shareCost: true, shareModels: true, generation: expect.any(String)});
      expect(publication.generation).not.toBe(join.publication.generation);
      expect((await pool.query('SELECT 1 FROM cloud_buckets WHERE device_id = $1', [join.device.id])).rowCount).toBe(0);
      expect((await pool.query('SELECT collector_id, receipt, checkpoint FROM cloud_devices WHERE id = $1', [join.device.id])).rows).toEqual([{collector_id: null, receipt: null, checkpoint: '0'}]);
      // The collector is refused under the old generation; once it reconnects, it uploads the whole scope afresh.
      expect((await upload(join)).json().error.code).toBe('STALE_PUBLICATION');
      expect((await upload({...join, publication}, [bucket(100, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 9, revision: 2})])).statusCode).toBe(200);
    }
    expect(await untouched()).toEqual(before);
    expect((await upload(wide, [bucket(600, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 50, revision: 2})])).statusCode).toBe(200);
    // Once is enough: a publication it already widened is wide, so running it again changes nothing.
    const generations = (await pool.query('SELECT alias, generation FROM cloud_publications ORDER BY alias')).rows;
    await rerunFixedSharing();
    expect((await pool.query('SELECT alias, generation FROM cloud_publications ORDER BY alias')).rows).toEqual(generations);
  });

  it('leaves every hosted total unchanged when each publication is already wide', async () => {
    await upload(await joined('alice'), [bucket(500, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 40}),
      bucket(70, {tool: 'codex', model: 'gpt-5-codex', day: '2026-10-20'}), bucket(9, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 1, day: null})]);
    await upload(await joined('bob'), [bucket(300, {costMicrousd: 12}), bucket(40, {day: '2026-09-02'})]);
    await upload(await joined('carol'), [bucket(120, {tool: 'gemini', costMicrousd: 3, day: '2026-10-22'})]);
    const snapshot = async () => {
      const reads: unknown[] = [await repository.community()];
      for (const period of ['week', 'month', 'all']) {
        for (const query of ['', '&tool=claude', '&tool=codex', '&tool=gemini', '&sort=cost']) reads.push((await request('GET', `/api/leaderboard?period=${period}${query}`)).json());
      }
      for (const alias of ['alice', 'bob', 'carol']) {
        reads.push((await request('GET', `/api/profiles/${alias}/stats`)).json());
        for (const period of ['week', 'month', 'all']) reads.push((await request('GET', `/api/profiles/${alias}?period=${period}`)).json());
        for (const metric of ['tokens', 'cost', 'rank']) reads.push((await request('GET', `/badge/${alias}.svg?metric=${metric}`)).body);
      }
      reads.push((await pool.query('SELECT * FROM cloud_publications ORDER BY alias')).rows, (await pool.query('SELECT * FROM cloud_buckets ORDER BY account_id, day_key, tool, model')).rows,
        (await pool.query('SELECT id, collector_id, receipt, checkpoint FROM cloud_devices ORDER BY id')).rows);
      return reads;
    };
    const before = await snapshot();
    expect(before[0]).toMatchObject({builders: 3, totalTokens: 1039, toolTotals: {claude: 509, codex: 70, gemini: 120}});
    await rerunFixedSharing();
    expect(await snapshot()).toEqual(before);
  });

  it('publishes the model mix of every member, never mixed with totals on the same day', async () => {
    const on = await joined('bob');
    expect(on.publication.shareModels).toBe(true);
    const split = [
      bucket(600, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 900}),
      bucket(300, {tool: 'codex', model: 'gpt-5-codex', costMicrousd: 100}),
      bucket(50, {day: '2026-10-22', tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 50}),
    ];
    expect((await upload(on, split)).statusCode).toBe(200);
    expect((await board()).items[0]).toMatchObject({alias: 'bob', tokens: 950, toolTokens: {claude: 650, codex: 300}, costMicrousd: 1050});
    expect((await upload(on, [bucket(10, {tool: 'claude', revision: 2})])).json().error.message).toBe('A day cannot combine aggregated and split buckets');
    for (const model of ['has space', '', 'a|b', 'x'.repeat(129)]) expect((await upload(on, [bucket(1, {tool: 'claude', model})])).statusCode, model).toBe(400);
    const stats = (await request('GET', '/api/profiles/BOB/stats')).json();
    expect(stats).toMatchObject({alias: 'bob', periods: {week: {rank: 1, tokens: 950, builders: 1}, month: {rank: 1, tokens: 950, builders: 1}, all: {rank: 1, tokens: 950, builders: 1}},
      toolTokens: {claude: 650, codex: 300}, costMicrousd: 1050,
      models: [{model: 'claude-sonnet-4-6', tokens: 650, costMicrousd: 950}, {model: 'gpt-5-codex', tokens: 300, costMicrousd: 100}],
      activity: {activeDays: 2, currentStreak: 2, longestStreak: 2, bestDay: {day: '2026-10-23', tokens: 900}}});
    expect(stats.daily).toHaveLength(365);
    expect(stats.daily.slice(-2)).toEqual([{day: '2026-10-22', tokens: 50}, {day: '2026-10-23', tokens: 900}]);
    // A member with nothing synced yet still has every published field, empty.
    await joined('carol', 'carol');
    expect((await request('GET', '/api/profiles/carol/stats')).json()).toMatchObject({toolTokens: {}, costMicrousd: null, models: [], likes: 0, badges: expect.any(Array)});
    expect((await request('GET', '/api/profiles/nobody/stats')).statusCode).toBe(404);
    expect((await request('GET', '/api/profiles/bob/stats?x=1')).statusCode).toBe(400);
  });

  it('counts visits from tagged links per UTC day and tag, and nothing else', async () => {
    for (const tag of ['share', 'share', 'readme']) expect((await request('POST', '/api/visits', undefined, {tag})).statusCode).toBe(204);
    for (const payload of [{tag: 'twitter'}, {tag: 'share', alias: 'bob'}, {}]) expect((await request('POST', '/api/visits', undefined, payload)).statusCode).toBe(400);
    const rows = await pool.query(`SELECT day::text, tag, count::int FROM ${schema}.cloud_share_visits ORDER BY tag`);
    expect(rows.rows).toEqual([{day: '2026-10-23', tag: 'readme', count: 1}, {day: '2026-10-23', tag: 'share', count: 2}]);
    const columns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'cloud_share_visits' ORDER BY ordinal_position`, [schema]);
    expect(columns.rows.map(row => row.column_name)).toEqual(['day', 'tag', 'count']);
  });

  it('upgrades a schema from before token types without changing published totals', async () => {
    const join = await joined();
    expect((await upload(join)).statusCode).toBe(200);
    await pool.query(`${BEFORE_MULTI_COMPUTER} DELETE FROM cloud_migrations WHERE version = 8; ALTER TABLE cloud_buckets DROP COLUMN input_tokens, DROP COLUMN output_tokens,
      DROP COLUMN cache_read_tokens, DROP COLUMN cache_write_tokens, DROP COLUMN reasoning_tokens`);
    await migrateCloud(pool, {schema});
    expect((await pool.query('SELECT tokens, input_tokens, reasoning_tokens FROM cloud_buckets')).rows).toEqual([{tokens: '100', input_tokens: null, reasoning_tokens: null}]);
    expect((await board()).items[0].tokens).toBe(100);
    expect((await upload(join, [bucket(100, {revision: 2, breakdown: kinds(10, 20, 30, 40, 5)})])).statusCode).toBe(200);
    expect((await request('GET', '/api/profiles/alice/stats')).json().breakdown).toEqual(kinds(10, 20, 30, 40, 5));
  });

  it('refuses token types that do not add up, and still accepts buckets without them', async () => {
    const join = await joined('alice', 'alice');
    const refused = [kinds(10, 20, 30, 39, 0), kinds(10, 20, 30, 40, 21), {...kinds(10, 20, 30, 40, 5), cacheWrite1h: 10}, {...kinds(10, 20, 30, 40, 5), other: 0},
      {input: 10, output: 20, cacheRead: 30, cacheWrite: 40}, {...kinds(10, 20, 30, 40, 5), input: '10'}, kinds(10.5, 19.5, 30, 40, 0), kinds(-10, 40, 30, 40, 0), null, [10, 20, 30, 40, 5]];
    for (const breakdown of refused) {
      const response = await upload(join, [bucket(100, {tool: 'claude', breakdown})]);
      expect(response.statusCode, JSON.stringify(breakdown)).toBe(400);
      expect(response.json().error.message, JSON.stringify(breakdown)).toBe('Invalid token types');
    }
    expect((await upload(join, [bucket(100, {tool: 'claude'})])).statusCode).toBe(200);
    expect((await pool.query('SELECT tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM cloud_buckets')).rows)
      .toEqual([{tokens: '100', input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null}]);
    // The database holds the same rules: all five or none, adding up, reasoning within output.
    for (const change of ['input_tokens = 10', `input_tokens = 10, output_tokens = 20, cache_read_tokens = 30, cache_write_tokens = 39, reasoning_tokens = 0`,
      `input_tokens = 10, output_tokens = 20, cache_read_tokens = 30, cache_write_tokens = 40, reasoning_tokens = 21`]) {
      await expect(pool.query(`UPDATE cloud_buckets SET ${change}`), change).rejects.toMatchObject({code: '23514'});
    }
  });

  it('splits profiles and the community by token type, only where every bucket carries types', async () => {
    expect((await repository.community()).breakdown).toBeNull();
    const alice = await joined('alice', 'alice');
    const bob = await joined('bob', 'bob');
    expect((await upload(alice, [bucket(100, {tool: 'claude', breakdown: kinds(10, 20, 30, 40, 5)}), bucket(50, {tool: 'codex', day: null, breakdown: kinds(5, 25, 15, 5, 25)})])).statusCode).toBe(200);
    expect((await upload(bob, [bucket(200, {day: '2026-10-20', breakdown: kinds(100, 50, 50, 0, 0)})])).statusCode).toBe(200);
    const profile = (await request('GET', '/api/profiles/alice/stats')).json();
    expect(profile.breakdown).toEqual(kinds(15, 45, 45, 45, 30));
    expect(totalTokens(profile.breakdown)).toBe(profile.periods.all.tokens);
    const community = await repository.community();
    expect(community.breakdown).toEqual(kinds(115, 95, 95, 45, 30));
    expect(totalTokens(community.breakdown!)).toBe(community.totalTokens);
    // One of Bob's buckets comes from an app from before types: his profile has no split, and the community split leaves that bucket out.
    expect((await upload(bob, [bucket(70, {day: '2026-10-21', revision: 2})])).statusCode).toBe(200);
    const untyped = (await request('GET', '/api/profiles/bob/stats')).json();
    expect(untyped.periods.all.tokens).toBe(270);
    expect(untyped).not.toHaveProperty('breakdown');
    const partial = await repository.community();
    expect(partial.totalTokens).toBe(420);
    expect(partial.breakdown).toEqual(community.breakdown);
    // A newer revision of a typed bucket without types clears them.
    expect((await upload(alice, [bucket(100, {tool: 'claude', revision: 2})])).statusCode).toBe(200);
    expect((await request('GET', '/api/profiles/alice/stats')).json()).not.toHaveProperty('breakdown');
    expect((await repository.community()).breakdown).toEqual(kinds(105, 75, 65, 5, 25));
  });

  it('serves cached community totals, a cost sort and SVG badges', async () => {
    await upload(await joined('alice'), [bucket(100, {model: 'claude-sonnet-4-6', costMicrousd: 5_000})]);
    await upload(await joined('bob'), [bucket(300, {model: 'claude-sonnet-4-6', costMicrousd: 1_000})]);
    const community = await request('GET', '/api/community');
    expect(community.headers['cache-control']).toBe('public, max-age=60');
    expect(community.json()).toMatchObject({builders: 2, totalTokens: 400, totalCostMicrousd: 6_000, toolTotals: {}});
    expect(community.json().trend.at(-1)).toEqual({day: '2026-10-23', tokens: 400});
    expect((await request('GET', '/api/leaderboard?period=all')).headers['cache-control']).toBe('no-store');
    expect((await request('GET', '/api/community?period=week')).statusCode).toBe(400);
    expect((await board('&q=ali')).builders).toBe(2);
    expect((await board('&sort=cost')).items.map((item: {alias: string; rank: number}) => [item.alias, item.rank])).toEqual([['alice', 2], ['bob', 1]]);
    expect((await request('GET', '/api/leaderboard?sort=name')).statusCode).toBe(400);
    const badge = await request('GET', '/badge/bob.svg');
    expect(badge.statusCode).toBe(200);
    expect(badge.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(badge.headers['cache-control']).toBe('public, max-age=60');
    expect(badge.body).toContain('>300 tokens<');
    expect((await request('GET', '/badge/alice.svg?metric=cost')).body).toContain('>$0.01<');
    expect((await request('GET', '/badge/bob.svg?metric=rank&period=week')).body).toContain('>#1 this week<');
    expect((await request('GET', '/badge/nobody.svg')).body).toContain('>private<');
    expect((await request('GET', '/badge/bob.svg?metric=streak')).statusCode).toBe(400);
    expect((await request('GET', '/badge/bob.png')).statusCode).toBe(404);
    const styled = (await request('GET', '/badge/bob.svg?style=flat-square&label=AI%20tokens&color=ff8800')).body;
    expect(styled).toContain('>AI tokens<');
    expect(styled).toContain('fill="#ff8800"');
    expect(styled).toContain('rx="0"');
    for (const query of ['style=plastic', 'color=%23ff8800', `label=${'x'.repeat(31)}`, 'label=%3Cb%3E&label=x']) expect((await request('GET', `/badge/bob.svg?${query}`)).statusCode).toBe(400);
    expect((await request('GET', '/badge/bob.svg?label=%3Cscript%3E')).body).toContain('&#60;script&#62;');
    const card = await request('GET', '/card/bob.svg?theme=light&period=week');
    expect(card.statusCode).toBe(200);
    expect(card.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(card.headers['cache-control']).toBe('public, max-age=60');
    expect(card.body).toContain('>bob<');
    expect(card.body).toContain('>This week<');
    expect((await request('GET', '/card/nobody.svg')).body).toContain('>private<');
    for (const query of ['theme=blue', 'period=year', 'size=2']) expect((await request('GET', `/card/bob.svg?${query}`)).statusCode).toBe(400);
    expect((await request('GET', '/card/bob.png')).statusCode).toBe(404);
  });

  it('denies SQL access to untrusted roles with ACLs and RLS as defense in depth', async () => {
    await joined();
    const role = `cloud_role_${randomUUID().replaceAll('-', '')}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      await client.query("INSERT INTO cloud_bans(account_id, reason) SELECT id, 'Synthetic isolation test' FROM cloud_accounts");
      const denied = async () => {
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query('SAVEPOINT denied');
        for (const relation of ['cloud_accounts', 'cloud_account_buckets', 'cloud_account_hours', 'cloud_invalid_counter_accounts', 'cloud_public_exclusions']) {
          await expect(client.query(`SELECT * FROM ${schema}.${relation}`)).rejects.toMatchObject({code: '42501'});
          await client.query('ROLLBACK TO SAVEPOINT denied');
        }
        await client.query('RESET ROLE');
      };
      // Neither schema usage nor table read is inherited from PUBLIC.
      await denied();
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await denied();
      // Even accidental table grants cannot expose rows without an explicit RLS policy.
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      expect((await client.query(`SELECT * FROM ${schema}.cloud_accounts`)).rows).toEqual([]);
      expect((await client.query(`SELECT * FROM ${schema}.cloud_devices`)).rows).toEqual([]);
      // Integrity views execute with the caller's access and cannot bypass the underlying RLS.
      for (const view of ['cloud_account_buckets', 'cloud_account_hours', 'cloud_invalid_counter_accounts', 'cloud_public_exclusions']) {
        expect((await client.query(`SELECT * FROM ${schema}.${view}`)).rows).toEqual([]);
      }
      await client.query('RESET ROLE');
      const rls = await client.query<{relname: string; relrowsecurity: boolean}>(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = $1::regnamespace AND relkind = 'r'`, [schema]);
      expect(rls.rows).toHaveLength(13);
      expect(rls.rows.every(row => row.relrowsecurity)).toBe(true);
    } finally {
      // CREATE ROLE and all grants are transactional; rollback removes only this test role.
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount).toBe(0);
  });

  it('requires account auth and never publishes account creation alone', async () => {
    expect((await request('GET', '/api/account')).statusCode).toBe(401);
    expect((await request('GET', '/api/account', 'forged')).statusCode).toBe(401);
    expect((await request('GET', '/api/account', 'alice')).json()).toEqual({publication: null, devices: []});
    expect((await board()).items).toEqual([]);
    expect((await request('GET', '/api/profiles/alice')).statusCode).toBe(404);
    const missing = Fastify();
    await registerCloudRoutes(missing, {repository});
    expect((await missing.inject('/api/account')).statusCode).toBe(503);
    expect((await missing.inject({method: 'PUT', url: '/api/publication', payload: publish('alice')})).json().error.code).toBe('AUTH_NOT_CONFIGURED');
    await missing.close();
  });

  it('isolates account ownership, returns credentials once, and renames only your own computers', async () => {
    const join = await joined();
    expect(join.device.token).toMatch(/^ttd_[A-Za-z0-9_-]{43}$/);
    const stored = (await pool.query('SELECT token_hash FROM cloud_devices')).rows[0].token_hash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(join.device.token);
    const account = (await request('GET', '/api/account', 'alice')).json();
    expect(account.devices).toEqual([{id: join.device.id, name: 'Publishing desktop', lastSeenAt: null}]);
    expect(JSON.stringify(account)).not.toContain(join.device.token);
    expect((await request('GET', '/api/account', 'bob')).json()).toEqual({publication: null, devices: []});
    expect((await request('DELETE', `/api/devices/${join.device.id}`, 'bob')).statusCode).toBe(404);
    expect((await request('PUT', `/api/devices/${join.device.id}`, 'bob', {name: 'Mine now'})).statusCode).toBe(404);
    for (const body of [{name: ''}, {name: 'x'.repeat(81)}, {name: 'Mac', extra: true}, {}]) expect((await request('PUT', `/api/devices/${join.device.id}`, 'alice', body)).statusCode).toBe(400);
    expect((await request('PUT', `/api/devices/${join.device.id}`, 'alice', {name: '  Studio Mac '})).statusCode).toBe(204);
    expect((await request('GET', '/api/account', 'alice')).json().devices).toEqual([{id: join.device.id, name: 'Studio Mac', lastSeenAt: null}]);
    await request('DELETE', `/api/devices/${join.device.id}`, 'alice');
    expect((await request('PUT', `/api/devices/${join.device.id}`, 'alice', {name: 'Removed'})).statusCode).toBe(404);
    expect((await request('POST', '/api/ingest', 'alice', {generation: join.publication.generation, buckets: []})).statusCode).toBe(401);
    expect((await request('GET', '/api/account', join.device.token)).statusCode).toBe(401);
    expect((await request('PUT', '/api/publication', 'bob', publish('ALICE'))).statusCode).toBe(409);
  });

  it('takes only an alias, rejecting consent, history and sharing fields, and enforces payload allowlists', async () => {
    const removed = [{consent: true}, {historyStart: null}, {historyStart: '2026-10-19T00:00:00.000Z'}, {shareTools: true}, {shareCost: true}, {shareModels: true}, {shareTools: false}];
    for (const extra of [...removed, {historyStart: null, shareTools: true, shareCost: true, shareModels: true, consent: true}, {email: 'private@test'}]) {
      const response = await request('PUT', '/api/publication', 'alice', {...publish('alice'), ...extra});
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
      expect(response.json().error.message).toBe('Unknown request field');
    }
    for (const payload of [publish('bad alias'), {}, []]) expect((await request('PUT', '/api/publication', 'alice', payload)).statusCode).toBe(400);
    expect((await request('GET', '/api/account', 'alice')).json().publication).toBeNull();
    const join = await joined();
    for (const bad of [bucket(1, {projectId: 'secret'}), bucket(1, {sessionHash: 'secret'}), bucket(1, {revision: -1}), bucket(1, {revision: 1.5}), bucket(Number.MAX_SAFE_INTEGER + 1), bucket(-1), bucket(1.2), bucket(1, {costMicrousd: Number.MAX_SAFE_INTEGER + 1}), bucket(1, {day: '2026-02-30'}), bucket(1, {day: '2026-10-24'}), bucket(1, {day: '2026-10-23T12:00:00Z'}), bucket(1, {tool: 'private-tool'}), {day: '2026-10-23', tool: 'all', tokens: 1, revision: 1}]) {
      expect((await upload(join, [bad as ReturnType<typeof bucket>])).statusCode).toBe(400);
    }
    expect((await upload(join, [bucket(1), bucket(2)])).statusCode).toBe(400);
    expect((await request('POST', '/api/ingest', join.device.token, {generation: join.publication.generation, buckets: [], project: 'private'})).statusCode).toBe(400);
    expect((await board()).totalTokens).toBe(0);
  });

  it('stores every publication with all history and every share flag on, on each save', async () => {
    const join = await joined();
    const wide = {alias: 'alice', historyStart: null, shareTools: true, shareCost: true, shareModels: true, generation: expect.stringMatching(/^[0-9a-f-]{36}$/)};
    expect(join.publication).toEqual(wide);
    expect((await request('GET', '/api/account', 'alice')).json().publication).toEqual(join.publication);
    expect((await request('GET', '/api/device-policy', join.device.token)).json()).toEqual({publication: join.publication});
    const renamed = (await request('PUT', '/api/publication', 'alice', publish('Alice-2'))).json().publication;
    expect(renamed).toEqual({...wide, alias: 'alice-2'});
    expect((await pool.query('SELECT history_start, share_tools, share_cost, share_models FROM cloud_publications')).rows).toEqual([{history_start: null, share_tools: true, share_cost: true, share_models: true}]);
  });

  it('has no route to withdraw a publication: only account deletion takes a member off the board', async () => {
    const join = await joined();
    expect((await upload(join)).statusCode).toBe(200);
    expect((await request('DELETE', '/api/publication', 'alice')).statusCode).toBe(404);
    expect((await request('GET', '/api/account', 'alice')).json().publication).toEqual(join.publication);
    expect((await board()).items.map((item: {alias: string; tokens: number}) => [item.alias, item.tokens])).toEqual([['alice', 100]]);
    expect((await request('DELETE', '/api/account', 'alice')).statusCode).toBe(204);
    for (const period of ['week', 'month', 'all']) {
      expect((await request('GET', `/api/leaderboard?period=${period}`)).json().items).toEqual([]);
      expect((await request('GET', `/api/profiles/alice?period=${period}`)).statusCode).toBe(404);
    }
    expect((await upload(join)).statusCode).toBe(401);
  });

  it('requires account authentication to delete and fails closed without managed auth', async () => {
    const join = await joined();
    await upload(join);
    for (const token of [undefined, 'forged', join.device.token]) {
      expect((await request('DELETE', '/api/account', token)).statusCode).toBe(401);
    }
    expect((await board()).totalTokens).toBe(100);
    const missing = Fastify();
    try {
      await registerCloudRoutes(missing, {repository});
      const response = await missing.inject({method: 'DELETE', url: '/api/account', headers: {authorization: 'Bearer alice'}});
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('AUTH_NOT_CONFIGURED');
    } finally { await missing.close(); }
  });

  it('cascades account erasure including revoked grants, isolates other accounts, and recreates empty', async () => {
    const retired = await joined();
    await upload(retired);
    await request('DELETE', `/api/devices/${retired.device.id}`, 'alice');
    const replacement = await addComputer('alice', 'Replacement');
    const alice = {...retired, device: replacement};
    const bob = await joined('bob');
    await upload(alice);
    await upload(bob, [bucket(70)]);
    const aliceId = (await pool.query('SELECT account_id FROM cloud_devices WHERE id = $1', [replacement.id])).rows[0].account_id;
    const response = await request('DELETE', '/api/account', 'alice');
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    // Exercise the actual FK chain, including the non-cascading bucket -> device FK.
    for (const table of ['cloud_accounts', 'cloud_publications', 'cloud_devices', 'cloud_buckets']) {
      const column = table === 'cloud_accounts' ? 'id' : 'account_id';
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [aliceId])).rows).toEqual([]);
    }
    for (const period of ['week', 'month', 'all']) {
      const leaderboard = (await request('GET', `/api/leaderboard?period=${period}`)).json();
      expect(leaderboard.items).toEqual([{alias: 'bob', rank: 1, tokens: 70, previousRank: null, daily: today(70), toolTokens: {}, costMicrousd: null, topBadges: ['podium'], ...(period === 'all' ? {} : {lifetimeTokens: 70})}]);
      expect(leaderboard.totalTokens).toBe(70);
      expect((await request('GET', `/api/profiles/alice?period=${period}`)).statusCode).toBe(404);
    }
    expect((await request('GET', '/api/account', 'bob')).json().devices[0].id).toBe(bob.device.id);
    expect((await upload(bob, [bucket(80, {revision: 2})])).statusCode).toBe(200);
    // Deletion is idempotent and does not claim to revoke a managed-provider JWT.
    expect((await request('DELETE', '/api/account', 'alice')).statusCode).toBe(204);
    expect((await request('GET', '/api/account', 'alice')).json()).toEqual({publication: null, devices: []});
    expect((await board()).totalTokens).toBe(80);
    expect((await request('GET', '/api/profiles/alice')).statusCode).toBe(404);
    const fresh = await joined();
    expect(fresh.publication.generation).not.toBe(alice.publication.generation);
    expect(fresh.device.id).not.toBe(alice.device.id);
    expect(fresh.device.token).not.toBe(alice.device.token);
    expect((await request('GET', '/api/profiles/alice?period=all')).json().tokens).toBe(0);
    for (const old of [retired, alice]) {
      expect((await request('GET', '/api/device-policy', old.device.token)).statusCode).toBe(401);
      expect((await upload(old)).statusCode).toBe(401);
      expect((await upload({...old, publication: fresh.publication})).statusCode).toBe(401);
    }
    expect((await upload(fresh, [bucket(5)])).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(85);
  });

  it('publishes the tool split, model mix and cost of every member, and nothing private', async () => {
    const join = await joined();
    expect((await upload(join, [bucket(20, {tool: 'codex', model: 'gpt-5-codex', costMicrousd: 7})])).statusCode).toBe(200);
    const profile = (await request('GET', '/api/profiles/alice?period=all')).json();
    expect(profile).toEqual({alias: 'alice', rank: 1, tokens: 20, previousRank: null, daily: today(20), toolTokens: {codex: 20}, costMicrousd: 7, topBadges: ['podium']});
    expect((await request('GET', '/api/profiles/alice/stats')).json().models).toEqual([{model: 'gpt-5-codex', tokens: 20, costMicrousd: 7}]);
    expect((await board('&tool=codex')).items).toMatchObject([{alias: 'alice', tokens: 20}]);
    const publicJson = JSON.stringify([await board(), await request('GET', '/api/profiles/alice/stats').then(response => response.json())]);
    for (const privateField of ['account_id', 'device', 'subject', 'issuer', 'email', 'session', 'project', 'generation', join.device.id]) expect(publicJson).not.toContain(privateField);
  });

  it('accepts all-tool aggregates but rejects overlapping day representations', async () => {
    const join = await joined();
    expect((await upload(join, [bucket(100)])).statusCode).toBe(200);
    expect((await upload(join, [bucket(100, {tool: 'codex'})])).statusCode).toBe(400);
    expect((await board()).totalTokens).toBe(100);
    expect((await upload(join, [bucket(50, {tool: 'codex', day: '2026-10-22'})])).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(150);
  });

  it('retries, out-of-order and downward revisions replace rather than inflate totals', async () => {
    const join = await joined();
    expect((await upload(join, [bucket(200, {revision: 2})])).json()).toEqual({accepted: 1});
    expect((await upload(join, [bucket(200, {revision: 2})])).json()).toEqual({accepted: 0});
    expect((await upload(join, [bucket(900, {revision: 1})])).statusCode).toBe(409);
    expect((await upload(join, [bucket(50, {revision: 3})])).json()).toEqual({accepted: 1});
    expect((await board()).totalTokens).toBe(50);
    expect((await upload(join, [bucket(0, {revision: 4})])).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(0);
  });
  it('rejects reset or rolled-back local state until an explicit publication review clears old totals', async () => {
    const join = await joined();
    expect((await upload(join, [bucket(200, {revision:10})])).statusCode).toBe(200);
    for (const state of [{collectorId:randomUUID(),checkpoint:1},{collectorId,checkpoint:1}]) {
      const rejected=await request('POST','/api/ingest',join.device.token,{generation:join.publication.generation,...state,buckets:[bucket(50)]});
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().error.code).toBe('LOCAL_STATE_RESET');
      expect((await board()).totalTokens).toBe(200);
    }
    const next = (await request('PUT','/api/publication','alice',publish('alice'))).json().publication;
    expect((await board()).totalTokens).toBe(0);
    expect((await request('POST','/api/ingest',join.device.token,{generation:join.publication.generation,collectorId,checkpoint:10,buckets:[bucket(200,{revision:10})]})).statusCode).toBe(409);
    expect((await request('POST','/api/ingest',join.device.token,{generation:next.generation,collectorId:randomUUID(),checkpoint:1,buckets:[bucket(50)]})).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(50);
  });
  it('requires a valid collector identity and a checkpoint covering every bucket', async () => {
    const join=await joined();
    for (const state of [{},{collectorId:'invalid',checkpoint:1},{collectorId,checkpoint:-1},{collectorId,checkpoint:0}]) {
      await expect(repository.ingest(join.device.token,{generation:join.publication.generation,...state,buckets:[bucket(1)]})).rejects.toMatchObject({statusCode:400});
    }
  });
  it('rejects restored history even after its revision counter catches up',async()=>{
    const join=await joined();
    await upload(join,[bucket(100,{revision:2})]);
    const backedUpReceipt=receipts.get(join.device.token)!.receipt;
    await upload(join,[bucket(100,{revision:2}),bucket(200,{day:'2026-10-22',revision:4})]);
    const restored=await request('POST','/api/ingest',join.device.token,{generation:join.publication.generation,baseReceipt:backedUpReceipt,receipt:randomUUID(),checkpoint:5,buckets:[bucket(100,{revision:2}),bucket(50,{day:'2026-10-21',revision:5})]});
    expect(restored.statusCode).toBe(409);
    expect(restored.json().error.code).toBe('LOCAL_STATE_RESET');
    expect((await board()).totalTokens).toBe(300);
  });
  it('accepts retrying the same frozen receipt after a lost response or partial upload',async()=>{
    const join=await joined();const receipt=randomUUID();
    const snapshot={generation:join.publication.generation,collectorId,checkpoint:10,baseReceipt:null,receipt};
    for(let i=0;i<2;i++) expect((await request('POST','/api/ingest',join.device.token,{...snapshot,buckets:[bucket(100)]})).statusCode).toBe(200);
    expect((await request('POST','/api/ingest',join.device.token,{...snapshot,buckets:[bucket(200,{day:'2026-10-22'})]})).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(300);
    expect((await request('POST','/api/ingest',join.device.token,{...snapshot,checkpoint:11,buckets:[bucket(999)]})).statusCode).toBe(409);
  });
  it('requires fresh review for legacy devices with buckets but no receipt',async()=>{
    const join=await joined();await upload(join,[bucket(100,{revision:4})]);
    await pool.query('ALTER TABLE cloud_devices DROP COLUMN receipt, DROP COLUMN collector_id, DROP COLUMN checkpoint');
    await pool.query('DELETE FROM cloud_migrations WHERE version=2');
    await migrateCloud(pool,{schema});
    expect((await request('POST','/api/ingest',join.device.token,{generation:join.publication.generation,baseReceipt:null,checkpoint:100,buckets:[bucket(1)]})).statusCode).toBe(409);
    expect((await board()).totalTokens).toBe(100);
  });

  it('atomically rejects aggregate overflow and preserves precise integers', async () => {
    const join = await joined();
    expect((await upload(join, [bucket(Number.MAX_SAFE_INTEGER)])).statusCode).toBe(200);
    expect((await board()).items[0].tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect((await upload(join, [bucket(1, {day: '2026-10-22'})])).statusCode).toBe(422);
    expect((await board()).items[0].tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect((await pool.query('SELECT count(*) AS count FROM cloud_buckets')).rows[0].count).toBe('1');
  });

  it('preserves unknown costs and rejects cost overflow atomically', async () => {
    const join = await joined();
    // Enough Claude Opus 4.1 tokens, at most $75 per million, for a cost at the safe-integer limit.
    const lots = 200_000_000_000_000, opus = 'claude-opus-4-1';
    await upload(join, [bucket(lots, {model: opus, costMicrousd: Number.MAX_SAFE_INTEGER})]);
    expect((await board()).items[0].costMicrousd).toBe(Number.MAX_SAFE_INTEGER);
    expect((await upload(join, [bucket(10, {day: '2026-10-22', model: opus, costMicrousd: 1})])).statusCode).toBe(422);
    expect((await board()).totalTokens).toBe(lots);
    await upload(join, [bucket(10, {day: null})]);
    expect((await board()).items[0].costMicrousd).toBeNull();
    expect((await request('GET', '/api/leaderboard?period=week')).json().items[0].costMicrousd).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('uses original UTC calendar days and excludes unknown timestamps from windows', async () => {
    const join = await joined();
    await upload(join, [bucket(5, {day: '2026-09-30'}), bucket(7, {day: '2026-10-01'}), bucket(11, {day: '2026-10-18'}), bucket(13, {day: '2026-10-19'}), bucket(17), bucket(19, {day: null})]);
    const week = (await request('GET', '/api/leaderboard?period=week')).json();
    const month = (await request('GET', '/api/leaderboard?period=month')).json();
    const all = await board();
    expect(week.windowStart).toBe('2026-10-19T00:00:00.000Z');
    expect(week.totalTokens).toBe(30);
    expect(week.items[0].tokens).toBe(30);
    expect(month.windowStart).toBe('2026-10-01T00:00:00.000Z');
    expect(month.totalTokens).toBe(48);
    expect(all.totalTokens).toBe(72);
    expect(all.windowStart).toBeNull();
  });

  it('counts all history, including imported and undated usage, since a publication has no cutoff', async () => {
    const join = await joined();
    expect((await upload(join, [bucket(900, {day: '2026-01-05'}), bucket(80, {day: null}), bucket(13, {day: '2026-10-19'})])).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(993);
    expect((await request('GET', '/api/leaderboard?period=week')).json().totalTokens).toBe(13);
  });

  it('clears previous totals on every save and rejects old generations', async () => {
    const join = await joined();
    await upload(join, [bucket(60, {tool: 'codex', costMicrousd: 99}), bucket(40, {tool: 'claude', costMicrousd: null, day: '2026-10-18'})]);
    const first = (await board()).items[0];
    expect(first.toolTokens).toEqual({codex: 60, claude: 40});
    expect(first.costMicrousd).toBeNull();
    const response = await request('PUT', '/api/publication', 'alice', publish('alice'));
    const next = response.json().publication;
    expect(next.generation).not.toBe(join.publication.generation);
    expect((await upload(join)).statusCode).toBe(409);
    expect((await pool.query('SELECT count(*) AS count FROM cloud_buckets')).rows[0].count).toBe('0');
    expect((await board()).items[0]).toEqual({alias: 'alice', rank: 1, tokens: 0, previousRank: null, daily: quiet, toolTokens: {}, costMicrousd: null, topBadges: ['podium']});
    expect((await upload({...join, publication: next})).statusCode).toBe(200);
  });

  it('ranks each tool cohort before search/page and computes per-window totals', async () => {
    const a = await joined('alice', 'zebra');
    const b = await joined('bob', 'alpha');
    // Totals without a tool split still rank by tokens, and with zero in each tool's cohort.
    const c = await joined('carol', 'totals-only');
    await upload(a, [bucket(100, {tool: 'codex', model: 'gpt-5-codex', costMicrousd: 30}), bucket(400, {tool: 'claude', costMicrousd: null, day: '2026-09-01'})]);
    await upload(b, [bucket(100, {tool: 'codex', model: 'gpt-5-codex', costMicrousd: 20}), bucket(200, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 10})]);
    await upload(c, [bucket(1000)]);
    expect((await board('&q=zebra')).items[0].rank).toBe(2);
    const tool = await board('&tool=codex&q=zebra&pageSize=1');
    expect(tool.items).toHaveLength(1);
    // Tokens follow the ranked tool; cost covers all tools (zebra's Claude cost is unknown).
    expect(tool.items[0]).toMatchObject({alias: 'zebra', rank: 2, tokens: 100, toolTokens: {codex: 100, claude: 400}, costMicrousd: null});
    expect((await board('&tool=codex&q=alpha')).items[0]).toMatchObject({rank: 1, tokens: 100, costMicrousd: 30});
    expect(tool.totalTokens).toBe(200);
    expect(tool.total).toBe(1);
    const week = (await request('GET', '/api/leaderboard?period=week&tool=claude')).json();
    expect(week.totalTokens).toBe(200);
    expect(week.items.map((p: {alias: string}) => p.alias)).toEqual(['alpha', 'totals-only', 'zebra']);
    expect((await request('GET', '/api/leaderboard?period=all&page=2&pageSize=1')).json().items[0].rank).toBe(2);
  });

  it('reports a 30-day community trend, 14-day activity, and tool/cost totals', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    await upload(a, [bucket(40, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 10}), bucket(60, {tool: 'codex', model: 'gpt-5-codex', day: '2026-10-20', costMicrousd: 5}),
      bucket(7, {tool: 'claude', model: 'claude-sonnet-4-6', day: '2026-09-01', costMicrousd: 2})]);
    await upload(b, [bucket(100, {day: '2026-10-09'}), bucket(5, {day: null})]);
    const all = await board();
    expect(all.trend).toHaveLength(30);
    expect(all.trend[0]).toEqual({day: '2026-09-24', tokens: 0});
    expect(all.trend.at(-1)).toEqual({day: '2026-10-23', tokens: 40});
    expect(all.trend.find((point: {day: string}) => point.day === '2026-10-09').tokens).toBe(100);
    // Old history and unknown dates count toward all-time totals but never appear as a day.
    expect(all.trend.reduce((sum: number, point: {tokens: number}) => sum + point.tokens, 0)).toBe(200);
    expect(all.totalTokens).toBe(212);
    expect(all.toolTotals).toEqual({claude: 47, codex: 60});
    expect(all.totalCostMicrousd).toBe(17);
    expect(all.items).toEqual([
      // Before today bob led 105 to 67; alice's 40 today moves her up one.
      {alias: 'alice', rank: 1, tokens: 107, previousRank: 2, daily: [...Array(10).fill(0), 60, 0, 0, 40], toolTokens: {claude: 47, codex: 60}, costMicrousd: 17, topBadges: ['podium', 'veteran', 'multitool']},
      {alias: 'bob', rank: 2, tokens: 105, previousRank: 1, daily: quiet, toolTokens: {}, costMicrousd: null, topBadges: ['podium']},
    ]);
    const claude = await board('&tool=claude');
    expect(claude.trend.reduce((sum: number, point: {tokens: number}) => sum + point.tokens, 0)).toBe(40);
    expect(claude.items.map((p: {alias: string; daily: number[]}) => [p.alias, p.daily])).toEqual([['alice', today(40)], ['bob', quiet]]);
    await request('DELETE', '/api/account', 'alice');
    const withdrawn = await board();
    expect(withdrawn.toolTotals).toEqual({});
    expect(withdrawn.totalCostMicrousd).toBeNull();
    expect(withdrawn.trend.reduce((sum: number, point: {tokens: number}) => sum + point.tokens, 0)).toBe(100);
  });

  it('adds all-time tokens across every tool to week and month rows, counted like the all-time board', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    await upload(a, [bucket(40, {tool: 'claude'}), bucket(60, {tool: 'codex', day: '2026-10-20'}), bucket(7, {tool: 'claude', day: '2026-09-01'})]);
    await upload(b, [bucket(100, {day: '2026-10-09'}), bucket(5, {day: null})]);
    const rows = async (query: string) => (await request('GET', `/api/leaderboard?${query}`)).json().items
      .map((p: {alias: string; tokens: number; lifetimeTokens?: number}) => [p.alias, p.tokens, p.lifetimeTokens]);
    expect(await rows('period=week')).toEqual([['alice', 100, 107], ['bob', 0, 105]]);
    // Ranked by one tool, the lifetime still covers every tool.
    expect(await rows('period=month&tool=claude')).toEqual([['alice', 40, 107], ['bob', 0, 105]]);
    expect(await rows('period=all')).toEqual([['alice', 107, undefined], ['bob', 105, undefined]]);
  });

  /** An hour of `2026-10-<at>` UTC, as the app uploads it. The test's clock reads 2026-10-23 12:00. */
  const hour = (at: string, tokens: number, tool = 'claude') => ({hour: `2026-10-${at}:00:00.000Z`, tool, tokens});
  const last24h = async (query = 'period=week') => (await request('GET', `/api/leaderboard?${query}`)).json().items
    .map((p: {alias: string; last24hTokens?: number}) => [p.alias, p.last24hTokens]);

  it('adds the last 24 whole UTC hours across every tool to each row once a computer sends hours', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    // The oldest whole hour and the latest count; the hour before them and the hour under way do not.
    expect((await upload(a, [bucket(100, {tool: 'claude'})], [hour('22T11', 1), hour('22T12', 2), hour('23T11', 4, 'codex'), hour('23T12', 8)])).statusCode).toBe(200);
    // An app from before hours sends none: its member shows no figure rather than zero.
    await upload(b, [bucket(50)]);
    expect(await last24h()).toEqual([['alice', 6], ['bob', undefined]]);
    // Ranked by one tool, the figure still covers every tool, as the lifetime does.
    expect(await last24h('period=all&tool=codex')).toEqual([['alice', 6], ['bob', undefined]]);
    expect((await request('GET', '/api/profiles/alice?period=week')).json().last24hTokens).toBe(6);
    // Each upload's hours replace the computer's; an upload without hours (a later chunk) leaves them.
    await upload(a, [bucket(100, {tool: 'claude', revision: 2})], [hour('23T10', 16)]);
    await upload(a, [bucket(100, {tool: 'claude', revision: 3})]);
    expect(await last24h()).toEqual([['alice', 16], ['bob', undefined]]);
    // Saving the publication clears the hours with the day totals.
    await request('PUT', '/api/publication', 'alice', publish('alice'));
    expect(await last24h()).toEqual([['bob', undefined], ['alice', 0]]);
  });

  it('counts an hour copied between computers once, keeps only the last day and rejects malformed hours', async () => {
    const desktop = await joined('alice');
    const laptop = {...desktop, device: await addComputer('alice', 'Laptop')};
    expect((await upload(desktop, [bucket(30, {tool: 'claude'})], [hour('23T10', 30), hour('20T10', 5)])).statusCode).toBe(200);
    expect((await upload(laptop, [bucket(35, {tool: 'claude'})], [hour('23T10', 30), hour('23T09', 5)])).statusCode).toBe(200);
    expect(await last24h()).toEqual([['alice', 35]]);
    // A batch retried late may carry hours from before the window: accepted, never stored.
    expect((await pool.query('SELECT hour FROM cloud_hours ORDER BY hour')).rows.map(row => row.hour.toISOString()))
      .toEqual(['2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z', '2026-10-23T10:00:00.000Z']);
    const refused = async (hours: unknown[]) => (await upload(desktop, [bucket(30, {tool: 'claude', revision: 2})], hours)).statusCode;
    // A clock up to an hour ahead still syncs; further ahead, or not a whole hour, or the same hour twice, does not.
    expect(await refused([hour('23T13', 1)])).toBe(200);
    expect(await refused([hour('23T14', 1)])).toBe(400);
    expect(await refused([{...hour('23T10', 1), hour: '2026-10-23T10:30:00.000Z'}])).toBe(400);
    expect(await refused([hour('23T10', 1), hour('23T10', 2)])).toBe(400);
    expect(await refused([hour('23T10', 1), hour('23T11', 1, 'all')])).toBe(400);
    expect(await refused([{...hour('23T10', 1), model: 'claude-sonnet-4-6'}])).toBe(400);
    // Hours beyond a safe total leave the figure out instead of failing the board.
    await upload(desktop, [bucket(30, {tool: 'claude', revision: 3})], [hour('23T10', Number.MAX_SAFE_INTEGER), hour('23T10', Number.MAX_SAFE_INTEGER, 'codex')]);
    expect(await last24h()).toEqual([['alice', undefined]]);
  });

  async function lockAlice(): Promise<PoolClient> {
    const client = await pool.connect();
    await client.query('BEGIN');
    const key = createHash('sha256').update(JSON.stringify([identities.alice!.issuer, identities.alice!.subject])).digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    return client;
  }
  async function waitForQueued(count: number): Promise<void> {
    const limit = Date.now() + 4000;
    while (Date.now() < limit) {
      const result = await pool.query<{count: string}>(`SELECT count(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event = 'advisory' AND query = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'`, [schema]);
      if (Number(result.rows[0]!.count) >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected account transactions to queue on the advisory lock');
  }
  it('serializes account deletion before queued ingestion and rejects a previously looked-up token', async () => {
    const join = await joined();
    await upload(join);
    const lock = await lockAlice();
    try {
      const deletion = repository.deleteAccount(identities.alice!);
      await waitForQueued(1);
      const pendingUpload = repository.ingest(join.device.token, {collectorId, checkpoint:1000, baseReceipt:receipts.get(join.device.token)?.receipt ?? null, receipt:randomUUID(), generation: join.publication.generation, buckets: [bucket(900, {revision: 2})]}).catch(error => error);
      await waitForQueued(2);
      await lock.query('COMMIT');
      await deletion;
      expect(await pendingUpload).toMatchObject({code: 'UNAUTHORIZED'});
      expect((await pool.query('SELECT 1 FROM cloud_accounts')).rows).toEqual([]);
      expect((await pool.query('SELECT 1 FROM cloud_buckets')).rows).toEqual([]);
      expect((await board()).items).toEqual([]);
      expect((await board()).totalTokens).toBe(0);
      expect((await request('GET', '/api/profiles/alice')).statusCode).toBe(404);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });
  it('erases ingestion that was queued before account deletion', async () => {
    const join = await joined();
    const lock = await lockAlice();
    try {
      const pendingUpload = repository.ingest(join.device.token, {collectorId, checkpoint:1000, baseReceipt:receipts.get(join.device.token)?.receipt ?? null, receipt:randomUUID(), generation: join.publication.generation, buckets: [bucket(900)]});
      await waitForQueued(1);
      const deletion = repository.deleteAccount(identities.alice!);
      await waitForQueued(2);
      await lock.query('COMMIT');
      expect(await pendingUpload).toEqual({accepted: 1});
      await deletion;
      expect((await pool.query('SELECT 1 FROM cloud_accounts')).rows).toEqual([]);
      expect((await pool.query('SELECT 1 FROM cloud_buckets')).rows).toEqual([]);
      expect((await board()).items).toEqual([]);
      expect((await request('GET', '/api/device-policy', join.device.token)).statusCode).toBe(401);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });
  it('serializes publication saves before queued ingestion and clears old totals', async () => {
    const join = await joined();
    await upload(join, [bucket(100, {tool: 'codex', costMicrousd: 50})]);
    const lock = await lockAlice();
    try {
      const edit = repository.putPublication(identities.alice!, publish('alice'));
      await waitForQueued(1);
      const pendingUpload = repository.ingest(join.device.token, {collectorId, checkpoint:1000, baseReceipt:receipts.get(join.device.token)?.receipt ?? null, receipt:randomUUID(), generation: join.publication.generation, buckets: [bucket(900, {tool: 'codex', costMicrousd: 100, revision: 2})]}).catch(error => error);
      await waitForQueued(2);
      await lock.query('COMMIT');
      const fresh = await edit;
      expect(fresh.generation).not.toBe(join.publication.generation);
      expect(await pendingUpload).toMatchObject({code: 'STALE_PUBLICATION'});
      expect((await board()).items[0]).toEqual({alias: 'alice', rank: 1, tokens: 0, previousRank: null, daily: quiet, toolTokens: {}, costMicrousd: null, topBadges: ['podium']});
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });

  it('serializes revocation before queued ingestion, keeps what the computer published and counts a copy once', async () => {
    const join = await joined();
    await upload(join);
    const lock = await lockAlice();
    try {
      const revoke = repository.revokeDevice(identities.alice!, join.device.id);
      await waitForQueued(1);
      const pendingUpload = repository.ingest(join.device.token, {collectorId, checkpoint:1000, baseReceipt:receipts.get(join.device.token)?.receipt ?? null, receipt:randomUUID(), generation: join.publication.generation, buckets: [bucket(900, {revision: 2})]}).catch(error => error);
      await waitForQueued(2);
      await lock.query('COMMIT');
      await revoke;
      expect(await pendingUpload).toMatchObject({code: 'UNAUTHORIZED'});
      expect((await upload(join)).statusCode).toBe(401);
      const replacement = await addComputer('alice', 'Replacement');
      expect((await board()).totalTokens).toBe(100);
      await upload({...join, device: replacement}, [bucket(100)]);
      expect((await board()).totalTokens).toBe(100);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });

  it('serializes competing snapshot receipts and rejects public query abuse without internal errors', async () => {
    const join = await joined();
    const outcomes=await Promise.all([upload(join, [bucket(10, {revision: 1})]), upload(join, [bucket(30, {revision: 3})]), upload(join, [bucket(20, {revision: 2})])]);
    expect(outcomes.filter(result=>result.statusCode===200)).toHaveLength(1);
    expect(outcomes.filter(result=>result.statusCode===409)).toHaveLength(2);
    expect([10,20,30]).toContain((await board()).totalTokens);
    expect((await upload(join,[bucket(40,{revision:4})])).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(40);
    for (const query of ['period=rolling', 'tool=unknown', 'page=0', 'pageSize=101', 'q=x&secret=1']) expect((await request('GET', `/api/leaderboard?${query}`)).statusCode).toBe(400);
    expect((await request('GET', '/api/leaderboard')).headers['cache-control']).toBe('no-store');
  });

  const startConnect = async (deviceName = 'Studio Mac', machineId?: string) => (await request('POST', '/api/device-auth', undefined, {deviceName, ...(machineId ? {machineId} : {})})).json() as {pollToken: string; userCode: string; expiresAt: string; interval: number};
  const poll = (pollToken: string) => request('POST', '/api/device-auth/poll', pollToken);

  it('connects a collector through browser approval and mints one credential on pickup', async () => {
    const pub = (await request('PUT', '/api/publication', 'alice', publish('alice'))).json().publication;
    const started = await startConnect();
    expect(started.pollToken).toMatch(/^ttp_/);
    expect(started.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started).toMatchObject({expiresAt: '2026-10-23T12:10:00.000Z', interval: 3});
    expect((await poll(started.pollToken)).json()).toEqual({status: 'pending'});
    const typed = started.userCode.toLowerCase().replace('-', '');
    expect((await request('GET', `/api/device-auth/${typed}`)).statusCode).toBe(401);
    expect((await request('GET', `/api/device-auth/${typed}`, 'alice')).json()).toEqual({userCode: started.userCode, deviceName: 'Studio Mac', expiresAt: started.expiresAt, approved: false, replaces: null});
    expect((await request('POST', `/api/device-auth/${typed}/approve`, 'alice')).statusCode).toBe(204);
    await request('PUT', '/api/publication', 'bob', publish('bob'));
    expect((await request('GET', `/api/device-auth/${started.userCode}`, 'bob')).statusCode).toBe(404);
    expect((await request('POST', `/api/device-auth/${started.userCode}/approve`, 'bob')).statusCode).toBe(404);
    const approved = (await poll(started.pollToken)).json();
    expect(approved).toEqual({status: 'approved', deviceToken: expect.stringMatching(/^ttd_/), publication: pub});
    expect((await poll(started.pollToken)).statusCode).toBe(410);
    expect((await request('GET', '/api/device-policy', approved.deviceToken)).json()).toEqual({publication: pub});
    expect((await upload({publication: pub, device: {token: approved.deviceToken}}, [bucket(250)])).statusCode).toBe(200);
    expect((await board()).items).toEqual([{alias: 'alice', rank: 1, tokens: 250, previousRank: null, daily: today(250), toolTokens: {}, costMicrousd: null, topBadges: ['podium']}, {alias: 'bob', rank: 2, tokens: 0, previousRank: null, daily: quiet, toolTokens: {}, costMicrousd: null}]);
    expect((await request('GET', '/api/account', 'alice')).json().devices).toEqual([{id: expect.any(String), name: 'Studio Mac', lastSeenAt: expect.any(String)}]);
    const wire = JSON.stringify(approved);
    for (const secret of [identities.alice!.subject, started.pollToken]) expect(wire).not.toContain(secret);
  });

  it('requires a published profile, adds the computer to the account, and mints once under concurrency', async () => {
    const pending = await startConnect('New laptop');
    expect((await request('POST', `/api/device-auth/${pending.userCode}/approve`, 'carol')).json().error.code).toBe('NOT_PUBLISHED');
    const join = await joined();
    expect((await upload(join)).statusCode).toBe(200);
    expect((await request('GET', `/api/device-auth/${pending.userCode}`, 'alice')).json()).toMatchObject({replaces: null, approved: false});
    await request('POST', `/api/device-auth/${pending.userCode}/approve`, 'alice');
    expect((await request('GET', `/api/device-auth/${pending.userCode}`, 'alice')).json()).toMatchObject({approved: true});
    const outcomes = await Promise.all([poll(pending.pollToken), poll(pending.pollToken), poll(pending.pollToken)]);
    expect(outcomes.filter(result => result.statusCode === 200)).toHaveLength(1);
    expect(outcomes.filter(result => result.statusCode === 410)).toHaveLength(2);
    // The first computer keeps publishing; the new one adds to it.
    expect((await request('GET', '/api/device-policy', join.device.token)).statusCode).toBe(200);
    expect((await board()).items[0]).toMatchObject({alias: 'alice', tokens: 100});
    expect((await request('GET', '/api/account', 'alice')).json().devices.map((device: {name: string}) => device.name)).toEqual(['Publishing desktop', 'New laptop']);
  });

  it('expires codes, rejects malformed input, and erases approvals with the account', async () => {
    await request('PUT', '/api/publication', 'alice', publish('alice'));
    const started = await startConnect();
    const later = new PostgresCloudRepository(pool, () => new Date(now.getTime() + 10 * 60_000), schema, undefined, TEST_MODERATION_POLICY);
    await expect(later.deviceAuthorization(identities.alice!, started.userCode)).rejects.toMatchObject({statusCode: 404});
    await expect(later.approveDeviceAuthorization(identities.alice!, started.userCode)).rejects.toMatchObject({statusCode: 404});
    await expect(later.pollDeviceAuthorization(started.pollToken)).rejects.toMatchObject({statusCode: 410, code: 'EXPIRED'});
    await later.startDeviceAuthorization({deviceName: 'Cleanup trigger'});
    expect((await pool.query('SELECT 1 FROM cloud_device_authorizations WHERE user_code = $1', [started.userCode])).rowCount).toBe(0);
    for (const body of [{}, {deviceName: ''}, {deviceName: 'x'.repeat(81)}, {deviceName: 'Mac', extra: true}, {deviceName: 'bad\u0007name'}, {deviceName: 'Mac', machineId: 'A'.repeat(64)}, {deviceName: 'Mac', machineId: 'a'.repeat(63)}, {deviceName: 'Mac', machineId: null}]) {
      expect((await request('POST', '/api/device-auth', undefined, body)).statusCode).toBe(400);
    }
    expect((await request('POST', '/api/device-auth/poll')).statusCode).toBe(401);
    expect((await poll('ttp_unknown')).statusCode).toBe(410);
    for (const code of ['AAAA-AAAA', 'BCDF-GHJ', 'BCDF-GHJKL', '../../x']) expect((await request('GET', `/api/device-auth/${encodeURIComponent(code)}`, 'alice')).statusCode).toBe(404);
    const approved = await startConnect();
    await request('POST', `/api/device-auth/${approved.userCode}/approve`, 'alice');
    await request('DELETE', '/api/account', 'alice');
    expect((await poll(approved.pollToken)).statusCode).toBe(410);
  });
  // Several computers on one account.
  const machine = (name: string) => createHash('sha256').update(name).digest('hex');
  /** Browser approval end to end; the device token, or the refused approval. */
  async function connectComputer(who: string, deviceName: string, machineId?: string) {
    const started = await startConnect(deviceName, machineId);
    const approved = await request('POST', `/api/device-auth/${started.userCode}/approve`, who);
    if (approved.statusCode !== 204) return {refused: approved.json().error.code as string};
    return {token: (await poll(started.pollToken)).json().deviceToken as string};
  }
  /** Connects a computer without a machine id; its id is the one the account lists afterwards. */
  async function addComputer(who: string, deviceName: string) {
    const known = new Set<string>((await request('GET', '/api/account', who)).json().devices.map((device: {id: string}) => device.id));
    const connected = await connectComputer(who, deviceName);
    if (!connected.token) throw new Error(`Computer refused: ${connected.refused}`);
    const added = (await request('GET', '/api/account', who)).json().devices.find((device: {id: string}) => !known.has(device.id));
    return {id: added.id as string, token: connected.token};
  }

  it('publishes a cost only when its tokens could cost that much at list prices', async () => {
    const join = await joined();
    // 1,000 Sonnet output tokens cost 1.5 cents at $15 per million.
    const honest = bucket(1_000, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 15_000, breakdown: kinds(0, 1_000, 0, 0, 0)});
    const inflated = {...honest, day: '2026-10-22', costMicrousd: 50_000_000_000};
    expect((await upload(join, [honest, inflated])).json().accepted).toBe(2);
    expect((await pool.query('SELECT day_key, cost_microusd FROM cloud_buckets ORDER BY day_key')).rows).toEqual([{day_key: '2026-10-22', cost_microusd: null}, {day_key: '2026-10-23', cost_microusd: '15000'}]);
    expect((await request('GET', '/api/profiles/alice/stats')).json()).toMatchObject({periods: {all: {tokens: 2_000}}, costMicrousd: null});
    expect(events).toEqual([{event: 'cost_capped', count: 1}]);
  });

  it('deduplicates copied token types consistently across profiles, community and moderation', async () => {
    const desktop = await joined();
    const laptop = {...desktop, device: await addComputer('alice', 'Laptop')};
    const copied = {...bucket(100), tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 10, breakdown: kinds(10, 20, 30, 40, 5)};
    expect((await upload(desktop, [copied])).statusCode).toBe(200);
    expect((await upload(laptop, [{...copied, costMicrousd: null}])).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(100);
    expect((await request('GET', '/api/profiles/alice/stats')).json()).toMatchObject({breakdown: copied.breakdown, periods: {all: {tokens: 100}}, costMicrousd: null});
    expect(await repository.community()).toMatchObject({totalTokens: 100, breakdown: copied.breakdown, totalCostMicrousd: null});
    expect(await repository.moderationSummary('alice')).toMatchObject({tokens: 100, devices: 2, flags: []});
    // Equal totals with a different breakdown are different buckets; a stale retry changes nothing.
    const corrected = {...copied, revision: 2, breakdown: kinds(20, 10, 30, 40, 5)};
    expect((await upload(laptop, [corrected])).statusCode).toBe(200);
    expect((await upload(laptop, [corrected])).json().accepted).toBe(0);
    expect((await board()).totalTokens).toBe(200);
    expect(await repository.community()).toMatchObject({totalTokens: 200, breakdown: kinds(30, 30, 60, 80, 10)});
    expect(await repository.moderationSummary('alice')).toMatchObject({tokens: 200, devices: 2});
    // A lower correction matching the other computer coalesces again and its higher revision stays per-device.
    expect((await upload(laptop, [{...copied, revision: 3}])).statusCode).toBe(200);
    expect((await board()).totalTokens).toBe(100);
    await request('DELETE', `/api/devices/${laptop.device.id}`, 'alice');
    expect(await repository.community()).toMatchObject({totalTokens: 100, breakdown: copied.breakdown});
    await flag('alice', '2026-10-23', 'hidden');
    expect(await repository.community()).toMatchObject({totalTokens: 0, breakdown: null});
    expect(await repository.moderationSummary('alice')).toMatchObject({tokens: 100, devices: 1});
  });

  it('adds every computer to one account and counts a bucket copied between them once', async () => {
    const desktop = await joined('alice', 'alice');
    const laptop = {...desktop, device: await addComputer('alice', 'Laptop')};
    const copied = bucket(100, {day: '2026-10-22', tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 10});
    expect((await upload(desktop, [copied, bucket(40, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 4})])).statusCode).toBe(200);
    expect((await upload(laptop, [copied, bucket(25, {tool: 'codex', model: 'gpt-5-codex', costMicrousd: 2})])).statusCode).toBe(200);
    expect((await board()).items[0]).toMatchObject({alias: 'alice', tokens: 165, toolTokens: {claude: 140, codex: 25}, costMicrousd: 16});
    const stats = (await request('GET', '/api/profiles/alice/stats')).json();
    expect(stats.daily.slice(-2)).toEqual([{day: '2026-10-22', tokens: 100}, {day: '2026-10-23', tokens: 65}]);
    expect(stats.models).toEqual([{model: 'claude-sonnet-4-6', tokens: 140, costMicrousd: 14}, {model: 'gpt-5-codex', tokens: 25, costMicrousd: 2}]);
    // Real use on two computers differs, so both count.
    expect((await upload(laptop, [{...copied, tokens: 101, revision: 2}])).statusCode).toBe(200);
    expect((await board()).items[0]).toMatchObject({tokens: 266, costMicrousd: 26});
    expect(await repository.community()).toMatchObject({builders: 1, totalTokens: 266});
    expect((await request('GET', '/api/account', 'alice')).json().devices.map((device: {name: string}) => device.name)).toEqual(['Publishing desktop', 'Laptop']);
    // Computers on different app versions may split a day differently; only one computer's own day must agree.
    expect((await upload(desktop, [bucket(7, {day: '2026-10-21', tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 1, revision: 2})])).statusCode).toBe(200);
    expect((await upload(laptop, [bucket(3, {day: '2026-10-21', tool: 'claude', costMicrousd: 1, revision: 3})])).statusCode).toBe(200);
    expect((await upload(laptop, [bucket(3, {day: '2026-10-21', tool: 'claude', model: 'gpt-5-codex', costMicrousd: 1, revision: 4})])).json().error.message).toBe('A day cannot combine aggregated and split buckets');
    // The older app's bucket has no model, so its cost cannot be checked and is published as unknown.
    expect((await board()).items[0]).toMatchObject({tokens: 276, costMicrousd: null});
    // A removed computer stops uploading; what it published stays.
    await request('DELETE', `/api/devices/${laptop.device.id}`, 'alice');
    expect((await upload(laptop, [{...copied, tokens: 500, revision: 5}])).statusCode).toBe(401);
    expect((await board()).items[0].tokens).toBe(276);
  });

  it('replaces the computer that connects again, even after it was removed, and adds one without a machine id', async () => {
    const desktop = await joined();
    await upload(desktop, [bucket(100)]);
    const first = await connectComputer('alice', 'Studio Mac', machine('studio'));
    await upload({...desktop, device: {token: first.token!}}, [bucket(70)]);
    expect((await board()).items[0].tokens).toBe(170);
    const again = await startConnect('Studio Mac 2', machine('studio'));
    expect((await request('GET', `/api/device-auth/${again.userCode}`, 'alice')).json()).toMatchObject({deviceName: 'Studio Mac 2', replaces: 'Studio Mac'});
    await request('POST', `/api/device-auth/${again.userCode}/approve`, 'alice');
    const second = (await poll(again.pollToken)).json().deviceToken;
    expect((await request('GET', '/api/device-policy', first.token!)).statusCode).toBe(401);
    expect((await board()).items[0].tokens).toBe(100);
    await upload({...desktop, device: {token: second}}, [bucket(80)]);
    expect((await board()).items[0].tokens).toBe(180);
    const devices = (await request('GET', '/api/account', 'alice')).json().devices;
    expect(devices.map((device: {name: string}) => device.name)).toEqual(['Publishing desktop', 'Studio Mac 2']);
    // Removed first: its totals stay until the same computer connects again.
    await request('DELETE', `/api/devices/${devices[1].id}`, 'alice');
    expect((await board()).items[0].tokens).toBe(180);
    const third = await startConnect('Studio Mac 3', machine('studio'));
    expect((await request('GET', `/api/device-auth/${third.userCode}`, 'alice')).json().replaces).toBe('Studio Mac 2');
    await request('POST', `/api/device-auth/${third.userCode}/approve`, 'alice');
    expect((await poll(third.pollToken)).json().status).toBe('approved');
    expect((await board()).items[0].tokens).toBe(100);
    // An app that sends no machine id adds a computer.
    const older = await startConnect('Old app');
    expect((await request('GET', `/api/device-auth/${older.userCode}`, 'alice')).json().replaces).toBeNull();
    await request('POST', `/api/device-auth/${older.userCode}/approve`, 'alice');
    expect((await poll(older.pollToken)).json().status).toBe('approved');
    expect((await request('GET', '/api/account', 'alice')).json().devices.map((device: {name: string}) => device.name)).toEqual(['Publishing desktop', 'Studio Mac 3', 'Old app']);
    expect((await board()).items[0].tokens).toBe(100);
    // Another account's computer with the same machine id is never touched.
    await joined('bob');
    expect((await connectComputer('bob', 'Shared Mac', machine('studio'))).token).toMatch(/^ttd_/);
    expect((await request('GET', '/api/account', 'alice')).json().devices).toHaveLength(3);
  });

  it('caps an account at 10 active computers and frees a slot when one is removed', async () => {
    const desktop = await joined();
    for (let index = 2; index <= 9; index++) expect((await addComputer('alice', `Mac ${index}`)).token).toMatch(/^ttd_/);
    expect((await connectComputer('alice', 'Mac 10', machine('mac-10'))).token).toMatch(/^ttd_/);
    const full = await startConnect('Mac 11', machine('mac-11'));
    const limit = await request('POST', `/api/device-auth/${full.userCode}/approve`, 'alice');
    expect(limit.statusCode).toBe(409);
    expect(limit.json().error).toEqual({code: 'DEVICE_LIMIT', message: 'Remove a computer first. An account can connect up to 10 computers.'});
    // The same computer connecting again replaces itself, so it fits.
    expect((await connectComputer('alice', 'Mac 10 again', machine('mac-10'))).token).toMatch(/^ttd_/);
    expect((await request('GET', '/api/account', 'alice')).json().devices).toHaveLength(10);
    await request('DELETE', `/api/devices/${desktop.device.id}`, 'alice');
    expect((await connectComputer('alice', 'Mac 11', machine('mac-11'))).token).toMatch(/^ttd_/);
    // Two approvals that each saw a free slot: only the first pickup gets it.
    await request('DELETE', `/api/devices/${(await request('GET', '/api/account', 'alice')).json().devices[0].id}`, 'alice');
    const racing = [await startConnect('Mac 12', machine('mac-12')), await startConnect('Mac 13', machine('mac-13'))];
    for (const started of racing) expect((await request('POST', `/api/device-auth/${started.userCode}/approve`, 'alice')).statusCode).toBe(204);
    expect((await poll(racing[0]!.pollToken)).json().status).toBe('approved');
    const late = await poll(racing[1]!.pollToken);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('DEVICE_LIMIT');
  });

  it('upgrades a one-computer schema without changing any published total', async () => {
    const alice = await joined('alice', 'alice');
    await upload(alice, [bucket(100, {tool: 'claude', model: 'claude-sonnet-4-6', costMicrousd: 7}), bucket(5, {day: '2026-10-20', tool: 'codex', model: 'gpt-5-codex', costMicrousd: 1})]);
    const retired = await joined('bob');
    await upload(retired, [bucket(30)]);
    await request('DELETE', `/api/devices/${retired.device.id}`, 'bob');
    const before = {board: await board(), alice: (await request('GET', '/api/profiles/alice/stats')).json(), bob: (await request('GET', '/api/profiles/bob/stats')).json()};
    await pool.query(BEFORE_MULTI_COMPUTER);
    await migrateCloud(pool, {schema});
    expect({board: await board(), alice: (await request('GET', '/api/profiles/alice/stats')).json(), bob: (await request('GET', '/api/profiles/bob/stats')).json()}).toEqual(before);
    expect((await addComputer('alice', 'Second')).token).toMatch(/^ttd_/);
  });

  const accountId = (who: string) => createHash('sha256').update(JSON.stringify([identities[who]!.issuer, identities[who]!.subject])).digest('hex');
  const flag = (who: string, day: string, status: 'review' | 'hidden' | 'cleared', tokens = 0) => pool.query(
    `INSERT INTO cloud_flags(account_id, day_key, tokens, rival_tokens, cohort_size, reasons, status) VALUES ($1,$2,$3,0,0,'{test}',$4)
     ON CONFLICT (account_id, day_key) DO UPDATE SET status = EXCLUDED.status`, [accountId(who), day, tokens, status]);

  it('hides an account from every public read, closes ranks behind it and keeps its uploads open', async () => {
    const alice = await joined();
    const bob = await joined('bob');
    const carol = await joined('carol');
    await upload(alice, [bucket(1000, {day: '2026-10-22', tool: 'claude'}), bucket(500, {tool: 'claude'})]);
    await upload(bob, [bucket(50, {day: '2026-10-22', tool: 'claude'}), bucket(70, {tool: 'claude'})]);
    await upload(carol, [bucket(30, {tool: 'claude'})]);
    await flag('alice', '2026-10-23', 'review');
    expect((await board()).items[0].alias).toBe('alice');
    expect((await request('GET', '/api/account', 'alice')).json()).not.toHaveProperty('moderation');

    await flag('alice', '2026-10-23', 'hidden');
    for (const period of ['week', 'month', 'all']) {
      for (const tool of ['all', 'claude']) {
        const leaderboard = (await request('GET', `/api/leaderboard?period=${period}&tool=${tool}`)).json();
        expect(leaderboard.items.map((item: {alias: string; rank: number}) => [item.alias, item.rank])).toEqual([['bob', 1], ['carol', 2]]);
        expect(leaderboard.totalTokens).toBe(150);
        expect(leaderboard.trend.at(-1)).toEqual({day: '2026-10-23', tokens: 100});
      }
      expect((await request('GET', `/api/profiles/alice?period=${period}`)).statusCode).toBe(404);
    }
    expect((await board()).items[0].previousRank).toBe(1);
    expect((await request('GET', '/api/profiles/alice/stats')).statusCode).toBe(404);
    expect((await request('GET', '/badge/alice.svg')).body).toContain('>private<');
    expect(await repository.community()).toMatchObject({builders: 2, totalTokens: 150, toolTotals: {claude: 150}});
    expect((await request('GET', '/api/account', 'alice')).json().moderation).toEqual({state: 'hidden', days: ['2026-10-23']});
    // Hidden is not banned: corrected numbers can still arrive.
    expect((await upload(alice, [bucket(60, {tool: 'claude', revision: 2})])).statusCode).toBe(200);

    await flag('alice', '2026-10-23', 'cleared');
    expect((await board()).items.map((item: {alias: string}) => item.alias)).toEqual(['alice', 'bob', 'carol']);
    expect((await request('GET', '/api/account', 'alice')).json()).not.toHaveProperty('moderation');
  });

  it('refuses every publishing route to a banned account, revokes its computers and outlives deletion', async () => {
    const alice = await joined();
    expect((await upload(alice)).statusCode).toBe(200);
    const approved = await startConnect();
    await request('POST', `/api/device-auth/${approved.userCode}/approve`, 'alice');
    await expect(repository.ban('alice', ' ')).rejects.toMatchObject({statusCode: 400});
    await expect(repository.ban('nobody', 'Invented logs')).rejects.toMatchObject({statusCode: 404});
    await flag('alice', '2026-10-23', 'hidden');
    expect(await repository.ban('ALICE', 'Invented logs')).toEqual({accountId: accountId('alice'), devicesRevoked: 1});
    expect((await pool.query('SELECT note FROM cloud_flags WHERE account_id = $1 AND reviewed_at IS NOT NULL', [accountId('alice')])).rows).toEqual([{note: 'banned'}]);

    const refused = async (response: Awaited<ReturnType<typeof request>>) => {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('BANNED');
    };
    expect((await request('GET', '/api/device-policy', alice.device.token)).statusCode).toBe(401);
    expect((await upload(alice)).statusCode).toBe(401);
    await refused(await poll(approved.pollToken));
    const next = await startConnect();
    await refused(await request('POST', `/api/device-auth/${next.userCode}/approve`, 'alice'));
    await refused(await request('PUT', '/api/publication', 'alice', publish('alice')));
    expect((await board()).items).toEqual([]);
    expect((await request('GET', '/api/account', 'alice')).json().moderation).toEqual({state: 'banned'});

    // A ban entered without revoking computers still stops the device routes.
    const bob = await joined('bob');
    await pool.query(`INSERT INTO cloud_bans(account_id, reason) VALUES ($1, 'Hand entry')`, [accountId('bob')]);
    await refused(await request('GET', '/api/device-policy', bob.device.token));
    await refused(await upload(bob));

    expect((await request('DELETE', '/api/account', 'alice')).statusCode).toBe(204);
    expect((await pool.query('SELECT reason FROM cloud_bans WHERE account_id = $1', [accountId('alice')])).rows).toEqual([{reason: 'Invented logs'}]);
    expect((await request('GET', '/api/account', 'alice')).json()).toEqual({publication: null, devices: [], moderation: {state: 'banned'}});
    await refused(await request('PUT', '/api/publication', 'alice', publish('alice')));

    await repository.unban(accountId('alice'));
    await expect(repository.unban(accountId('alice'))).rejects.toMatchObject({statusCode: 404});
    expect((await request('PUT', '/api/publication', 'alice', publish('alice'))).statusCode).toBe(200);
  });

  const B = 1e7;
  /** Members peer1… each publishing `tokens` today. */
  async function peers(count: number, tokens: number, from = 1) {
    const joins = [];
    for (let index = from; index < from + count; index++) {
      const join = await joined(`peer${index}`);
      expect((await upload(join, [bucket(tokens)])).statusCode).toBe(200);
      joins.push(join);
    }
    return joins;
  }
  const flags = async (who = 'alice') => (await pool.query(
    'SELECT day_key, tokens::float AS tokens, rival_tokens::float AS rival, cohort_size AS cohort, reasons, status, reviewed_at FROM cloud_flags WHERE account_id = $1 ORDER BY day_key', [accountId(who)])).rows;
  const aliases = async () => (await board()).items.map((item: {alias: string}) => item.alias);

  it('hides a day above the configured peer ratio during the upload, ignores hidden peers and still accepts the upload', async () => {
    await peers(5, 0.5 * B);
    const [hiddenPeer] = await peers(1, 4 * B, 6);
    await flag('peer6', '2026-10-23', 'hidden');
    const alice = await joined();
    expect((await upload(alice, [bucket(5 * B)])).statusCode).toBe(200);
    expect(await flags()).toEqual([{day_key: '2026-10-23', tokens: 5 * B, rival: 0.5 * B, cohort: 5, reasons: ['peers'], status: 'hidden', reviewed_at: null}]);
    expect(events).toEqual([{event: 'moderation_flag', status: 'hidden', reasons: ['peers']}]);
    expect(JSON.stringify(events)).not.toContain('alice');
    expect(await aliases()).not.toContain('alice');
    expect((await request('GET', '/api/account', 'alice')).json().moderation).toEqual({state: 'hidden', days: ['2026-10-23']});
    // Uploads stay open; a later lower total does not unhide, only a person does.
    expect((await upload(alice, [bucket(B, {revision: 2})])).statusCode).toBe(200);
    expect((await flags())[0]).toMatchObject({status: 'hidden'});
    expect(hiddenPeer).toBeDefined();
  });

  it('never hides a member with too few peers that day, and leaves ordinary days unchecked', async () => {
    await peers(3, 0.1 * B);
    const alice = await joined();
    expect((await upload(alice, [bucket(9 * B)])).statusCode).toBe(200);
    const bob = await joined('bob');
    expect((await upload(bob, [bucket(0.9 * B)])).statusCode).toBe(200);
    expect(await flags()).toEqual([]);
    expect(await flags('bob')).toEqual([]);
    expect(events).toEqual([]);
    expect((await aliases())[0]).toBe('alice');
  });

  it('raises a review on its own to hidden as the day grows', async () => {
    await peers(5, 2 * B);
    const alice = await joined();
    await upload(alice, [bucket(12 * B)]);
    expect(await flags()).toMatchObject([{status: 'review', reasons: ['volume', 'lead'], tokens: 12 * B}]);
    expect(await aliases()).toContain('alice');
    await upload(alice, [bucket(13 * B, {revision: 2})]);
    expect(await flags()).toMatchObject([{status: 'review', tokens: 13 * B}]);
    await upload(alice, [bucket(25 * B, {revision: 3})]);
    expect(await flags()).toMatchObject([{status: 'hidden', reasons: ['volume', 'lead', 'peers'], tokens: 25 * B}]);
    expect(events).toEqual([{event: 'moderation_flag', status: 'review', reasons: ['volume', 'lead']}, {event: 'moderation_flag', status: 'hidden', reasons: ['volume', 'lead', 'peers']}]);
  });

  it('sends repeated templates and self-baseline jumps to review without hiding', async () => {
    const alice = await joined();
    const template = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'].map(day => bucket(7_135_700, {day}));
    expect((await upload(alice, [...template.slice(0, 3), bucket(10_000)])).statusCode).toBe(200);
    expect(await flags()).toEqual([]);
    await upload(alice, [template[3]!, bucket(10_000, {revision: 2})]);
    expect(await flags()).toMatchObject([{day_key: '2026-10-18', reasons: ['template'], status: 'review'}]);

    const bob = await joined('bob');
    const history = Array.from({length: 14}, (_, index) => bucket(500_000 + index * 123, {day: `2026-10-${String(9 + index).padStart(2, '0')}`}));
    await upload(bob, [...history, bucket(2 * B)]);
    expect(await flags('bob')).toMatchObject([{day_key: '2026-10-23', reasons: ['jump'], status: 'review'}]);
    // Review has no public effect.
    expect(await aliases()).toEqual(['alice', 'bob']);
  });

  it('does not trigger a lead review when a second computer uploads copied history', async () => {
    await peers(1, 3 * B);
    const desktop = await joined();
    const laptop = {...desktop, device: await addComputer('alice', 'Laptop')};
    const history = Array.from({length: 8}, (_, index) => bucket(0.9 * B + index * 1234, {day: `2026-10-${String(16 + index).padStart(2, '0')}`}));
    expect((await upload(desktop, history)).statusCode).toBe(200);
    expect((await upload(laptop, history)).statusCode).toBe(200);
    expect(await flags()).toEqual([]);
    expect((await repository.moderationSummary('alice')).tokens).toBe(history.reduce((sum, row) => sum + row.tokens, 0));
  });

  it('counts an all-time lead once, on the upload that crosses the line', async () => {
    const [peer] = await peers(1, 3 * B);
    const alice = await joined();
    const days = Array.from({length: 12}, (_, index) => bucket(0.9 * B + index * 1_234, {day: `2026-10-${String(12 + index).padStart(2, '0')}`}));
    await upload(alice, days);
    expect(await flags()).toMatchObject([{day_key: '2026-10-23', reasons: ['lead'], status: 'review'}]);
    await upload(alice, [bucket(0.95 * B, {revision: 2})]);
    expect(events).toHaveLength(1);
    expect(peer).toBeDefined();
  });

  it('turns hides into reviews when several other accounts were hidden within the configured window', async () => {
    await peers(5, 0.5 * B);
    await peers(3, 0.1 * B, 6);
    for (const who of ['peer6', 'peer7', 'peer8']) {
      await pool.query(`INSERT INTO cloud_flags(account_id, day_key, tokens, rival_tokens, cohort_size, reasons, status, detected_at) VALUES ($1, '2026-10-22', 0, 0, 0, '{peers}', 'hidden', $2)`,
        [accountId(who), new Date(now.getTime() - 10 * 60_000)]);
    }
    const alice = await joined();
    await upload(alice, [bucket(5 * B)]);
    expect(await flags()).toMatchObject([{status: 'review', reasons: ['peers']}]);
    expect(events).toEqual([{event: 'moderation_breaker'}, {event: 'moderation_flag', status: 'review', reasons: ['peers']}]);
    expect(await aliases()).toContain('alice');
    // Once those hides are outside the configured window, the next upload hides as usual.
    await pool.query(`UPDATE cloud_flags SET detected_at = $1 WHERE day_key = '2026-10-22'`, [new Date(now.getTime() - 2 * 3_600_000)]);
    await upload(alice, [bucket(5.5 * B, {revision: 2})]);
    expect(await flags()).toMatchObject([{status: 'hidden'}]);
  });

  it('keeps a cleared day cleared until its total reaches the configured growth', async () => {
    await peers(5, 0.5 * B);
    const alice = await joined();
    await upload(alice, [bucket(5 * B)]);
    await pool.query(`UPDATE cloud_flags SET status = 'cleared', reviewed_at = now(), note = 'verified farm' WHERE account_id = $1`, [accountId('alice')]);
    await upload(alice, [bucket(14.9 * B, {revision: 2})]);
    expect(await flags()).toMatchObject([{status: 'cleared', tokens: 5 * B}]);
    expect(await aliases()).toContain('alice');
    await upload(alice, [bucket(15 * B, {revision: 3})]);
    expect(await flags()).toMatchObject([{status: 'hidden', reasons: ['peers', 'volume'], tokens: 15 * B, reviewed_at: null}]);
    expect((await pool.query('SELECT note FROM cloud_flags')).rows).toEqual([{note: null}]);
  });

  /** Runs one operator command, answering the confirmation with `typed`. */
  async function operator(argv: string[], typed = '') {
    const lines: string[] = [];
    const asked: string[] = [];
    const code = await moderationCommand(repository, argv, {ask: async question => { asked.push(question); return typed; }, print: line => lines.push(line)});
    return {code, lines, asked, output: lines.join('\n')};
  }

  it('lists open flags with the ratio now, which moves when a rival is cleared', async () => {
    await peers(5, 0.5 * B);
    await peers(1, 6 * B, 6);
    const alice = await joined();
    await upload(alice, [bucket(5 * B)]);
    expect((await flags('peer6'))[0]).toMatchObject({status: 'hidden'});
    expect((await flags())[0]).toMatchObject({status: 'hidden', rival: 0.5 * B});
    let queue = await operator(['queue']);
    expect(queue.code).toBe(0);
    expect(queue.lines).toEqual([
      'hidden peer6 2026-10-23 [peers] flagged 60M at 12.0× of 5 peers; now 60M at 12.0× of 5 visible peers',
      'hidden alice 2026-10-23 [peers] flagged 50M at 10.0× of 5 peers; now 50M at 10.0× of 5 visible peers',
    ]);
    // A verified heavy member is cleared; alice now sits beside a visible member who out-ran her.
    expect((await operator(['clear', 'peer6', '2026-10-23', '--note', 'verified build farm'], 'peer6')).code).toBe(0);
    expect(await flags('peer6')).toMatchObject([{status: 'cleared', reviewed_at: expect.any(Date)}]);
    queue = await operator(['queue']);
    expect(queue.lines).toEqual(['hidden alice 2026-10-23 [peers] flagged 50M at 10.0× of 5 peers; now 50M at 0.8× of 6 visible peers (a visible member out-ran them: likely false positive)']);
    expect(await aliases()).toContain('peer6');
    expect(await operator(['clear', 'alice', '2026-10-23', '--note', 'peer out-ran her'], 'alice')).toMatchObject({code: 0});
    expect(await aliases()).toContain('alice');
    expect((await operator(['queue'])).lines).toEqual(['No open flags.']);
  });

  it('writes nothing unless the operator types the member again, and names one member per command', async () => {
    await peers(5, 0.5 * B);
    const alice = await joined();
    await upload(alice, [bucket(1.2 * B), bucket(0.1 * B, {day: '2026-10-22'})]);
    await flag('alice', '2026-10-21', 'review');

    for (const typed of ['', 'alic', 'ALICE', 'bob']) {
      const refused = await operator(['ban', 'alice', '--reason', 'Invented logs'], typed);
      expect(refused).toMatchObject({code: 1, asked: ['Type alice to confirm: ']});
      expect(refused.output).toContain('Change: Ban: refuse every publishing route, revoke 1 computer(s), close open flags.');
      expect(refused.output).toContain('Not confirmed; nothing changed.');
    }
    expect((await pool.query('SELECT 1 FROM cloud_bans')).rowCount).toBe(0);
    expect((await operator(['hide', 'alice', '2026-10-21', '--note', 'shape'], 'nope')).code).toBe(1);
    expect((await flags())[0]).toMatchObject({status: 'review', reviewed_at: null});
    // Missing note, malformed day, unknown member or day: nothing is asked or changed.
    for (const argv of [['hide', 'alice', '2026-10-21'], ['clear', 'alice', '21-10-2026', '--note', 'x'], ['ban', 'alice'], ['ban'], ['purge', 'alice'], []]) {
      expect(await operator(argv)).toMatchObject({code: 2, asked: []});
    }
    expect(await operator(['clear', 'nobody', '2026-10-21', '--note', 'x'])).toMatchObject({code: 1, asked: [], lines: ['Published profile not found']});
    expect(await operator(['clear', 'alice', '2026-10-01', '--note', 'x'])).toMatchObject({code: 1, asked: [], lines: ['No flag for this member and day']});

    const hidden = await operator(['hide', 'alice', '2026-10-21', '--note', 'template shape by hand'], 'alice');
    expect(hidden.lines[0]).toBe('alice · account ' + accountId('alice').slice(0, 12) + ' · 13M tokens over 2 day(s) · 1 computer(s)');
    expect(hidden.code).toBe(0);
    expect((await pool.query('SELECT status, note FROM cloud_flags WHERE account_id = $1', [accountId('alice')])).rows).toEqual([{status: 'hidden', note: 'template shape by hand'}]);
    expect(await aliases()).not.toContain('alice');

    expect((await operator(['ban', 'alice', '--reason', 'Invented logs'], 'alice')).lines.at(-1)).toBe('Banned alice; 1 computer(s) revoked.');
    expect((await request('DELETE', '/api/account', 'alice')).statusCode).toBe(204);
    // The profile is gone, so the ban is addressed by account id.
    expect((await operator(['unban', 'alice'])).lines).toEqual(['Published profile not found']);
    const id = accountId('alice');
    expect((await operator(['unban', id], id)).lines.at(-1)).toBe(`Unbanned ${id}.`);
    expect((await operator(['unban', id], id)).lines).toEqual(['No ban for this account']);
  });

  it('stores the verified GitHub login when joining or connecting, and keeps it when the lookup fails', async () => {
    let lookup = async (): Promise<string | null> => 'octo-cat';
    const subjects: string[] = [];
    const github = Fastify();
    await registerCloudRoutes(github, {repository, verifyAccount: async token => identities[token]!, githubLogin: subject => { subjects.push(subject); return lookup(); }});
    const stored = async () => (await pool.query('SELECT github_login FROM cloud_accounts WHERE id = $1', [accountId('alice')])).rows[0]?.github_login;
    const join = () => github.inject({method: 'PUT', url: '/api/publication', headers: {authorization: 'Bearer alice'}, payload: publish('alice')});
    const approve = async () => {
      const {userCode} = (await github.inject({method: 'POST', url: '/api/device-auth', payload: {deviceName: 'Mac'}})).json();
      return github.inject({method: 'POST', url: `/api/device-auth/${userCode}/approve`, headers: {authorization: 'Bearer alice'}});
    };
    try {
      expect((await join()).statusCode).toBe(200);
      expect(await stored()).toBe('octo-cat');
      expect(subjects).toEqual([identities.alice!.subject]);
      lookup = async () => { throw new Error('Supabase is down'); };
      expect((await join()).statusCode).toBe(200);
      expect((await approve()).statusCode).toBe(204);
      expect(await stored()).toBe('octo-cat');
      // Signed in another way, or GitHub unlinked: the login is cleared.
      lookup = async () => null;
      expect((await approve()).statusCode).toBe(204);
      expect(await stored()).toBeNull();
      lookup = async () => 'octo-cat';
      expect((await approve()).statusCode).toBe(204);
      expect(await stored()).toBe('octo-cat');
      // Without a resolver the stored login is left alone.
      expect((await request('PUT', '/api/publication', 'alice', publish('alice'))).statusCode).toBe(200);
      expect(await stored()).toBe('octo-cat');
    } finally { await github.close(); }
  });

  it('clears the GitHub login only when Supabase has no such user, and keeps it through errors and timeouts', async () => {
    let answer: 'octo-cat' | 404 | 429 | 500 | 'hang' = 'octo-cat';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (answer === 'hang') return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
      return typeof answer === 'number' ? new Response('{}', {status: answer}) : Response.json({identities: [{provider: 'github', identity_data: {user_name: answer}}]});
    }) as typeof fetch;
    const github = Fastify();
    await registerCloudRoutes(github, {repository, verifyAccount: async token => identities[token]!, githubLogin: supabaseGithubLogin('https://project.supabase.co', 'service-role-key', fetchImpl)});
    const stored = async () => (await pool.query('SELECT github_login FROM cloud_accounts WHERE id = $1', [accountId('alice')])).rows[0]?.github_login;
    const join = async () => (await github.inject({method: 'PUT', url: '/api/publication', headers: {authorization: 'Bearer alice'}, payload: publish('alice')})).statusCode;
    try {
      expect(await join()).toBe(200);
      expect(await stored()).toBe('octo-cat');
      for (const failure of [500, 429, 'hang'] as const) {
        answer = failure;
        expect(await join(), String(failure)).toBe(200);
        expect(await stored(), String(failure)).toBe('octo-cat');
      }
      answer = 404;
      expect(await join()).toBe(200);
      expect(await stored()).toBeNull();
    } finally { await github.close(); }
  });

  it('answers 404 when the liked profile is withdrawn while the like is being stored', async () => {
    await joined('alice');
    await joined('bob');
    const withdrawal = await pool.connect();
    try {
      await withdrawal.query('BEGIN');
      await withdrawal.query(`DELETE FROM cloud_publications WHERE alias = 'bob'`);
      const liking = request('PUT', '/api/profiles/bob/like', 'alice');
      // The like found bob's profile and now waits on the withdrawal's row lock.
      await vi.waitFor(async () => expect((await pool.query<{count: number}>(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'`, [schema])).rows[0]!.count).toBe(1), {timeout: 4000});
      await withdrawal.query('COMMIT');
      const response = await liking;
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    } finally { await withdrawal.query('ROLLBACK'); withdrawal.release(); }
  });

  it('lets members like published profiles with a session or a computer credential', async () => {
    const alice = await joined('alice');
    await joined('bob');
    const like = (method: 'GET' | 'PUT' | 'DELETE', alias: string, token?: string) => request(method, `/api/profiles/${alias}/like`, token);
    const count = async () => (await pool.query<{count: number}>('SELECT count(*)::int AS count FROM cloud_likes')).rows[0]!.count;
    for (const token of [undefined, 'forged', 'ttd_forged']) {
      for (const method of ['GET', 'PUT', 'DELETE'] as const) expect((await like(method, 'bob', token)).statusCode).toBe(401);
    }
    await joined('carol');
    await request('DELETE', '/api/account', 'carol');
    await joined('peer1');
    await flag('peer1', '2026-10-23', 'hidden');
    for (const token of ['alice', alice.device.token]) {
      expect((await like('GET', 'bob', token)).json()).toEqual({liked: false});
      for (let attempt = 0; attempt < 2; attempt++) {
        const put = await like('PUT', 'BOB', token);
        expect(put.statusCode).toBe(204);
        expect(put.headers['cache-control']).toBe('no-store');
      }
      expect(await count()).toBe(1);
      const read = await like('GET', 'bob', token);
      expect(read.json()).toEqual({liked: true});
      expect(read.headers['cache-control']).toBe('no-store');
      for (let attempt = 0; attempt < 2; attempt++) expect((await like('DELETE', 'bob', token)).statusCode).toBe(204);
      expect((await like('GET', 'bob', token)).json()).toEqual({liked: false});
      const self = await like('PUT', 'alice', token);
      expect(self.statusCode).toBe(400);
      expect(self.json().error.code).toBe('INVALID_REQUEST');
      // Unknown, deleted, hidden or malformed.
      for (const alias of ['nobody', 'carol', 'peer1', 'x']) {
        for (const method of ['GET', 'PUT', 'DELETE'] as const) expect((await like(method, alias, token)).statusCode, `${method} ${alias}`).toBe(404);
      }
    }
    expect(await count()).toBe(0);
    // A signed-in account that has not joined may like; a revoked computer or a banned account may not.
    expect((await like('PUT', 'bob', 'carol')).statusCode).toBe(204);
    await request('DELETE', `/api/devices/${alice.device.id}`, 'alice');
    expect((await like('PUT', 'bob', alice.device.token)).statusCode).toBe(401);
    await pool.query(`INSERT INTO cloud_bans(account_id, reason) VALUES ($1, 'Hand entry')`, [accountId('alice')]);
    expect((await like('PUT', 'bob', 'alice')).json().error.code).toBe('BANNED');
    expect(await count()).toBe(1);
  });

  /** Stored badges as `{badge: [tier, value]}`. */
  const stored = async (who: string) => Object.fromEntries((await pool.query<{badge: string; tier: number; value: number}>(
    'SELECT badge, tier, value::float AS value FROM cloud_badges WHERE account_id = $1', [accountId(who)])).rows.map(row => [row.badge, [row.tier, row.value]]));
  const M = 1e6;
  const model = (day: string, tool: string, name: string, tokens: number, extra = {}) => bucket(tokens, {day, tool, model: name, ...extra});

  it('precomputes every badge on upload from published buckets, against visible members only', async () => {
    // Carol used m-b first but is hidden; bob used m-a two weeks before alice and uploads no tool split.
    const carol = await joined('carol', 'carol');
    await upload(carol, [model('2026-10-01', 'all', 'm-b', M)]);
    await flag('carol', '2026-10-01', 'hidden');
    const bob = await joined('bob', 'bob');
    await upload(bob, [model('2026-10-01', 'all', 'm-a', M)]);
    const alice = await joined('alice', 'alice');
    await upload(alice, [
      // Saturday and Sunday: 20M in the week starting 12 October.
      model('2026-10-17', 'claude', 'm-a', 10 * M), model('2026-10-18', 'claude', 'm-b', 10 * M),
      // 130M in the week starting 19 October: 6.5× growth.
      model('2026-10-19', 'codex', 'm-c', 50 * M), model('2026-10-20', 'claude', 'm-d', 20 * M), model('2026-10-21', 'claude', 'm-e', 20 * M),
      model('2026-10-22', 'claude', 'm-a', 10 * M), model('2026-10-23', 'codex', 'm-c', 30 * M),
    ]);
    expect(await stored('alice')).toEqual({
      'token-titan': [1, 150 * M], 'big-day': [1, 50 * M], marathoner: [1, 7], streak: [2, 7], 'weekend-warrior': [0, 2], momentum: [2, 650],
      veteran: [0, 6], podium: [4, 1], multitool: [1, 2], polyglot: [1, 5], trendsetter: [1, 4],
    });
    expect(await stored('bob')).toMatchObject({'token-titan': [0, M], multitool: [0, 0], polyglot: [0, 1], trendsetter: [0, 1], podium: [4, 1], veteran: [0, 22]});
    expect((await pool.query('SELECT best_rank FROM cloud_publications WHERE account_id = $1', [accountId('bob')])).rows).toEqual([{best_rank: 1}]);
  });

  it('raises badges as uploads grow, keeps the best rank through an edit, and clears both on a ban', async () => {
    const alice = await joined();
    await upload(alice, [bucket(150 * M)]);
    expect((await stored('alice'))['token-titan']).toEqual([1, 150 * M]);
    await upload(alice, [bucket(900 * M, {revision: 2}), bucket(200 * M, {day: null, revision: 2})]);
    // Undated usage counts toward the total, as on the all-time leaderboard.
    expect(await stored('alice')).toMatchObject({'token-titan': [2, 1100 * M], 'big-day': [3, 900 * M], podium: [4, 1]});
    // A member with no tokens yet is not ranked.
    await joined('bob');
    expect((await stored('bob')).podium).toEqual([0, 0]);
    const edited = (await request('PUT', '/api/publication', 'alice', publish('alice'))).json().publication;
    expect(await stored('alice')).toMatchObject({'token-titan': [0, 0], 'big-day': [0, 0], podium: [4, 1]});
    await upload({...alice, publication: edited}, [bucket(5 * M, {revision: 3})]);
    await repository.ban('alice', 'Invented logs');
    expect(await stored('alice')).toEqual({});
    expect((await pool.query('SELECT best_rank FROM cloud_publications WHERE account_id = $1', [accountId('alice')])).rows).toEqual([{best_rank: null}]);
  });

  it('counts a model as trendsetting up to seven days after its first day on the board', async () => {
    await upload(await joined('bob', 'bob'), [model('2026-10-09', 'all', 'm-late', M), model('2026-10-10', 'all', 'm-week', M)]);
    // Seven days after m-week's first day, eight after m-late's.
    await upload(await joined('alice', 'alice'), [model('2026-10-17', 'all', 'm-week', M), model('2026-10-17', 'all', 'm-late', M)]);
    expect((await stored('alice')).trendsetter).toEqual([0, 1]);
  });

  it('stores badges for concurrent uploads from several accounts without deadlocking', async () => {
    const who = ['alice', 'bob', 'carol', 'peer1'];
    const joins = [];
    for (const name of who) joins.push(await joined(name));
    for (const revision of [1, 2]) {
      const results = await Promise.all(joins.map((join, index) => upload(join, [bucket((index + 1) * revision * 10 * M, {revision})])));
      expect(results.map(result => result.statusCode)).toEqual([200, 200, 200, 200]);
    }
    for (const name of who) expect((await stored(name))['token-titan'], name).toEqual([0, (who.indexOf(name) + 1) * 20 * M]);
    expect((await stored('peer1')).podium).toEqual([4, 1]);
  });

  it('stores the same best rank as the leaderboard, ties broken by alias in code-point order', async () => {
    await upload(await joined('peer1', 'top'), [bucket(1000)]);
    // 'a-b' sorts before 'a_b' by code point; some locales order them the other way.
    const best = async (alias: string) => (await pool.query<{best_rank: number | null}>('SELECT best_rank FROM cloud_publications WHERE alias = $1', [alias])).rows[0]!.best_rank;
    const alice = await joined('alice', 'a_b');
    for (const [join, alias] of [[alice, 'a_b'], [await joined('bob', 'a-b'), 'a-b']] as const) {
      await upload(join, [bucket(100)]);
      expect(await best(alias), alias).toBe((await repository.profile(alias, 'all')).rank);
      expect(await best(alias), alias).toBe(2);
    }
    // A member with no tokens, or a hidden one, keeps the rank stored.
    await joined('carol');
    expect(await best('carol')).toBeNull();
    await flag('peer1', '2026-10-23', 'hidden');
    await flag('alice', '2026-10-23', 'hidden');
    await upload(alice, [bucket(5000, {revision: 2})]);
    expect(await best('a_b')).toBe(2);
  });

  it('skips badge work for an upload that changed nothing', async () => {
    const alice = await joined();
    await upload(alice, [bucket(150 * M)]);
    await pool.query(`UPDATE cloud_badges SET computed_at = '2000-01-01T00:00:00Z'`);
    const computed = async () => (await pool.query<{at: Date}>('SELECT DISTINCT computed_at AS at FROM cloud_badges WHERE account_id = $1', [accountId('alice')])).rows.map(row => row.at.toISOString());
    expect((await upload(alice, [bucket(150 * M)])).json()).toEqual({accepted: 0});
    expect((await request('POST', '/api/ingest', alice.device.token, {generation: alice.publication.generation, checkpoint: 1, buckets: []})).json()).toEqual({accepted: 0});
    expect(await computed()).toEqual(['2000-01-01T00:00:00.000Z']);
    expect((await upload(alice, [bucket(200 * M, {revision: 2})])).json()).toEqual({accepted: 1});
    expect(await computed()).not.toContain('2000-01-01T00:00:00.000Z');
    expect((await stored('alice'))['token-titan']).toEqual([1, 200 * M]);
  });

  it('adds likes from visible members, the day joined, a stored GitHub login and every badge to profiles', async () => {
    await upload(await joined('alice'), [bucket(150 * M)]);
    for (const who of ['bob', 'carol', 'peer1']) {
      await joined(who);
      expect((await request('PUT', '/api/profiles/alice/like', who)).statusCode).toBe(204);
    }
    // A hidden member's like does not count.
    await flag('peer1', '2026-10-23', 'hidden');
    await pool.query(`UPDATE cloud_accounts SET created_at = '2026-09-01T23:30:00Z', github_login = 'octo-cat' WHERE id = $1`, [accountId('alice')]);
    const stats = (await request('GET', '/api/profiles/alice/stats')).json();
    expect(stats).toMatchObject({likes: 2, memberSince: '2026-09-01', githubLogin: 'octo-cat'});
    expect(stats.badges.map((badge: {id: string}) => badge.id)).toEqual(BADGE_IDS);
    expect(stats.badges[0]).toEqual({id: 'token-titan', tier: 1, value: 150 * M, next: 1e9});
    expect(stats.badges[7]).toEqual({id: 'podium', tier: 4, value: 1, next: null});
    expect(stats.badges[8]).toEqual({id: 'multitool', tier: 0, value: 0, next: 2});
    const bob = (await request('GET', '/api/profiles/bob/stats')).json();
    expect(bob).toMatchObject({likes: 0, memberSince: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)});
    expect(bob).not.toHaveProperty('githubLogin');
  });

  it('shows the stored tier everywhere, so profiles, rows and rarity agree', async () => {
    await upload(await joined('alice'), [bucket(150 * M)]);
    // As after a threshold change, until badges are recomputed.
    await pool.query(`UPDATE cloud_badges SET tier = 3 WHERE badge = 'token-titan'`);
    expect((await request('GET', '/api/profiles/alice/stats')).json().badges[0]).toEqual({id: 'token-titan', tier: 3, value: 150 * M, next: 100e9});
    expect((await board()).items[0].topBadges).toEqual(['podium', 'token-titan', 'big-day']);
    expect((await repository.achievementRarity()).holders['token-titan']).toEqual([1, 1, 1, 0]);
  });

  it('shows each row its three highest badges, ties in display order', async () => {
    const alice = await joined('alice', 'alice');
    // Podium diamond, Big Day silver, then Token Titan and Multitool bronze.
    await upload(alice, [bucket(150 * M, {tool: 'claude'}), bucket(10 * M, {tool: 'codex', day: '2026-10-22'})]);
    await joined('bob');
    expect((await board()).items.map((item: {alias: string; topBadges?: string[]}) => [item.alias, item.topBadges])).toEqual([['alice', ['podium', 'big-day', 'token-titan']], ['bob', undefined]]);
    expect((await request('GET', '/api/profiles/alice?period=week')).json().topBadges).toEqual(['podium', 'big-day', 'token-titan']);
  });

  it('serves how many visible members hold each badge tier, cached for an hour', async () => {
    await upload(await joined('alice'), [bucket(150 * M)]);
    await upload(await joined('bob'), [bucket(20 * M)]);
    await upload(await joined('carol'), [bucket(5 * M)]);
    await upload(await joined('peer1'), [bucket(200 * M)]);
    await flag('peer1', '2026-10-23', 'hidden');
    const rarity = Fastify();
    await registerCloudRoutes(rarity, {repository, verifyAccount: async () => { throw new CloudError(401, 'UNAUTHORIZED', 'Unauthorized'); }});
    const load = vi.spyOn(repository, 'achievementRarity');
    try {
      const response = await rarity.inject('/api/achievements/rarity');
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      const body = response.json();
      expect(body.builders).toBe(3);
      expect(body.holders).toMatchObject({'token-titan': [1, 0, 0, 0], 'big-day': [2, 1, 0, 0], podium: [3, 3, 3, 3], marathoner: [0, 0, 0, 0]});
      expect(Object.keys(body.holders).sort()).toEqual([...BADGE_IDS].sort());
      // One shared snapshot a minute.
      await upload(await joined('peer2'), [bucket(5 * M)]);
      expect((await rarity.inject('/api/achievements/rarity')).json()).toEqual(body);
      expect(load).toHaveBeenCalledTimes(1);
      expect((await rarity.inject('/api/achievements/rarity?x=1')).statusCode).toBe(400);
    } finally { load.mockRestore(); await rarity.close(); }
  });

  it('serves the builders ranked just above and below a member, from the same rankings', async () => {
    for (const [who, tokens] of [['alice', 500], ['bob', 400], ['carol', 300], ['peer1', 200], ['peer2', 100]] as const) await upload(await joined(who), [bucket(tokens)]);
    // Peer3 leads this month but not this week.
    await upload(await joined('peer3'), [bucket(1000, {day: '2026-10-02'})]);
    await upload(await joined('peer4'), [bucket(5000)]);
    await flag('peer4', '2026-10-23', 'hidden');
    const around = async (alias: string, query = '') => {
      const response = await request('GET', `/api/leaderboard/around/${alias}${query}`);
      return response.statusCode === 200 ? response.json().items.map((item: {alias: string; rank: number}) => [item.alias, item.rank]) : response.statusCode;
    };
    expect(await around('carol')).toEqual([['bob', 2], ['carol', 3], ['peer1', 4]]);
    expect(await around('ALICE', '?period=week')).toEqual([['alice', 1], ['bob', 2]]);
    expect(await around('alice', '?period=month')).toEqual([['peer3', 1], ['alice', 2], ['bob', 3]]);
    expect(await around('peer2', '?period=all')).toEqual([['peer1', 5], ['peer2', 6]]);
    const rows = (await request('GET', '/api/leaderboard/around/alice?period=all')).json().items;
    expect(rows).toEqual((await board('&pageSize=3')).items);
    for (const missing of ['nobody', 'peer4', 'x']) expect(await around(missing)).toBe(404);
    expect(await around('alice', '?period=year')).toBe(400);
    expect(await around('alice', '?tool=claude')).toBe(400);
  });

  it('counts visible builders whose account was created in the last seven days', async () => {
    for (const who of ['alice', 'bob', 'carol', 'peer1']) await joined(who);
    await joined('peer2');
    await request('DELETE', '/api/account', 'peer2');
    await pool.query('UPDATE cloud_accounts SET created_at = $1', [new Date(now.getTime() - 86_400_000)]);
    await pool.query('UPDATE cloud_accounts SET created_at = $2 WHERE id = $1', [accountId('alice'), new Date(now.getTime() - 8 * 86_400_000)]);
    await flag('peer1', '2026-10-23', 'hidden');
    expect(await repository.community()).toMatchObject({builders: 3, newBuilders: 2});
  });

  it('resets the best rank when a person hides a day, or clears one the member has corrected', async () => {
    const best = async (alias: string) => (await pool.query<{best_rank: number | null}>('SELECT best_rank FROM cloud_publications WHERE alias = $1', [alias])).rows[0]!.best_rank;
    await upload(await joined('peer1', 'top'), [bucket(1000)]);
    // Cleared as it stood: the rank stands.
    await upload(await joined('carol'), [bucket(3000)]);
    await flag('carol', '2026-10-23', 'review', 3000);
    await repository.reviewFlag('carol', '2026-10-23', 'cleared', 'real usage');
    expect(await best('carol')).toBe(1);
    // Cleared after the member corrected the day downwards: the rank is taken from now.
    const bob = await joined('bob');
    await upload(bob, [bucket(5000)]);
    await flag('bob', '2026-10-23', 'review', 5000);
    await upload(bob, [bucket(500, {revision: 2})]);
    expect(await best('bob')).toBe(1);
    await repository.reviewFlag('bob', '2026-10-23', 'cleared', 'corrected');
    expect(await best('bob')).toBe(3);
    expect((await stored('bob')).podium).toEqual([4, 3]);
    // Hidden by a person: no best rank and no podium.
    await upload(await joined('alice'), [bucket(9000)]);
    await flag('alice', '2026-10-23', 'review', 9000);
    await repository.reviewFlag('alice', '2026-10-23', 'hidden', 'invented');
    expect(await best('alice')).toBeNull();
    expect((await stored('alice')).podium).toEqual([0, 0]);
  });

  it('recomputes every member’s badges from the operator command, leaving banned members without any', async () => {
    await upload(await joined('alice'), [bucket(150 * M)]);
    await upload(await joined('bob'), [bucket(20 * M)]);
    await joined('carol');
    await upload(await joined('peer1'), [bucket(200 * M)]);
    await repository.ban('peer1', 'Invented logs');
    await pool.query('DELETE FROM cloud_badges');
    expect(await operator(['recompute-badges'])).toMatchObject({code: 0, asked: [], lines: ['Recomputed badges for 3 member(s).']});
    expect(await stored('alice')).toMatchObject({'token-titan': [1, 150 * M], podium: [4, 1]});
    expect((await stored('bob'))['big-day']).toEqual([1, 20 * M]);
    expect(Object.keys(await stored('carol'))).toHaveLength(11);
    expect(await stored('peer1')).toEqual({});
    expect((await operator(['recompute-badges', 'alice'])).code).toBe(2);
  });

  it('never computes badges while serving the leaderboard', async () => {
    await upload(await joined(), [bucket(150 * M)]);
    await pool.query('DELETE FROM cloud_badges');
    for (const period of ['week', 'month', 'all']) expect((await request('GET', `/api/leaderboard?period=${period}`)).statusCode).toBe(200);
    expect((await request('GET', '/api/profiles/alice/stats')).statusCode).toBe(200);
    expect((await request('GET', '/api/leaderboard/around/alice')).statusCode).toBe(200);
    expect((await pool.query('SELECT 1 FROM cloud_badges')).rowCount).toBe(0);
  });

  it('audits stale hidden flags and hand-entered bans in counts only', async () => {
    await joined('alice');
    await joined('bob');
    await joined('carol');
    await pool.query(`INSERT INTO cloud_flags(account_id, day_key, tokens, rival_tokens, cohort_size, reasons, status, detected_at) VALUES
      ($1, '2026-10-19', 1, 0, 0, '{peers}', 'hidden', $3), ($1, '2026-10-22', 1, 0, 0, '{peers}', 'hidden', $4), ($2, '2026-10-22', 1, 0, 0, '{volume}', 'review', $4)`,
    [accountId('alice'), accountId('bob'), new Date(now.getTime() - TEST_MODERATION_POLICY.reviewWithinMs - 3_600_000), new Date(now.getTime() - 3_600_000)]);
    await pool.query(`INSERT INTO cloud_bans(account_id, reason) VALUES ($1, 'Hand entry'), ($2, 'Flagged first'), ('${'0'.repeat(64)}', 'Account since deleted')`, [accountId('carol'), accountId('bob')]);
    const audit = await operator(['audit']);
    expect(audit).toMatchObject({code: 1, lines: ['Hidden flags past the review deadline: 1', 'Open review flags: 1', 'Bans: 3, of which never flagged (re-review first): 1']});
    expect(audit.output).not.toMatch(/alice|bob|carol|[0-9a-f]{12}/);
    await pool.query(`UPDATE cloud_flags SET reviewed_at = now() WHERE day_key = '2026-10-19'`);
    expect((await operator(['audit'])).code).toBe(0);
  });

});

describe('plain SQL migrations', () => {
  it('are numbered once each and keep schema statements out of the runner', () => {
    const directory = migrationsDirectory();
    const versions = readdirSync(directory).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort().map(name => Number(name.slice(0, 4)));
    // Migrations are numbered 1, 2, 3… with no gap and no repeat.
    expect(versions).toEqual(Array.from({length: versions.length}, (_, index) => index + 1));
    expect(readdirSync(directory)).toContain('privileges.sql');
    const runner = readFileSync(new URL('../src/migrate.ts', import.meta.url), 'utf8');
    expect(runner).not.toMatch(/CREATE TABLE|ALTER TABLE|REVOKE/);
  });
});

describe('managed JWT verifier', () => {
  it('fails closed without configured managed identity', async () => {
    await expect(createAccountVerifier({})('anything')).rejects.toMatchObject({statusCode: 503, code: 'AUTH_NOT_CONFIGURED'});
    await expect(createAccountVerifier({issuer: 'https://identity.test', audience: 'authenticated', jwksUrl: 'http://insecure.test/jwks'})('anything')).rejects.toMatchObject({statusCode: 503});
  });
  it('verifies signature, issuer, audience and rejects anonymous accounts', async () => {
    const {privateKey, publicKey} = await generateKeyPair('ES256');
    const verifier = createAccountVerifier({issuer: 'https://identity.test', audience: 'authenticated', jwksUrl: 'https://identity.test/jwks'}, async () => publicKey);
    const sign = async (claims = {}, issuer = 'https://identity.test', audience = 'authenticated') => new SignJWT(claims).setProtectedHeader({alg: 'ES256'}).setSubject('owner').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    await expect(verifier(await sign())).resolves.toEqual({issuer: 'https://identity.test', subject: 'owner'});
    for (const token of [await sign({is_anonymous: true}), await sign({role: 'anon'}), await sign({role: 'service_role'}), await sign({}, 'https://untrusted.test'), await sign({}, 'https://identity.test', 'other-audience'), 'forged']) await expect(verifier(token)).rejects.toMatchObject({statusCode: 401});
    const other = await generateKeyPair('ES256');
    const forged = await new SignJWT({}).setProtectedHeader({alg: 'ES256'}).setSubject('owner').setIssuer('https://identity.test').setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(other.privateKey);
    await expect(verifier(forged)).rejects.toMatchObject({statusCode: 401});
    expect((await exportJWK(publicKey)).kty).toBe('EC');
  });
});
