import {TEST_MODERATION_POLICY} from '../../packages/cloud/test/moderation-policy.ts';
import {randomUUID} from 'node:crypto';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {afterAll, describe, expect, it, vi} from 'vitest';
import {CloudError, migrateCloud, migrationsDirectory, PostgresCloudRepository, registerCloudRoutes} from '@tokentracky/cloud';
import {claude} from './fixtures.ts';
import {external, startServer, type Json, type Server} from './runner.ts';
import {configure, expectError, FIXTURE_DAY, getJson, logRoots, refresh, writeLog} from './support.ts';

// The local-to-hosted flow against the real hosted API (the TypeScript one, on PostgreSQL): import, upload, retry, downward
// correction, leaving by account deletion, browser approval, and the one widening of a publication saved before sharing was
// fixed. It needs the isolated test database of CI and a server the runner starts, since the local server is pointed at the
// hosted one through its environment.
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const SKIP = !DATABASE_URL ? 'TEST_DATABASE_URL is not set' : external ? 'the local server was started outside the runner (CONTRACT_BASE_URL or CONTRACT_LAUNCH_URL)' : null;
if (SKIP) console.warn(`Hosted flow skipped: ${SKIP}. Set TEST_DATABASE_URL (see tests/contract/README.md) and let the runner start the server to run it.`);

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const DAY = `from=${FIXTURE_DAY}&to=${FIXTURE_DAY}`;
// The model id is not here: every publication shares the model mix.
const SECRETS = ['PRIVATE_PROMPT_MARKER', 'private-project', 'claude-session', 'private-account-id', 'msg-1'];
const FIXED_SHARING = Number(readdirSync(migrationsDirectory()).find(name => /^\d{4}_fixed_sharing\.sql$/.test(name))!.slice(0, 4));

/** The hosted API on a private schema of the test database, with a hook recording every upload and able to fail the next ones. */
async function hostedService() {
  const url = new URL(DATABASE_URL!);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/tokentracky_test' || url.username !== 'tokentracky') throw new Error('Use only the isolated loopback test database');
  const pool = new Pool({connectionString: url.toString(), max: 4});
  const schema = 'contract_' + randomUUID().replaceAll('-', '');
  cleanup.push(async () => {await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end();});
  await migrateCloud(pool, {schema});
  const app = Fastify();
  const uploads: Json[] = [];
  const failures = {uploads: 0};
  app.addHook('preHandler', async (request, reply) => {
    if (request.url !== '/api/ingest') return;
    uploads.push(request.body);
    if (failures.uploads > 0) {failures.uploads--; return reply.code(503).send({error: {code: 'SERVICE_UNAVAILABLE', message: 'Unavailable.'}});}
  });
  await registerCloudRoutes(app, {repository: new PostgresCloudRepository(pool, undefined, schema, undefined, TEST_MODERATION_POLICY), verifyAccount: async token => {
    if (token !== 'synthetic-account') throw new CloudError(401, 'UNAUTHORIZED', 'Unauthorized');
    return {issuer: 'https://synthetic.example', subject: 'private-account-id'};
  }});
  const origin = await app.listen({host: '127.0.0.1', port: 0});
  cleanup.push(() => app.close());
  const account = (path: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', body?: Record<string, unknown>) => app.inject({url: path, method, headers: {authorization: 'Bearer synthetic-account'}, payload: body});
  // A computer linked the way the apps do it: start, browser approval, pickup.
  const device = async () => {
    const started = (await app.inject({url: '/api/device-auth', method: 'POST', payload: {deviceName: 'contract machine'}})).json();
    expect((await account(`/api/device-auth/${started.userCode}/approve`, 'POST')).statusCode).toBe(204);
    const picked = await app.inject({url: '/api/device-auth/poll', method: 'POST', headers: {authorization: `Bearer ${started.pollToken}`}});
    return {token: picked.json().deviceToken as string};
  };
  // A publication as saved before sharing was fixed (daily totals only), and the fixed-sharing migration run again over it.
  const totalsOnly = () => pool.query(`UPDATE ${schema}.cloud_publications SET share_tools = false, share_cost = false, share_models = false`);
  const fixSharing = async () => {
    await pool.query(`DELETE FROM ${schema}.cloud_migrations WHERE version = $1`, [FIXED_SHARING]);
    await migrateCloud(pool, {schema});
  };
  return {origin, uploads, failures, account, device, totalsOnly, fixSharing};
}
type Hosted = Awaited<ReturnType<typeof hostedService>>;
const publish = (hosted: Hosted, alias = 'contract-builder') => hosted.account('/api/publication', 'PUT', {alias});

/** A local server pointed at the hosted one, with one Claude Code log imported and its totals current. */
async function localServer(hosted: Hosted, tokens: [input: number, output: number] = [11, 20]) {
  const server = await startServer({cloudUrl: hosted.origin});
  const roots = logRoots(server);
  const file = join(roots.claude, 'p', 'session.jsonl');
  await writeLog(file, claude('msg-1', ...tokens));
  expect((await configure(server, 'claude', true, [roots.claude])).status).toBe(200);
  await refresh(server);
  return {server, file};
}
const board = async (server: Server, query = 'period=all') => (await getJson(server, `/api/leaderboard?${query}`)).items;
const link = (server: Server, hosted: Hosted, token: string, change: Record<string, unknown> = {}) => server.request('/api/local/cloud', {method: 'PUT', json: {url: hosted.origin, deviceToken: token, historyStart: null, shareTools: true, shareCost: true, shareModels: true, ...change}});
const TOTALS_ONLY = {shareTools: false, shareCost: false, shareModels: false};
/** The board row of a member whose Claude Code usage is published with its tool split and estimated cost. */
// The app sends hours, so the 24-hour figure is there; the fixture's usage is days old.
const row = (alias: string, tokens: number) => ({alias, rank: 1, previousRank: 1, tokens, daily: expect.any(Array), last24hTokens: 0, toolTokens: {claude: tokens}, costMicrousd: expect.any(Number), topBadges: ['podium']});

describe.skipIf(SKIP !== null)(`local-to-hosted flow${SKIP ? ` (skipped: ${SKIP})` : ''}`, () => {
  it('imports, uploads, retries, corrects downwards and leaves by deleting the account, without private payloads', async () => {
    const hosted = await hostedService();
    // Joining happens on the hosted site: the member publishes an alias, then links a computer through browser approval.
    expect((await publish(hosted)).statusCode).toBe(200);
    const device = await hosted.device();
    const {server, file} = await localServer(hosted);
    expect((await getJson(server, `/api/local/summary?${DAY}`)).tokens).toBe(161);
    expect(await getJson(server, '/api/health')).toMatchObject({mode: 'local', cloudUrl: hosted.origin});

    // Link and upload. A repeated upload changes nothing hosted.
    const linked = await link(server, hosted, device.token);
    expect({status: linked.status, body: linked.json()}).toEqual({status: 200, body: {linked: true}});
    expect(await getJson(server, '/api/local/status')).toMatchObject({cloudLinked: true, alias: 'contract-builder', syncError: null});
    for (let attempt = 0; attempt < 2; attempt++) {
      const synced = await server.request('/api/local/sync', {method: 'POST'});
      expect(synced.status).toBe(200);
      expect(synced.json()).toEqual({syncedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/)});
    }
    expect(await board(server)).toEqual([row('contract-builder', 161)]);
    expect(await getJson(server, '/api/profiles/contract-builder?period=all')).toMatchObject({alias: 'contract-builder', rank: 1, tokens: 161});
    expect(hosted.uploads.at(-1).buckets).toEqual([{day: FIXTURE_DAY, tool: 'claude', model: 'claude-sonnet-4-6', tokens: 161, breakdown: {input: 11, output: 20, cacheRead: 100, cacheWrite: 30, reasoning: 7}, costMicrousd: expect.any(Number), revision: expect.any(Number)}]);
    expect(await getJson(server, '/api/local/status')).toMatchObject({lastSyncAt: expect.any(String), syncError: null});

    // Retry: a failed upload reports 502 and the next one succeeds without counting twice. New usage gives it something
    // to send (a repeat with none posts nothing); the refresh cycle's own uploads fail as well.
    await writeLog(file, claude('msg-1', 11, 20), claude('msg-2', 5, 6));
    hosted.failures.uploads = Infinity;
    await refresh(server);
    expectError(await server.request('/api/local/sync', {method: 'POST'}), 502, 'SYNC_FAILED');
    expect(await getJson(server, '/api/local/status')).toMatchObject({syncError: 'SYNC_FAILED'});
    hosted.failures.uploads = 0;
    expect((await server.request('/api/local/sync', {method: 'POST'})).status).toBe(200);
    const [failed, retried] = hosted.uploads.slice(-2);
    expect(retried.receipt).toBe(failed.receipt);
    expect(retried.buckets).toEqual(failed.buckets);
    expect(await board(server)).toMatchObject([{tokens: 302}]);

    // Downward correction: the log now says less, and the hosted total goes down with it.
    await writeLog(file, claude('msg-1', 1, 2));
    await refresh(server);
    expect((await server.request('/api/local/sync', {method: 'POST'})).status).toBe(200);
    expect(await board(server)).toMatchObject([{tokens: 133}]);

    // Nothing private was ever sent.
    for (const upload of hosted.uploads) {
      expect(Object.keys(upload).sort()).toEqual(['baseReceipt', 'buckets', 'checkpoint', 'collectorId', 'generation', 'hours', 'receipt']);
      for (const bucket of upload.buckets) {
        expect(Object.keys(bucket).sort()).toEqual(['breakdown', 'costMicrousd', 'day', 'model', 'revision', 'tokens', 'tool']);
        expect(Object.keys(bucket.breakdown).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output', 'reasoning']);
      }
    }
    const wire = JSON.stringify(hosted.uploads);
    for (const secret of SECRETS) expect(wire).not.toContain(secret);

    // Leaving: there is no route to withdraw the publication, so the member deletes the account. The device is refused and
    // the leaderboard forgets it; local usage stays.
    expect((await hosted.account('/api/publication', 'DELETE')).statusCode).toBe(404);
    expect(await board(server)).toMatchObject([{tokens: 133}]);
    expect((await hosted.account('/api/account', 'DELETE')).statusCode).toBe(204);
    expectError(await server.request('/api/local/sync', {method: 'POST'}), 409, 'RELINK_REQUIRED');
    expect(await board(server)).toEqual([]);
    expect((await getJson(server, `/api/local/summary?${DAY}`)).tokens).toBe(133);
    expect((await server.request('/api/local/cloud', {method: 'DELETE'})).status).toBe(204);
    expect(await getJson(server, '/api/local/status')).toMatchObject({cloudLinked: false, alias: null, syncError: null});
  });

  it('joins through browser approval without ever handling a device token', async () => {
    const hosted = await hostedService();
    const {server} = await localServer(hosted);
    expectError(await server.request('/api/local/connect/poll', {method: 'POST'}), 409, 'CONNECT_NOT_STARTED');
    const started = (await server.request('/api/local/connect', {method: 'POST'})).json();
    expect(started).toEqual({userCode: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/), verificationUrl: `${hosted.origin}/?connect=${started.userCode}`, expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/)});
    expect((await server.request('/api/local/connect/poll', {method: 'POST'})).json()).toEqual({status: 'pending'});
    // The member signs in on the hosted site. Approval needs a published alias first.
    expect((await hosted.account(`/api/device-auth/${started.userCode}/approve`, 'POST')).json().error.code).toBe('NOT_PUBLISHED');
    expect((await server.request('/api/local/connect/poll', {method: 'POST'})).json()).toEqual({status: 'pending'});
    expect((await publish(hosted, 'browser-builder')).statusCode).toBe(200);
    expect((await hosted.account(`/api/device-auth/${started.userCode}/approve`, 'POST')).statusCode).toBe(204);
    expect((await server.request('/api/local/connect/poll', {method: 'POST'})).json()).toEqual({status: 'connected', alias: 'browser-builder'});
    // Success is reported after a first upload, so the standing is there at once.
    await vi.waitFor(async () => expect(await board(server)).toEqual([row('browser-builder', 161)]));
    expect(await getJson(server, '/api/local/status')).toMatchObject({cloudLinked: true, alias: 'browser-builder', syncError: null});
    expectError(await server.request('/api/local/connect/poll', {method: 'POST'}), 409, 'CONNECT_NOT_STARTED');
  });

  it('widens a publication saved before sharing was fixed once, and the device publishes everything after it is linked again', async () => {
    const hosted = await hostedService();
    expect((await publish(hosted)).statusCode).toBe(200);
    await hosted.totalsOnly();
    const device = await hosted.device();
    const {server} = await localServer(hosted);
    expect((await link(server, hosted, device.token, TOTALS_ONLY)).status).toBe(200);
    expect((await server.request('/api/local/sync', {method: 'POST'})).status).toBe(200);
    expect(hosted.uploads.at(-1).buckets).toEqual([{day: FIXTURE_DAY, tool: 'all', tokens: 161, breakdown: {input: 11, output: 20, cacheRead: 100, cacheWrite: 30, reasoning: 7}, costMicrousd: null, revision: expect.any(Number)}]);
    expect(await board(server)).toEqual([{alias: 'contract-builder', rank: 1, previousRank: 1, tokens: 161, daily: expect.any(Array), last24hTokens: 0, topBadges: ['podium']}]);

    // The migration widens the publication under a new generation and clears its totals. Uploading the wider scope needs
    // the device to be linked again, to exactly the published scope.
    await hosted.fixSharing();
    expect(await board(server)).toMatchObject([{alias: 'contract-builder', tokens: 0}]);
    const posted = hosted.uploads.length;
    expectError(await server.request('/api/local/sync', {method: 'POST'}), 409, 'RELINK_REQUIRED');
    expect(await getJson(server, '/api/local/status')).toMatchObject({syncError: 'RELINK_REQUIRED'});
    expect(hosted.uploads).toHaveLength(posted);
    expectError(await link(server, hosted, device.token, TOTALS_ONLY), 400, 'SCOPE_NOT_PUBLISHED');
    expect((await link(server, hosted, device.token)).status).toBe(200);
    expect((await server.request('/api/local/sync', {method: 'POST'})).status).toBe(200);
    expect(hosted.uploads.at(-1).buckets).toEqual([{day: FIXTURE_DAY, tool: 'claude', model: 'claude-sonnet-4-6', tokens: 161, breakdown: {input: 11, output: 20, cacheRead: 100, cacheWrite: 30, reasoning: 7}, costMicrousd: expect.any(Number), revision: expect.any(Number)}]);
    expect(await board(server)).toEqual([row('contract-builder', 161)]);
  });
});
