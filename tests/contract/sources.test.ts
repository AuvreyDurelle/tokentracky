import {mkdir, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {startServer, type Reply, type Server} from './runner.ts';
import {configure, expectError, getJson, refresh} from './support.ts';

const TOOLS = ['claude', 'cline', 'codex', 'cursor', 'gemini', 'kilo', 'opencode', 'roo'];
/** Every tool id in the status, including those only some implementations read. */
const ALL = [...TOOLS, 'codebuddy', 'commandcode', 'copilot', 'deepseek', 'dumate', 'everycode', 'goose', 'grok', 'hermes', 'kimi', 'lmstudio', 'mimo', 'minimax', 'omo', 'omp', 'openclaw', 'pi', 'primeagent', 'reasonix', 'unsloth', 'zcode', 'zed'].sort();
const STATUS_KEYS = ['alias', 'cloudLinked', 'collecting', 'lastRefreshAt', 'lastScanAt', 'lastSyncAt', 'nextRefreshAt', 'pricingVersion', 'refreshing', 'sources', 'syncError'];
let server: Server;
let folders: string;
const source = (reply: Reply | {sources: Array<{id: string}>}, id: string) => ('sources' in reply ? reply : reply.json()).sources.find((item: {id: string}) => item.id === id);
const folder = async (name: string) => {
  const path = join(folders, name);
  await mkdir(path, {recursive: true});
  return path;
};
const put = (id: string, body: unknown) => server.request(`/api/local/sources/${id}`, {method: 'PUT', json: body});

beforeAll(async () => {
  server = await startServer();
  folders = join(server.dir, 'folders');
});

describe('PUT /api/local/sources/:id', () => {
  it('answers with the full status, in which the source is enabled with its folder', async () => {
    const path = await folder('claude-logs');
    const reply = await configure(server, 'claude', true, [path]);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(reply.json()).sort()).toEqual(STATUS_KEYS);
    expect(reply.json().sources.map((item: {id: string}) => item.id)).toEqual(ALL);
    expect(source(reply, 'claude')).toMatchObject({enabled: true, paths: [path]});
    expect(source(reply, 'claude').state).toMatch(/^(?:detected|importing|current)$/);
    // Authorising a source starts a collection cycle by itself.
    await refresh(server);
    expect(source(await getJson(server, '/api/local/status'), 'claude')).toMatchObject({enabled: true, state: 'detected', eventCount: 0});
  });
  it('reports a folder with no supported logs as detected, and one with logs as current', async () => {
    const path = await folder('codex-logs');
    await writeFile(join(path, 'notes.txt'), 'not a log');
    expect((await configure(server, 'codex', true, [path])).status).toBe(200);
    await refresh(server);
    expect(source(await getJson(server, '/api/local/status'), 'codex')).toMatchObject({enabled: true, state: 'detected', eventCount: 0, paths: [path]});
    await writeFile(join(path, 'rollout.jsonl'), '');
    await refresh(server);
    expect(source(await getJson(server, '/api/local/status'), 'codex')).toMatchObject({state: 'current', eventCount: 0});
  });
  it('accepts a single log file of a kind the tool writes, and refuses one it does not', async () => {
    const path = await folder('single-file');
    await writeFile(join(path, 'session.jsonl'), '');
    await writeFile(join(path, 'session.txt'), '');
    expect(source(await configure(server, 'claude', true, [join(path, 'session.jsonl')]), 'claude').paths).toEqual([join(path, 'session.jsonl')]);
    expectError(await configure(server, 'claude', true, [join(path, 'session.txt')]), 400, 'SOURCE_UNAVAILABLE');
  });
  it('keeps the folders it already had when it refuses new ones', async () => {
    const before = source(await getJson(server, '/api/local/status'), 'claude');
    expectError(await configure(server, 'claude', true, [join(server.dir, 'does-not-exist')]), 400, 'SOURCE_UNAVAILABLE');
    expect(source(await getJson(server, '/api/local/status'), 'claude')).toMatchObject({enabled: before.enabled, paths: before.paths});
  });
  it('stores each folder once, as its real path', async () => {
    const real = await folder('real');
    await symlink(real, join(folders, 'link'));
    const reply = await configure(server, 'claude', true, [real, join(folders, 'link'), `${real}/`, join(real, '..', 'real')]);
    expect(source(reply, 'claude').paths).toEqual([real]);
  });
  it('can disable a source, which then reports as paused, and a disabled source may name a folder that does not exist yet', async () => {
    const reply = await configure(server, 'claude', false, []);
    expect(reply.status).toBe(200);
    expect(source(reply, 'claude')).toMatchObject({enabled: false, state: 'paused', eventCount: 0});
    const missing = join(server.dir, 'not-yet-created');
    expect(source(await configure(server, 'claude', false, [missing]), 'claude')).toMatchObject({enabled: false, paths: [missing]});
  });
  it('accepts every tool, but reads only the ones that have a verified log format', async () => {
    for (const id of TOOLS) expect((await configure(server, id, false, [])).status, id).toBe(200);
    const path = await folder('cursor-logs');
    expect(source(await configure(server, 'cursor', true, [path]), 'cursor')).toMatchObject({state: 'unsupported', capabilities: {tokens: false, models: false, projects: false, costs: false, quotas: false}});
    await refresh(server);
    expect(source(await getJson(server, '/api/local/status'), 'cursor')).toMatchObject({state: 'unsupported', eventCount: 0});
  });
  it('refuses an enabled source with no folder, and a relative folder, with SOURCE_UNAVAILABLE', async () => {
    expectError(await configure(server, 'claude', true, []), 400, 'SOURCE_UNAVAILABLE');
    expectError(await configure(server, 'claude', true, ['relative/logs']), 400, 'SOURCE_UNAVAILABLE');
    expectError(await configure(server, 'claude', false, ['relative/logs']), 400, 'SOURCE_UNAVAILABLE');
  });
});

describe('invalid source requests', () => {
  it('answers 404 SOURCE_NOT_FOUND for a tool it does not know, before it looks at the body', async () => {
    for (const id of ['nope', 'Claude', 'claude%20', 'all']) {
      expectError(await put(id, {enabled: false, paths: []}), 404, 'SOURCE_NOT_FOUND');
      expectError(await put(id, {nonsense: true}), 404, 'SOURCE_NOT_FOUND');
    }
  });
  it('answers 400 INVALID_REQUEST for a body that is not an object, or has a field it does not know', async () => {
    for (const body of [[], 'enabled', 7, null, {enabled: true, paths: [], extra: 1}, {enabled: false, paths: [], path: '/x'}]) expectError(await put('claude', body), 400, 'INVALID_REQUEST');
    expectError(await server.request('/api/local/sources/claude', {method: 'PUT'}), 400, 'INVALID_REQUEST');
  });
  it('answers 400 INVALID_PATHS when enabled is not a boolean or paths is not up to 20 strings of up to 4096 characters', async () => {
    const bodies: unknown[] = [{}, {enabled: true}, {paths: []}, {enabled: 'true', paths: []}, {enabled: 1, paths: []}, {enabled: null, paths: []}, {enabled: true, paths: '/x'}, {enabled: true, paths: null},
      {enabled: false, paths: [1]}, {enabled: false, paths: [null]}, {enabled: false, paths: [['/x']]}, {enabled: false, paths: Array.from({length: 21}, (_, i) => `/p${i}`)}, {enabled: false, paths: ['/' + 'a'.repeat(4096)]}];
    for (const body of bodies) expectError(await put('claude', body), 400, 'INVALID_PATHS');
    // The limits are inclusive.
    expect((await put('claude', {enabled: false, paths: Array.from({length: 20}, (_, i) => `/p${i}`)})).status).toBe(200);
    expect((await put('claude', {enabled: false, paths: ['/' + 'a'.repeat(4095)]})).status).toBe(200);
  });
  it('answers 413 INVALID_REQUEST for a body over 16 KiB', async () => {
    expectError(await put('claude', {enabled: false, paths: ['/' + 'a'.repeat(17_000)]}), 413, 'INVALID_REQUEST');
  });
});
