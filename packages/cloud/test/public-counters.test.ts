import {TEST_MODERATION_POLICY} from './moderation-policy.ts';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import Fastify, {type FastifyInstance} from 'fastify';
import {Pool} from 'pg';
import {CloudError, migrateCloud, moderationCommand, PostgresCloudRepository, registerCloudRoutes} from '../src/index.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const now = new Date('2026-10-26T12:00:00.000Z');
const MAX = Number.MAX_SAFE_INTEGER;
const beyond = (BigInt(MAX) + 1n).toString();
const day = '2026-10-26';
const bucket = (tokens: number, costMicrousd: number | null, extra = {}) => ({day, tool: 'claude', tokens, costMicrousd, ...extra});
const healthyRoutes = [
  '/api/leaderboard?period=all', '/api/leaderboard?period=week', '/api/leaderboard?period=month',
  '/api/leaderboard?period=all&q=normal', '/api/leaderboard?period=all&tool=codex',
  '/api/leaderboard/around/normal?period=all', '/api/profiles/normal?period=all',
  '/api/profiles/normal/stats', '/api/community', '/badge/normal.svg',
  '/badge/normal.svg?metric=cost', '/badge/normal.svg?metric=rank', '/card/normal.svg',
];

describe.skipIf(!databaseUrl)('public counters with isolated PostgreSQL', () => {
  const schema = `counter_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let repository: PostgresCloudRepository;
  let app: FastifyInstance;
  const identity = (subject: string) => ({issuer: 'https://counter-test.invalid', subject});
  type Member = Awaited<ReturnType<typeof member>>;
  const sync = new Map<string, {checkpoint: number; receipt: string}>();
  const get = (url: string) => app.inject({url});
  const account = (alias: string) => app.inject({url: '/api/account', headers: {authorization: `Bearer ${alias}`}});

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/tokentracky_test' || url.username !== 'tokentracky') throw new Error('Counter tests require isolated loopback PostgreSQL');
    admin = new Pool({connectionString: databaseUrl});
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12});
    await migrateCloud(pool, {schema});
    repository = new PostgresCloudRepository(pool, () => now, schema, undefined, TEST_MODERATION_POLICY);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE cloud_accounts, cloud_bans CASCADE');
    sync.clear();
    app = Fastify();
    await registerCloudRoutes(app, {repository, verifyAccount: async token => identity(token)});
  });
  afterEach(async () => {vi.restoreAllMocks(); await app.close();});
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();}
  });

  async function member(alias: string) {
    const publication = await repository.putPublication(identity(alias), {alias});
    const started = await repository.startDeviceAuthorization({deviceName: 'Counter test computer'});
    await repository.approveDeviceAuthorization(identity(alias), started.userCode);
    const approved = await repository.pollDeviceAuthorization(started.pollToken);
    if (approved.status !== 'approved') throw new Error('Computer not approved');
    const device = {id: (await repository.account(identity(alias))).devices[0]!.id, token: approved.deviceToken};
    return {alias, publication, device, collectorId: randomUUID()};
  }
  async function upload(m: Member, buckets: ReturnType<typeof bucket>[]) {
    const prior = sync.get(m.device.token);
    const checkpoint = (prior?.checkpoint ?? 0) + 1;
    const receipt = randomUUID();
    const response = await app.inject({method: 'POST', url: '/api/ingest', headers: {authorization: `Bearer ${m.device.token}`}, payload: {
      generation: m.publication.generation, collectorId: m.collectorId, checkpoint, receipt, baseReceipt: prior?.receipt ?? null,
      buckets: buckets.map(b => ({...b, revision: checkpoint})),
    }});
    if (response.statusCode === 200) sync.set(m.device.token, {checkpoint, receipt});
    return response;
  }
  async function assertHealthy() {
    for (const url of healthyRoutes) {
      const response = await get(url);
      expect(response.statusCode, url + ': ' + response.body).toBe(200);
      if (url.startsWith('/badge/') || url.startsWith('/card/')) expect(response.headers['content-type']).toContain('image/svg+xml');
    }
  }

  it('serves healthy profiles, filters and embeds after an accepted extreme cost, and recovers exact totals after correction', async () => {
    const normal = await member('normal'), extreme = await member('extreme');
    expect((await upload(normal, [bucket(10, 1)])).statusCode).toBe(200);
    expect((await upload(extreme, [bucket(1, MAX)])).statusCode).toBe(200);
    await assertHealthy();
    const board = (await get('/api/leaderboard?period=all')).json();
    expect(board).toMatchObject({totalTokens: 11, totalCostMicrousd: MAX, exactAggregates: {totalCostMicrousd: beyond}});
    expect((await get('/api/profiles/normal/stats')).json().costMicrousd).toBe(1);
    expect((await get('/api/leaderboard?period=all&sort=cost&pageSize=1')).json().items[0].alias).toBe('extreme');
    expect((await upload(extreme, [bucket(1, 0)])).statusCode).toBe(200);
    expect((await get('/api/leaderboard?period=all')).json()).toMatchObject({totalCostMicrousd: 1});
    expect((await get('/api/leaderboard?period=all')).json()).not.toHaveProperty('exactAggregates');
  });

  it('accepts concurrent independent uploads whose combined cost exceeds the safe range', async () => {
    const members = await Promise.all(['normal', 'second', 'third'].map(member));
    const amount = Math.floor(MAX / 2);
    const responses = await Promise.all(members.map(m => upload(m, [bucket(1, amount)])));
    expect(responses.map(r => r.statusCode)).toEqual([200, 200, 200]);
    const response = await get('/api/community');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({builders: 3, totalCostMicrousd: MAX, exactAggregates: {totalCostMicrousd: (3n * BigInt(amount)).toString()}});
  });

  it('keeps cohort totals through search, empty pagination and mixed known costs', async () => {
    const normal = await member('normal'), extreme = await member('extreme'), unknown = await member('unknown');
    await upload(normal, [bucket(1, 0)]);
    await upload(extreme, [bucket(2, MAX)]);
    await upload(unknown, [bucket(3, 1), bucket(1, null, {day: '2026-10-25'})]);
    for (const suffix of ['&q=normal', '&q=nobody', '&page=10&pageSize=1']) {
      expect((await get('/api/leaderboard?period=all' + suffix)).json()).toMatchObject({builders: 3, totalTokens: 7, totalCostMicrousd: MAX});
    }
    expect((await get('/api/leaderboard?period=all&q=nobody')).json().items).toEqual([]);
    expect((await get('/api/profiles/normal')).json().costMicrousd).toBe(0);
    expect((await get('/api/profiles/unknown?period=all')).json().costMicrousd).toBeNull();
    // All-time unknown cost does not mask a known window total in the diagnostic.
    await upload(unknown, [bucket(3, 1), bucket(1, null, {day: '2026-09-01'}), bucket(0, 0, {day: '2026-10-25'})]);
    expect(await repository.counterAudit()).toEqual({invalidAccounts: 0, overflowFamilies: 1});
    await repository.deleteAccount(identity('extreme'));
    expect((await get('/api/leaderboard?period=week')).json()).toMatchObject({builders: 2, totalCostMicrousd: 1});
  });

  it('expires community snapshots, retries failures and emits only count telemetry for public overflow', async () => {
    await upload(await member('normal'), [bucket(1, 1)]);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const load = vi.spyOn(repository, 'community');
    const log = vi.spyOn(repository, 'publicCounterFailure');
    load.mockRejectedValueOnce(new CloudError(422, 'COUNTER_OVERFLOW', 'Synthetic failure'));
    const failed = await get('/api/community');
    expect(failed.statusCode).toBe(422);
    expect(failed.headers['cache-control']).toBe('no-store');
    expect(log).toHaveBeenCalledTimes(1);
    expect((await get('/api/community')).statusCode).toBe(200);
    expect(load).toHaveBeenCalledTimes(2);
    await get('/api/community');
    expect(load).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(61_001);
    expect((await get('/api/community')).headers['cache-control']).toBe('public, max-age=60');
    expect(load).toHaveBeenCalledTimes(3);
    const events: unknown[] = [];
    new PostgresCloudRepository(pool, () => now, schema, event => events.push(event), TEST_MODERATION_POLICY).publicCounterFailure();
    expect(events).toEqual([{event: 'public_counter_overflow', count: 1}]);
  });

  it('provides a count-only integrity audit and permits resetting held publication', async () => {
    const extreme = await member('extreme');
    await upload(extreme, [bucket(1, 1), bucket(1, 1, {day: '2026-10-25'})]);
    await pool.query('UPDATE cloud_buckets SET tokens = $1 WHERE device_id = $2 AND day_key = $3', [MAX, extreme.device.id, day]);
    const lines: string[] = [];
    const io = {print: (line: string) => lines.push(line), ask: async () => {throw new Error('Read-only audit cannot ask for confirmation');}};
    expect(await moderationCommand(repository, ['counter-audit'], io)).toBe(1);
    expect(lines).toEqual(['Account integrity holds: 1', 'Shared aggregate families using exact decimal values: 0']);
    await repository.putPublication(identity('extreme'), {alias: 'extreme'});
    expect(await repository.counterAudit()).toEqual({invalidAccounts: 0, overflowFamilies: 0});
    expect((await get('/api/profiles/extreme')).statusCode).toBe(200);
  });

  it('serializes wide totals by token, tool, day and kind, while every JSON number stays safe', async () => {
    const normal = await member('normal'), extreme = await member('extreme');
    const typed = (tokens: number) => bucket(tokens, null, {breakdown: {input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0}});
    expect((await upload(normal, [typed(1)])).statusCode).toBe(200);
    expect((await upload(extreme, [typed(MAX)])).statusCode).toBe(200);
    const response = await get('/api/community');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({totalTokens: MAX, totalCostMicrousd: null, toolTotals: {claude: MAX}, breakdown: {input: MAX}, exactAggregates: {
      totalTokens: beyond, toolTotals: {claude: beyond}, breakdown: {input: beyond, output: '0', cacheRead: '0', cacheWrite: '0', reasoning: '0'},
    }});
    expect(body.exactAggregates.trend.at(-1)).toEqual({day, tokens: beyond});
    const inspect = (value: unknown): void => {
      if (typeof value === 'number') expect(Number.isSafeInteger(value)).toBe(true);
      else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
    };
    inspect(body);
    expect((await get('/api/profiles/normal')).statusCode).toBe(200);
  });

  it('does not fetch shared trends or aggregate spend for a profile, stats, neighbours or embeds', async () => {
    await upload(await member('normal'), [bucket(10, 1)]);
    const query = vi.spyOn(pool, 'connect');
    for (const url of ['/api/profiles/normal', '/api/profiles/normal/stats', '/api/leaderboard/around/normal', '/badge/normal.svg', '/card/normal.svg']) {
      query.mockClear();
      const response = await get(url);
      expect(response.statusCode).toBe(200);
      // Detailed stats, too, use one consistent snapshot rather than three independent boards.
      expect(query).toHaveBeenCalledTimes(1);
    }
    query.mockRestore();
  });

  it('rolls back a replacement that unmasks an unsafe account cost, then permits correction and retry', async () => {
    const normal = await member('normal');
    const machineId = 'a'.repeat(64);
    const start = async () => {
      const auth = await repository.startDeviceAuthorization({deviceName: 'Masking computer', machineId});
      await repository.approveDeviceAuthorization(identity('normal'), auth.userCode);
      return auth;
    };
    const auth = await start();
    const approved = await repository.pollDeviceAuthorization(auth.pollToken);
    if (approved.status !== 'approved') throw new Error('Computer not approved');
    const masking = {...normal, device: {id: '', token: approved.deviceToken}, collectorId: randomUUID()};
    expect((await upload(masking, [bucket(1, null)])).statusCode).toBe(200);
    expect((await upload(normal, [bucket(1, MAX), bucket(1, 1, {day: '2026-10-25'})])).statusCode).toBe(200);
    const next = await start();
    const before = (await pool.query('SELECT * FROM cloud_devices ORDER BY id')).rows;
    const beforeBuckets = (await pool.query('SELECT * FROM cloud_buckets ORDER BY device_id, day_key')).rows;
    await expect(repository.pollDeviceAuthorization(next.pollToken)).rejects.toMatchObject({statusCode: 422, code: 'COUNTER_OVERFLOW'});
    expect((await pool.query('SELECT * FROM cloud_devices ORDER BY id')).rows).toEqual(before);
    expect((await pool.query('SELECT * FROM cloud_buckets ORDER BY device_id, day_key')).rows).toEqual(beforeBuckets);
    expect((await repository.devicePublication(masking.device.token)).alias).toBe('normal');
    expect((await upload(normal, [bucket(1, 0)])).statusCode).toBe(200);
    expect((await repository.pollDeviceAuthorization(next.pollToken)).status).toBe('approved');
    expect((await get('/api/profiles/normal')).statusCode).toBe(200);
  });

  it.each(['tokens', 'cost_microusd'])('isolates a legacy invalid %s account and lets its owner repair it', async field => {
    const normal = await member('normal'), extreme = await member('extreme');
    await upload(normal, [bucket(10, 1)]);
    await upload(extreme, [bucket(1, 1), bucket(1, 1, {day: '2026-10-25'})]);
    await repository.like({identity: identity('extreme')}, 'normal', true);
    await pool.query(`UPDATE cloud_buckets SET ${field} = $1 WHERE device_id = $2 AND day_key = $3`, [MAX, extreme.device.id, day]);
    await assertHealthy();
    expect((await get('/api/leaderboard?period=all')).json()).toMatchObject({builders: 1, totalTokens: 10, totalCostMicrousd: 1});
    expect((await get('/api/profiles/normal/stats')).json().likes).toBe(0);
    expect((await get('/api/achievements/rarity')).json().builders).toBe(1);
    expect((await get('/api/profiles/extreme')).statusCode).toBe(503);
    expect((await account('extreme')).json().integrity).toEqual({state: 'unavailable', reason: 'COUNTER_OVERFLOW'});
    expect((await pool.query('SELECT 1 FROM cloud_bans')).rowCount).toBe(0);
    expect((await upload(extreme, [bucket(1, 0)])).statusCode).toBe(200);
    expect((await get('/api/profiles/extreme')).statusCode).toBe(200);
    expect((await account('extreme')).json()).not.toHaveProperty('integrity');
    expect((await get('/api/profiles/normal/stats')).json().likes).toBe(1);
    expect((await repository.profileStats('normal')).likes).toBe(1);
  });
});
