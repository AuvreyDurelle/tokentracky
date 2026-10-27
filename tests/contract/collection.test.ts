import {join} from 'node:path';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {claude} from './fixtures.ts';
import {startServer, type Server} from './runner.ts';
import {configure, expectError, FIXTURE_DAY, getJson, logRoots, refresh, writeLog} from './support.ts';

const DAY = `from=${FIXTURE_DAY}&to=${FIXTURE_DAY}`;
let server: Server;
let roots: ReturnType<typeof logRoots>;
let file: string;
const status = () => getJson(server, '/api/local/status');
const tokens = async () => (await getJson(server, `/api/local/summary?${DAY}`)).tokens;
const setPaused = (paused: unknown) => server.request('/api/local/collection', {method: 'PUT', json: {paused}});
const claudeSource = async () => (await status()).sources.find((item: {id: string}) => item.id === 'claude');

beforeAll(async () => {
  server = await startServer();
  roots = logRoots(server);
  file = join(roots.claude, 'p', 'session.jsonl');
  await writeLog(file, claude('msg-1', 11, 20));
});

describe('PUT /api/local/collection', () => {
  it('answers {paused} for pause and resume, and either is safe to repeat', async () => {
    for (const paused of [true, true, false, false]) {
      const reply = await setPaused(paused);
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toMatch(/^application\/json/);
      expect(reply.json()).toEqual({paused});
    }
  });
  it('is running until paused: an authorised source is being collected', async () => {
    expect((await configure(server, 'claude', true, [roots.claude])).status).toBe(200);
    await vi.waitFor(async () => expect(await tokens()).toBe(161), {timeout: 10_000, interval: 50});
    expect(await status()).toMatchObject({collecting: true});
    expect(await claudeSource()).toMatchObject({enabled: true, state: 'current'});
  });
  it('pausing stops collection: the status shows it, sources report paused, and refresh is refused with 409', async () => {
    expect((await setPaused(true)).status).toBe(200);
    expect(await status()).toMatchObject({collecting: false, refreshing: false});
    expect(await claudeSource()).toMatchObject({enabled: true, state: 'paused', eventCount: 1});
    // A source that is not enabled is not reported as paused.
    expect((await status()).sources.find((item: {id: string}) => item.id === 'codex')).toMatchObject({enabled: false, state: 'permission_required'});
    expectError(await server.request('/api/local/refresh', {method: 'POST'}), 409, 'COLLECTION_PAUSED');
  });
  it('keeps what was collected while paused, and reads nothing new, even when a source is authorised meanwhile', async () => {
    await writeLog(file, claude('msg-1', 11, 20), claude('msg-2', 5, 6));
    const codexFolder = join(roots.codex, 'x');
    await writeLog(join(codexFolder, 'rollout.jsonl'));
    expect((await configure(server, 'codex', true, [roots.codex])).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await tokens()).toBe(161);
    expect(await status()).toMatchObject({collecting: false, refreshing: false});
    expect((await status()).sources.find((item: {id: string}) => item.id === 'codex')).toMatchObject({enabled: true, state: 'paused'});
  });
  it('resuming starts a cycle straight away, which reads what appeared meanwhile', async () => {
    const before = (await status()).lastRefreshAt;
    expect((await setPaused(false)).json()).toEqual({paused: false});
    await vi.waitFor(async () => expect(await tokens()).toBe(302), {timeout: 10_000, interval: 50});
    const after = await status();
    expect(Date.parse(after.lastRefreshAt)).toBeGreaterThan(Date.parse(before));
    expect(after.collecting).toBe(true);
    expect(after.sources.find((item: {id: string}) => item.id === 'claude')).toMatchObject({state: 'current', eventCount: 2});
    expect((await refresh(server)).status).toBe(200);
  });
  it('answers 400 INVALID_REQUEST unless the body is exactly {paused: boolean}', async () => {
    for (const body of [{}, {paused: 'true'}, {paused: 1}, {paused: 0}, {paused: null}, {paused: [true]}, {paused: true, extra: 1}, {Paused: true}, [], 'paused', 7, null]) {
      expectError(await server.request('/api/local/collection', {method: 'PUT', json: body}), 400, 'INVALID_REQUEST');
    }
    expectError(await server.request('/api/local/collection', {method: 'PUT'}), 400, 'INVALID_REQUEST');
    // None of that paused anything.
    expect((await refresh(server)).status).toBe(200);
  });
  it('is the only method of the route', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) expectError(await server.request('/api/local/collection', {method}), 404, 'NOT_FOUND');
  });
});
