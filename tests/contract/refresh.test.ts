import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {claude} from './fixtures.ts';
import {startServer, type Server} from './runner.ts';
import {configure, expectError, FIXTURE_DAY, getJson, logRoots, refresh, writeLog} from './support.ts';

const HOUR = 3_600_000;
const STATUS_KEYS = ['alias', 'cloudLinked', 'collecting', 'lastRefreshAt', 'lastScanAt', 'lastSyncAt', 'nextRefreshAt', 'pricingUpdatedAt', 'pricingVersion', 'refreshing', 'sources', 'syncError'];
const DAY = `from=${FIXTURE_DAY}&to=${FIXTURE_DAY}`;
let server: Server;
let roots: ReturnType<typeof logRoots>;
let file: string;
const status = () => getJson(server, '/api/local/status');
const tokens = async () => (await getJson(server, `/api/local/summary?${DAY}`)).tokens;
const iso = (value: unknown) => {
  expect(typeof value).toBe('string');
  expect(new Date(value as string).toISOString()).toBe(value);
  return Date.parse(value as string);
};

beforeAll(async () => {
  server = await startServer();
  roots = logRoots(server);
  file = join(roots.claude, 'p', 'session.jsonl');
});

describe('refresh cycle and the status times', () => {
  it('has run no cycle yet, and plans the next one an hour after start', async () => {
    const before = await status();
    expect(before).toMatchObject({lastRefreshAt: null, lastScanAt: null, refreshing: false, collecting: false});
    expect(iso(before.nextRefreshAt) - Date.now()).toBeGreaterThan(HOUR - 120_000);
    expect(iso(before.nextRefreshAt) - Date.now()).toBeLessThanOrEqual(HOUR + 60_000);
  });
  it.each(['refresh', 'scan'])('POST /api/local/%s runs one cycle and answers with the status after it', async route => {
    const started = Date.now();
    const reply = await server.request(`/api/local/${route}`, {method: 'POST'});
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    const body = reply.json();
    expect(Object.keys(body).sort()).toEqual(STATUS_KEYS);
    expect(body.refreshing).toBe(false);
    // Even with nothing to read the cycle counts: it has looked and found nothing.
    expect(iso(body.lastRefreshAt)).toBeGreaterThanOrEqual(started - 1000);
    expect(iso(body.lastRefreshAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(iso(body.lastScanAt)).toBeGreaterThanOrEqual(started - 1000);
    expect(iso(body.nextRefreshAt) - iso(body.lastRefreshAt)).toBeGreaterThanOrEqual(HOUR - 1000);
    expect(iso(body.nextRefreshAt) - iso(body.lastRefreshAt)).toBeLessThanOrEqual(HOUR + 60_000);
    expect(await status()).toMatchObject({lastRefreshAt: body.lastRefreshAt, refreshing: false});
  });
  it('moves both times forward on every cycle', async () => {
    const first = await status();
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = (await server.request('/api/local/refresh', {method: 'POST'})).json();
    expect(iso(second.lastRefreshAt)).toBeGreaterThan(iso(first.lastRefreshAt));
    expect(iso(second.nextRefreshAt)).toBeGreaterThan(iso(first.nextRefreshAt));
  });
  it('does not read a folder before its source is authorised', async () => {
    await writeLog(file, claude('msg-1', 11, 20));
    await refresh(server);
    expect(await tokens()).toBe(0);
  });
  it('starts a cycle by itself when a source is authorised', async () => {
    const before = iso((await status()).lastRefreshAt);
    expect((await configure(server, 'claude', true, [roots.claude])).status).toBe(200);
    await vi.waitFor(async () => expect(await tokens()).toBe(161), {timeout: 10_000, interval: 50});
    const after = await status();
    expect(iso(after.lastRefreshAt)).toBeGreaterThan(before);
    expect(after.sources.find((item: {id: string}) => item.id === 'claude')).toMatchObject({state: 'current', eventCount: 1, enabled: true});
    expect(after.collecting).toBe(true);
  });
  it('reads what the tool appended since the last cycle on the next refresh, and counts nothing twice', async () => {
    await writeLog(file, claude('msg-1', 11, 20), claude('msg-2', 5, 6));
    await refresh(server);
    expect(await tokens()).toBe(302);
    await refresh(server);
    expect(await tokens()).toBe(302);
  });
  it('lets concurrent refreshes share a cycle, and every one answers 200', async () => {
    const replies = await Promise.all([1, 2, 3, 4].map(() => server.request('/api/local/refresh', {method: 'POST'})));
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200, 200]);
    expect(await tokens()).toBe(302);
    expect((await status()).refreshing).toBe(false);
  });
  it('reports a source whose folder has disappeared as an error, keeps its totals, and recovers when it returns', async () => {
    await rm(roots.claude, {recursive: true, force: true});
    const failed = (await server.request('/api/local/refresh', {method: 'POST'})).json();
    expect(failed.sources.find((item: {id: string}) => item.id === 'claude')).toMatchObject({enabled: true, state: 'error', eventCount: 2});
    expect(await tokens()).toBe(302);
    await writeLog(file, claude('msg-1', 11, 20), claude('msg-2', 5, 6));
    await refresh(server);
    expect((await status()).sources.find((item: {id: string}) => item.id === 'claude')).toMatchObject({state: 'current', eventCount: 2});
  });
  it('has no GET form of either refresh route', async () => {
    for (const route of ['refresh', 'scan']) expectError(await server.request(`/api/local/${route}`), 404, 'NOT_FOUND');
  });
});
