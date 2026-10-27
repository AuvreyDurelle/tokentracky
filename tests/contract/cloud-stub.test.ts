import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {claude} from './fixtures.ts';
import {external, startServer, type Server} from './runner.ts';
import {configure, expectError, FIXTURE_DAY, getJson, logRoots, refresh, writeLog} from './support.ts';
import {stubService, type Stub} from './stub-service.ts';

// What the local server sends to the hosted API and how it reports the answers, against a stub of the hosted API that
// records every call. The stub is not the hosted implementation: tests/contract/hosted-flow.test.ts runs the real one.
// The runner must start the local server (it sets TOKENTRACKY_CLOUD_URL), so none of this runs against a server that was already running.
const ISO = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const UUID = expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const TOKEN = 'device-token-' + 'x'.repeat(30);
const bearer = (token: string) => `Bearer ${token}`;
// The hosted API publishes all history with the tool split, model mix and cost.
const publication = (change: Record<string, unknown> = {}) => ({alias: 'stub-builder', historyStart: null, shareTools: true, shareCost: true, shareModels: true, generation: randomUUID(), ...change});
/** What a publication saved before sharing was fixed allowed: daily totals only. */
const TOTALS_ONLY = {shareTools: false, shareCost: false, shareModels: false};
const NOT_FOUND = {status: 404, json: {error: {code: 'NOT_FOUND', message: 'Not found.'}}};

describe.skipIf(external)('leaderboard, profile and profile stats proxies', () => {
  let server: Server;
  let stub: Stub;
  beforeAll(async () => {
    stub = await stubService();
    server = await startServer({cloudUrl: stub.url});
  });
  afterAll(async () => {await stub.close();});

  it('reports the configured hosted service in the health', async () => {
    expect(await getJson(server, '/api/health')).toEqual({mode: 'local', authConfigured: false, version: expect.any(String), cloudUrl: stub.url, supabaseUrl: null, supabaseAnonKey: null, authProviders: []});
  });
  it('relays the hosted answer unchanged, sending only the query and no credentials of the local session', async () => {
    const board = {items: [{alias: 'someone', rank: 1, tokens: 12, daily: [0, 12]}], total: 1, page: 2, pageSize: 20};
    stub.on('GET /api/leaderboard', {json: board});
    const reply = await server.request('/api/leaderboard?period=all&tool=claude&page=2&q=some%20one');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    expect(reply.json()).toEqual(board);
    const [call] = stub.to('GET /api/leaderboard');
    expect(call!.query).toEqual({period: 'all', tool: 'claude', page: '2', q: 'some one'});
    expect(call!.headers.accept).toBe('application/json');
    expect(call!.headers.cookie).toBeUndefined();
    expect(call!.headers.authorization).toBeUndefined();
  });
  it('relays a profile by alias, with the alias escaped in the path', async () => {
    const profile = {alias: 'builder_1', rank: 3, tokens: 99, daily: []};
    stub.on('GET /api/profiles/builder_1', {json: profile});
    expect((await server.request('/api/profiles/builder_1?period=week')).json()).toEqual(profile);
    expect(stub.to('GET /api/profiles/builder_1')[0]!.query).toEqual({period: 'week'});
    stub.on('GET /api/profiles/x%20y', {json: profile});
    expect((await server.request('/api/profiles/x%20y')).json()).toEqual(profile);
  });
  it('relays profile stats by alias, with the alias escaped in the path, forwarding only single-valued query parameters and no credentials', async () => {
    const stats = {alias: 'builder_1', periods: {week: {rank: 3, tokens: 99}, month: {rank: 2, tokens: 120}, all: {rank: 1, tokens: 400}}};
    stub.on('GET /api/profiles/builder_1/stats', {json: stats});
    const reply = await server.request('/api/profiles/builder_1/stats');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    expect(reply.json()).toEqual(stats);
    const [call] = stub.to('GET /api/profiles/builder_1/stats');
    expect(call!.query).toEqual({});
    expect(call!.headers.accept).toBe('application/json');
    expect(call!.headers.cookie).toBeUndefined();
    expect(call!.headers.authorization).toBeUndefined();
    expect((await server.request('/api/profiles/builder_1/stats?period=week&tool=a&tool=b')).json()).toEqual(stats);
    expect(stub.to('GET /api/profiles/builder_1/stats')[1]!.query).toEqual({period: 'week'});
    stub.on('GET /api/profiles/x%20y/stats', {json: stats});
    expect((await server.request('/api/profiles/x%20y/stats')).json()).toEqual(stats);
  });
  it('answers 404 CLOUD_UNAVAILABLE when the hosted service has no such page', async () => {
    stub.on('GET /api/profiles/nobody', NOT_FOUND);
    expectError(await server.request('/api/profiles/nobody'), 404, 'CLOUD_UNAVAILABLE');
    stub.on('GET /api/profiles/nobody/stats', NOT_FOUND);
    expectError(await server.request('/api/profiles/nobody/stats'), 404, 'CLOUD_UNAVAILABLE');
  });
  it.each([[500], [503], [429], [403], [400]])('answers 502 CLOUD_UNAVAILABLE when the hosted service answers %i', async status => {
    stub.on('GET /api/leaderboard', {status, json: {error: {code: 'X', message: 'x'}}});
    expectError(await server.request('/api/leaderboard'), 502, 'CLOUD_UNAVAILABLE');
    stub.on('GET /api/profiles/builder_1/stats', {status, json: {error: {code: 'X', message: 'x'}}});
    expectError(await server.request('/api/profiles/builder_1/stats'), 502, 'CLOUD_UNAVAILABLE');
  });
  it('answers 502 CLOUD_UNAVAILABLE for a redirect, which is never followed, and for a body that is not JSON', async () => {
    stub.on('GET /api/leaderboard', {status: 302, headers: {location: `${stub.url}/api/elsewhere`}});
    expectError(await server.request('/api/leaderboard'), 502, 'CLOUD_UNAVAILABLE');
    expect(stub.to('GET /api/elsewhere')).toEqual([]);
    stub.on('GET /api/leaderboard', {text: '<html>not json</html>'});
    expectError(await server.request('/api/leaderboard'), 502, 'CLOUD_UNAVAILABLE');
  });
});

describe.skipIf(external)('a hosted service that cannot be reached', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const stub = await stubService();
    url = stub.url;
    await stub.close();
    server = await startServer({cloudUrl: url});
  });
  it('answers 502 for the proxies and for connecting, and still serves local usage', async () => {
    expect((await getJson(server, '/api/health')).cloudUrl).toBe(url);
    expectError(await server.request('/api/leaderboard'), 502, 'CLOUD_UNAVAILABLE');
    expectError(await server.request('/api/profiles/someone'), 502, 'CLOUD_UNAVAILABLE');
    expectError(await server.request('/api/profiles/someone/stats'), 502, 'CLOUD_UNAVAILABLE');
    expectError(await server.request('/api/local/connect', {method: 'POST'}), 502, 'CONNECT_FAILED');
    expect((await getJson(server, '/api/local/summary?days=7')).tokens).toBe(0);
  });
});

describe.skipIf(external)('device connection through browser approval', () => {
  let server: Server;
  let stub: Stub;
  const start = (change: Record<string, unknown> = {}) => stub.on('POST /api/device-auth', {json: {pollToken: 'poll-secret-1', userCode: 'BCDF-GHJK', expiresAt: '2026-10-24T12:00:00.000Z', ...change}});
  const poll = () => server.request('/api/local/connect/poll', {method: 'POST'});
  beforeAll(async () => {
    stub = await stubService();
    server = await startServer({cloudUrl: stub.url});
  });
  afterAll(async () => {await stub.close();});

  it('answers 409 CONNECT_NOT_STARTED to a poll before anything was started', async () => {
    expectError(await poll(), 409, 'CONNECT_NOT_STARTED');
  });
  it('starts a connection: the user code and the approval address, never the poll secret', async () => {
    start();
    const reply = await server.request('/api/local/connect', {method: 'POST'});
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({userCode: 'BCDF-GHJK', verificationUrl: `${stub.url}/?connect=BCDF-GHJK`, expiresAt: '2026-10-24T12:00:00.000Z'});
    expect(reply.text).not.toContain('poll-secret-1');
    const [call] = stub.to('POST /api/device-auth');
    expect(call!.headers['content-type']).toMatch(/^application\/json/);
    // A salted hash of the hardware id, where the computer has one (F4); the frozen TypeScript app sends none.
    expect([['deviceName'], ['deviceName', 'machineId']]).toContainEqual(Object.keys(call!.body));
    if ('machineId' in call!.body) expect(call!.body.machineId).toMatch(/^[0-9a-f]{64}$/);
    expect(call!.body.deviceName).toMatch(/^\S.{0,79}$/);
  });
  it('polls with the poll secret and reports pending until the member approves', async () => {
    stub.on('POST /api/device-auth/poll', {json: {status: 'pending'}});
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await poll();
      expect({status: reply.status, body: reply.json()}).toEqual({status: 200, body: {status: 'pending'}});
    }
    expect(stub.to('POST /api/device-auth/poll').every(call => call.headers.authorization === bearer('poll-secret-1'))).toBe(true);
    expect(await getJson(server, '/api/local/status')).toMatchObject({cloudLinked: false});
  });
  it('reports a code that expired, and then has nothing in progress', async () => {
    stub.on('POST /api/device-auth/poll', {status: 410, json: {error: {code: 'EXPIRED', message: 'Expired.'}}});
    expect((await poll()).json()).toEqual({status: 'expired'});
    expectError(await poll(), 409, 'CONNECT_NOT_STARTED');
  });
  it('answers 429 RATE_LIMITED, and 502 CONNECT_FAILED for a failure or an answer it cannot use, when starting', async () => {
    stub.on('POST /api/device-auth', {status: 429, json: {error: {code: 'RATE_LIMITED', message: 'Slow down.'}}});
    expectError(await server.request('/api/local/connect', {method: 'POST'}), 429, 'RATE_LIMITED');
    for (const answer of [{status: 500, json: {}}, {json: {pollToken: 'p', userCode: 'bcdf-ghjk', expiresAt: 'x'}}, {json: {pollToken: 1, userCode: 'BCDF-GHJK', expiresAt: 'x'}}, {json: {userCode: 'BCDF-GHJK', expiresAt: 'x'}}, {text: 'nope'}]) {
      stub.on('POST /api/device-auth', answer);
      expectError(await server.request('/api/local/connect', {method: 'POST'}), 502, 'CONNECT_FAILED');
    }
  });
  it('answers 502 CONNECT_FAILED when polling fails or the answer is not usable, and keeps the connection to poll again', async () => {
    start();
    expect((await server.request('/api/local/connect', {method: 'POST'})).status).toBe(200);
    for (const answer of [{status: 500, json: {}}, {json: {status: 'approved'}}, {json: {status: 'rejected'}}, {text: 'nope'}]) {
      stub.on('POST /api/device-auth/poll', answer);
      expectError(await poll(), 502, 'CONNECT_FAILED');
    }
    stub.on('POST /api/device-auth/poll', {json: {status: 'pending'}});
    expect((await poll()).json()).toEqual({status: 'pending'});
  });
  it('links the device once the member approves, saving the approved scope, and then has nothing in progress', async () => {
    const approved = publication({alias: 'approved-builder'});
    stub.on('POST /api/device-auth/poll', {json: {status: 'approved', deviceToken: TOKEN, publication: approved}});
    stub.on('GET /api/device-policy', {json: {publication: approved}});
    stub.on('POST /api/ingest', call => ({json: {accepted: call.body.buckets.length}}));
    const reply = await poll();
    expect({status: reply.status, body: reply.json()}).toEqual({status: 200, body: {status: 'connected', alias: 'approved-builder'}});
    expect(stub.to('GET /api/device-policy')[0]!.headers.authorization).toBe(bearer(TOKEN));
    // The first upload happens before success is reported, so the app can show its standing at once.
    expect(stub.to('POST /api/ingest')).toHaveLength(1);
    expect(stub.to('POST /api/ingest')[0]!.body).toMatchObject({generation: approved.generation, buckets: []});
    const status = await getJson(server, '/api/local/status');
    expect(status).toMatchObject({cloudLinked: true, alias: 'approved-builder', syncError: null, lastSyncAt: ISO});
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expectError(await poll(), 409, 'CONNECT_NOT_STARTED');
  });
});

describe.skipIf(external)('linking, syncing and the hosted wire format', () => {
  let server: Server;
  let stub: Stub;
  let roots: ReturnType<typeof logRoots>;
  let file: string;
  let current: ReturnType<typeof publication>;
  let ingestFailure: Record<string, unknown> | null = null;
  const link = (change: Record<string, unknown> = {}) => server.request('/api/local/cloud', {method: 'PUT', json: {url: stub.url, deviceToken: TOKEN, historyStart: null, shareTools: true, shareCost: true, shareModels: true, ...change}});
  const sync = () => server.request('/api/local/sync', {method: 'POST'});
  const ingests = () => stub.to('POST /api/ingest');
  const lastIngest = () => ingests().at(-1)!.body;
  const status = () => getJson(server, '/api/local/status');
  // Token kinds are always uploaded, never the one-hour cache-write part: claude('msg-1', 11, 20) is 161 tokens and claude('msg-1', 1, 2) is 133.
  const kinds = (tokens: number) => {if (tokens === 302) return {input: 16, output: 26, cacheRead: 200, cacheWrite: 60, reasoning: 13}; const [input, output] = tokens === 161 ? [11, 20] : [1, 2]; return {input, output, cacheRead: 100, cacheWrite: 30, reasoning: Math.min(7, output)};};
  const bucket = (tokens: number, change: Record<string, unknown> = {}) => ({day: FIXTURE_DAY, tool: 'claude', model: 'claude-sonnet-4-6', tokens, costMicrousd: expect.any(Number), revision: expect.any(Number), breakdown: kinds(tokens), ...change});
  beforeAll(async () => {
    stub = await stubService();
    server = await startServer({cloudUrl: stub.url});
    roots = logRoots(server);
    file = join(roots.claude, 'p', 'session.jsonl');
    current = publication();
    stub.on('GET /api/device-policy', () => ({json: {publication: current}}));
    stub.on('POST /api/ingest', call => ingestFailure ?? {json: {accepted: call.body.buckets.length}});
  });
  afterAll(async () => {await stub.close();});

  it('refuses a scope that differs from the published one, with 400 SCOPE_NOT_PUBLISHED, and checks it with the device token', async () => {
    current = publication();
    expectError(await link({shareTools: false}), 400, 'SCOPE_NOT_PUBLISHED');
    expectError(await link({shareCost: false}), 400, 'SCOPE_NOT_PUBLISHED');
    expectError(await link({shareModels: false}), 400, 'SCOPE_NOT_PUBLISHED');
    expectError(await link({historyStart: '2026-10-01'}), 400, 'SCOPE_NOT_PUBLISHED');
    expect(stub.to('GET /api/device-policy').every(call => call.headers.authorization === bearer(TOKEN))).toBe(true);
    expect(await status()).toMatchObject({cloudLinked: false});
  });
  it('answers 409 RELINK_REQUIRED when the hosted service no longer accepts the device, and 502 SYNC_FAILED when it is down', async () => {
    for (const code of [401, 403, 404, 409]) {
      stub.on('GET /api/device-policy', {status: code, json: {error: {code: 'X', message: 'x'}}});
      expectError(await link(), 409, 'RELINK_REQUIRED');
    }
    for (const code of [500, 503]) {
      stub.on('GET /api/device-policy', {status: code, json: {}});
      expectError(await link(), 502, 'SYNC_FAILED');
    }
    stub.on('GET /api/device-policy', () => ({json: {publication: current}}));
  });
  it('links a device whose scope matches, and never shows the token again', async () => {
    current = publication();
    const reply = await link();
    expect({status: reply.status, body: reply.json()}).toEqual({status: 200, body: {linked: true}});
    const linked = await status();
    expect(linked).toMatchObject({cloudLinked: true, alias: 'stub-builder', syncError: null, lastSyncAt: null});
    expect(JSON.stringify(linked)).not.toContain(TOKEN);
  });
  it('uploads even an empty history, which authenticates the device, and reports when', async () => {
    const reply = await sync();
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({syncedAt: ISO});
    expect((await status()).lastSyncAt).toBe(reply.json().syncedAt);
    const [call] = ingests();
    expect(call!.headers.authorization).toBe(bearer(TOKEN));
    expect(call!.headers['content-type']).toMatch(/^application\/json/);
    expect(call!.body).toEqual({generation: current.generation, collectorId: UUID, checkpoint: expect.any(Number), receipt: UUID, baseReceipt: null, buckets: [], hours: []});
  });
  it('uploads day totals by tool and model with their estimated cost, and no project, session or text', async () => {
    await writeLog(file, claude('msg-1', 11, 20));
    expect((await configure(server, 'claude', true, [roots.claude])).status).toBe(200);
    await refresh(server);
    expect((await sync()).status).toBe(200);
    const body = lastIngest();
    expect(Object.keys(body).sort()).toEqual(['baseReceipt', 'buckets', 'checkpoint', 'collectorId', 'generation', 'hours', 'receipt']);
    expect(body.buckets).toEqual([bucket(161)]);
    expect(Object.keys(body.buckets[0]).sort()).toEqual(['breakdown', 'costMicrousd', 'day', 'model', 'revision', 'tokens', 'tool']);
    const wire = JSON.stringify(ingests().map(call => call.body));
    for (const marker of ['PRIVATE_PROMPT_MARKER', '/synthetic/private-project', 'claude-session', 'msg-1', 'req-msg-1']) expect(wire).not.toContain(marker);
  });
  it('posts nothing while usage is unchanged, and chains the next upload to the one last acknowledged', async () => {
    const first = lastIngest();
    const posted = ingests().length;
    expect((await sync()).status).toBe(200);
    expect(ingests()).toHaveLength(posted);
    // New usage: the refresh cycle uploads it, naming the acknowledged upload.
    await writeLog(file, claude('msg-1', 11, 20), claude('msg-2', 5, 6));
    await refresh(server);
    const second = lastIngest();
    expect(second.baseReceipt).toBe(first.receipt);
    expect(second.receipt).not.toBe(first.receipt);
    expect(second.buckets).toEqual([bucket(302)]);
    expect(second.collectorId).toBe(first.collectorId);
  });
  it('keeps a failed upload frozen and sends it again unchanged, while a later correction waits for the next upload', async () => {
    const acknowledged = lastIngest();
    ingestFailure = {status: 503, json: {error: {code: 'SERVICE_UNAVAILABLE', message: 'Down.'}}};
    // A change to send: msg-2 is gone. The refresh cycle's upload fails and freezes it.
    await writeLog(file, claude('msg-1', 11, 20));
    await refresh(server);
    expectError(await sync(), 502, 'SYNC_FAILED');
    const failed = lastIngest();
    expect(failed.baseReceipt).toBe(acknowledged.receipt);
    expect(await status()).toMatchObject({syncError: 'SYNC_FAILED', cloudLinked: true});
    // Usage goes down again while the hosted service is unreachable: a smaller log replaces the old one.
    await writeLog(file, claude('msg-1', 1, 2));
    await refresh(server);
    expect((await getJson(server, `/api/local/summary?from=${FIXTURE_DAY}&to=${FIXTURE_DAY}`)).tokens).toBe(133);
    ingestFailure = null;
    expect((await sync()).status).toBe(200);
    const retried = lastIngest();
    expect(retried.receipt).toBe(failed.receipt);
    expect(retried.buckets).toEqual(failed.buckets);
    expect(retried.buckets).toEqual([bucket(161)]);
    expect(await status()).toMatchObject({syncError: null});
    // The next upload carries the correction, as a total that went down under a newer revision.
    expect((await sync()).status).toBe(200);
    const corrected = lastIngest();
    expect(corrected.baseReceipt).toBe(retried.receipt);
    expect(corrected.buckets).toEqual([bucket(133, {revision: expect.any(Number)})]);
    expect(corrected.buckets[0].revision).toBeGreaterThan(retried.buckets[0].revision);
  });
  it('makes a day that no longer has usage a zero, so the hosted total is replaced', async () => {
    await writeLog(file);
    await refresh(server);
    expect((await sync()).status).toBe(200);
    const [zeroed] = lastIngest().buckets;
    expect(zeroed).toMatchObject({day: FIXTURE_DAY, tool: 'claude', model: 'claude-sonnet-4-6', tokens: 0, breakdown: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0}});
    expect(zeroed.revision).toBeGreaterThan(0);
    await writeLog(file, claude('msg-1', 1, 2));
    await refresh(server);
  });
  it('refuses to upload under a wider scope than was approved, with 409 RELINK_REQUIRED, until the device is linked again', async () => {
    // A publication saved before sharing was fixed, and a device linked to it, uploading daily totals only.
    current = publication(TOTALS_ONLY);
    expect((await link(TOTALS_ONLY)).status).toBe(200);
    expect((await sync()).status).toBe(200);
    expect(lastIngest().buckets).toEqual([bucket(133, {tool: 'all', model: undefined, costMicrousd: null})]);
    // The fixed-sharing migration widens it under a new generation.
    const before = ingests().length;
    current = publication();
    expectError(await sync(), 409, 'RELINK_REQUIRED');
    expect(await status()).toMatchObject({syncError: 'RELINK_REQUIRED'});
    expect(ingests()).toHaveLength(before);
    expectError(await link(TOTALS_ONLY), 400, 'SCOPE_NOT_PUBLISHED');
    expect((await link()).status).toBe(200);
    expect((await sync()).status).toBe(200);
    const body = lastIngest();
    expect(body.generation).toBe(current.generation);
    expect(body.buckets).toEqual([bucket(133)]);
  });
  it('reports a deleted account, a reset local history or a rejected device as 409, and a bad confirmation as 502', async () => {
    stub.on('GET /api/device-policy', {status: 401, json: {error: {code: 'UNAUTHORIZED', message: 'Gone.'}}});
    expectError(await sync(), 409, 'RELINK_REQUIRED');
    stub.on('GET /api/device-policy', () => ({json: {publication: current}}));
    // A change to send, frozen by the refresh cycle's failed upload, so every sync below posts it again.
    ingestFailure = {status: 401, json: {error: {code: 'X', message: 'x'}}};
    await writeLog(file, claude('msg-1', 1, 2), claude('msg-2', 5, 6));
    await refresh(server);
    for (const status of [401, 403, 404, 409]) {
      ingestFailure = {status, json: {error: {code: 'X', message: 'x'}}};
      expectError(await sync(), 409, 'RELINK_REQUIRED');
    }
    ingestFailure = {status: 409, json: {error: {code: 'LOCAL_STATE_RESET', message: 'Reset.'}}};
    expectError(await sync(), 409, 'LOCAL_STATE_RESET');
    expect(await status()).toMatchObject({syncError: 'LOCAL_STATE_RESET'});
    for (const answer of [{json: {accepted: 'many'}}, {json: {accepted: -1}}, {json: {accepted: 99}}, {json: {}}, {status: 500, json: {}}]) {
      ingestFailure = answer;
      expectError(await sync(), 502, 'SYNC_FAILED');
    }
    ingestFailure = null;
  });
  it('unlinks: 204, the device forgets the link, and nothing is sent to the hosted service any more', async () => {
    const calls = stub.calls.length;
    const reply = await server.request('/api/local/cloud', {method: 'DELETE'});
    expect({status: reply.status, text: reply.text}).toEqual({status: 204, text: ''});
    expect(await status()).toMatchObject({cloudLinked: false, alias: null, lastSyncAt: null, syncError: null});
    expectError(await sync(), 409, 'CLOUD_NOT_LINKED');
    expect(stub.calls).toHaveLength(calls);
    expect((await getJson(server, '/api/health')).cloudUrl).toBe(stub.url);
  });
});
