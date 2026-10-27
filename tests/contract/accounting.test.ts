import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {claude, codex, context, meta, usage} from './fixtures.ts';
import {startServer, type Server} from './runner.ts';
import {configure, expectError, FIXTURE_DAY, getJson, logRoots, refresh, writeLog} from './support.ts';

// Token accounting seen through HTTP only. The fixture helpers stamp every record 2026-10-20T12:00 UTC, so a custom range
// over that day gives the same totals on any date. The tests run in order on one server: each phase changes the logs.
const DAY = `from=${FIXTURE_DAY}&to=${FIXTURE_DAY}`;
const SECRET = 'PRIVATE_PROMPT_MARKER';
const MODELS = {claude: 'claude-sonnet-4-6', codex: 'gpt-5-codex'};
// Prices come from the bundled LiteLLM table. claude-sonnet-4-6, 11 in + 20 out + 100 cache read + 30 cache write, 20 of it
// to the 1-hour cache at $6 rather than $3.75 per million: 520.5 µUSD, rounded to 521.
const claudeLog = [claude('msg-1', 11, 20), claude('msg-2', 5, 6), claude('msg-1', 11, 20)];
// Cumulative totals: 100 input (20 cached) and 50 output, then 150/20/80. The repeated third record is a replay and counts once.
// Tokens by kind (`breakdown`). Claude Code: 11 + 5 input, 20 + 6 output with 7 + 6 reasoning, 100 cache read and 30
// cache write (20 of it to the 1-hour cache) per request. Codex: 100 − 20 cached + 50 input, 50 + 30 output, 10 reasoning.
const KINDS = {
  claude: {input: 16, output: 26, cacheRead: 200, cacheWrite: 60, reasoning: 13, cacheWrite1h: 40},
  codex: {input: 130, output: 80, cacheRead: 20, cacheWrite: 0, reasoning: 10},
  all: {input: 146, output: 106, cacheRead: 220, cacheWrite: 60, reasoning: 23, cacheWrite1h: 40},
};
const NONE = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0};
// Each request is rounded independently by the shared pricing table, and its integer parts add up to its cost.
// Cache savings are the difference from ordinary input pricing.
const PARTS = {
  claude: {input: 48, output: 390, cacheRead: 60, cacheWrite: 316, cacheSavings: 540},
  codex: {input: 163, output: 800, cacheRead: 3, cacheWrite: 0, cacheSavings: 23},
  all: {input: 211, output: 1190, cacheRead: 63, cacheWrite: 316, cacheSavings: 563},
};
const codexLog = [meta, context, codex(usage(100, 20, 50, 10), usage(100, 20, 50, 10), 0), codex(usage(150, 20, 80, 10), usage(50, 0, 30, 0), 1), codex(usage(150, 20, 80, 10), usage(50, 0, 30, 0), 1)];
let server: Server;
let claudeFile: string;
let roots: ReturnType<typeof logRoots>;
const sorted = <T>(items: T[], key: (item: T) => string) => [...items].sort((a, b) => key(a).localeCompare(key(b)));
/** Every route that reports usage, for one query string. */
const everything = async (query: string) => ({
  summary: await getJson(server, `/api/local/summary?${query}`), sessions: await getJson(server, `/api/local/sessions?${query}`),
  breakdown: await getJson(server, `/api/local/breakdown?${query}`), projects: await getJson(server, `/api/local/projects?${query}`),
});
const sourceStatus = async (id: string) => (await getJson(server, '/api/local/status')).sources.find((source: {id: string}) => source.id === id);

beforeAll(async () => {
  server = await startServer();
  roots = logRoots(server);
  claudeFile = join(roots.claude, '-synthetic-private-project', 'session.jsonl');
  await writeLog(claudeFile, ...claudeLog);
  await writeLog(join(roots.codex, '2026', '10', '20', 'rollout-synthetic.jsonl'), ...codexLog);
});

describe('totals from synthetic Claude Code and Codex logs', () => {
  it('counts nothing until each source is authorised, even though its logs exist', async () => {
    expect((await server.request('/api/local/refresh', {method: 'POST'})).status).toBe(200);
    expect((await getJson(server, `/api/local/summary?${DAY}`)).tokens).toBe(0);
    expect((await getJson(server, `/api/local/sessions?${DAY}`)).items).toEqual([]);
    expect((await sourceStatus('claude')).eventCount).toBe(0);
  });
  it('reports each source as current with its event count once authorised and refreshed', async () => {
    for (const tool of ['claude', 'codex'] as const) {
      const reply = await configure(server, tool, true, [roots[tool]]);
      expect(reply.status).toBe(200);
      expect(reply.json().sources.find((source: {id: string}) => source.id === tool)).toMatchObject({enabled: true, paths: [roots[tool]]});
    }
    const status = (await refresh(server)).json();
    expect(status.collecting).toBe(true);
    for (const id of ['claude', 'codex']) {
      expect(status.sources.find((source: {id: string}) => source.id === id)).toEqual({
        id, name: id === 'claude' ? 'Claude Code' : 'Codex', enabled: true, state: 'current', paths: [roots[id as 'claude' | 'codex']], lastImportedAt: expect.any(String),
        eventCount: 2, message: expect.stringMatching(/\S/), capabilities: {tokens: true, models: true, projects: true, costs: false, quotas: false},
      });
    }
    expect(status.sources.filter((source: {enabled: boolean}) => source.enabled)).toHaveLength(2);
    expect(Date.parse(status.lastScanAt)).toBeGreaterThan(0);
  });
  it('reports exact summary totals: tokens, cost, sessions, cache rate, and the split by tool, model and day', async () => {
    const summary = await getJson(server, `/api/local/summary?${DAY}`);
    expect(Object.keys(summary).sort()).toEqual(['activity', 'breakdown', 'byHour', 'byModel', 'byTool', 'cacheRate', 'costMicrousd', 'costParts', 'daily', 'sessions', 'tokens']);
    expect(summary).toEqual({
      tokens: 532, breakdown: KINDS.all, costMicrousd: 1780, costParts: PARTS.all, sessions: 2, cacheRate: expect.closeTo(220 / 426, 12),
      // 302 Claude Code tokens (161 + 141) and 230 Codex tokens (150 + 80). The current streak depends on today's date.
      byTool: expect.arrayContaining([{tool: 'claude', tokens: 302, breakdown: KINDS.claude, costMicrousd: 814, costParts: PARTS.claude, sessions: 1}, {tool: 'codex', tokens: 230, breakdown: KINDS.codex, costMicrousd: 966, costParts: PARTS.codex, sessions: 1}]),
      byModel: expect.arrayContaining([{model: MODELS.claude, tokens: 302, breakdown: KINDS.claude, costMicrousd: 814, costParts: PARTS.claude, sessions: 1}, {model: MODELS.codex, tokens: 230, breakdown: KINDS.codex, costMicrousd: 966, costParts: PARTS.codex, sessions: 1}]),
      daily: [{day: FIXTURE_DAY, tokens: 532, breakdown: KINDS.all, costMicrousd: 1780, costParts: PARTS.all}],
      // Both logs' records are in the 12:00 UTC hour.
      byHour: Array.from({length: 24}, (_, hour) => hour === 12 ? 532 : 0),
      activity: {activeDays: 1, currentStreak: expect.any(Number), longestStreak: 1, bestDay: {day: FIXTURE_DAY, tokens: 532}, averagePerActiveDay: 532},
    });
    expect(summary.byTool).toHaveLength(2);
    expect(summary.byModel).toHaveLength(2);
    // Each record's cost split by kind, rounded so the kinds add up: msg-1 is 33 + 300 + 30 + 158 = 521 and msg-2
    // 15 + 90 + 30 + 158 = 293. Each record read 100 tokens from cache for $0.30 instead of $3 per million.
    const claude = summary.byTool.find((row: {tool: string}) => row.tool === 'claude');
    expect(claude.costParts).toEqual({input: 48, output: 390, cacheRead: 60, cacheWrite: 316, cacheSavings: 540});
    for (const row of [summary, ...summary.byTool, ...summary.byModel, ...summary.daily]) {
      expect(row.costParts.input + row.costParts.output + row.costParts.cacheRead + row.costParts.cacheWrite).toBe(row.costMicrousd);
    }
  });
  it('reports one row per session, newest first, with the project, models and a token breakdown that adds up', async () => {
    const {items} = await getJson(server, `/api/local/sessions?${DAY}`);
    expect(items).toEqual([
      {id: 'codex-session', project: '/synthetic/codex-project', tool: 'codex', model: MODELS.codex, models: [MODELS.codex], tokens: 230,
        breakdown: KINDS.codex, costMicrousd: 966, lastUsedAt: '2026-10-20T12:00:01.000Z'},
      {id: 'claude-session', project: '/synthetic/private-project', tool: 'claude', model: MODELS.claude, models: [MODELS.claude], tokens: 302,
        breakdown: KINDS.claude, costMicrousd: 814, lastUsedAt: '2026-10-20T12:00:00.000Z'},
    ]);
    for (const item of items) expect(item.breakdown.input + item.breakdown.output + item.breakdown.cacheRead + item.breakdown.cacheWrite).toBe(item.tokens);
  });
  it('reports the day, tool and model breakdown ordered by day, tool and model', async () => {
    expect(await getJson(server, `/api/local/breakdown?${DAY}`)).toEqual({items: [
      {day: FIXTURE_DAY, tool: 'claude', model: MODELS.claude, tokens: 302, breakdown: KINDS.claude, costMicrousd: 814},
      {day: FIXTURE_DAY, tool: 'codex', model: MODELS.codex, tokens: 230, breakdown: KINDS.codex, costMicrousd: 966},
    ]});
  });
  it('reports one row per project, largest first, with no repository for a folder that is not a git checkout', async () => {
    expect(await getJson(server, `/api/local/projects?${DAY}`)).toEqual({items: [
      {name: '/synthetic/private-project', tokens: 302, breakdown: KINDS.claude, costMicrousd: 814, sessions: 1, repository: null},
      {name: '/synthetic/codex-project', tokens: 230, breakdown: KINDS.codex, costMicrousd: 966, sessions: 1, repository: null},
    ]});
  });
  it('shows each tool in the status with its own event count', async () => {
    const [claudeSource, codexSource] = [await sourceStatus('claude'), await sourceStatus('codex')];
    expect([claudeSource.eventCount, codexSource.eventCount]).toEqual([2, 2]);
  });
  it('counts a repeated refresh and a repeated line once', async () => {
    await refresh(server);
    await refresh(server);
    expect((await getJson(server, `/api/local/summary?${DAY}`)).tokens).toBe(532);
  });
  it('picks up appended records, and a corrected record replaces the one it corrects', async () => {
    // msg-2 is logged again with 4 more input tokens: the session grows by 4, not by a second 145.
    await writeLog(claudeFile, ...claudeLog, claude('msg-2', 9, 6), claude('msg-3', 1, 1));
    await refresh(server);
    const claudeSession = (await getJson(server, `/api/local/sessions?${DAY}`)).items.find((item: {tool: string}) => item.tool === 'claude');
    // 161 + 145 + 132
    expect(claudeSession).toMatchObject({tokens: 438, breakdown: {input: 21, output: 27, cacheRead: 300, cacheWrite: 90, reasoning: 14}});
    expect((await getJson(server, `/api/local/summary?${DAY}`)).tokens).toBe(668);
  });
  it('lowers a total when a log is rewritten with smaller counts, and drops usage from a record that disappeared', async () => {
    await writeLog(claudeFile, claude('msg-1', 1, 2));
    await refresh(server);
    // Only msg-1 remains, with 1 + 2 + 100 + 30 tokens; Codex is untouched.
    const {summary, sessions, breakdown, projects} = await everything(DAY);
    expect(summary).toMatchObject({tokens: 363, sessions: 2, byTool: expect.arrayContaining([expect.objectContaining({tool: 'claude', tokens: 133}), expect.objectContaining({tool: 'codex', tokens: 230, costMicrousd: 966})])});
    expect(sessions.items.map((item: {tokens: number}) => item.tokens)).toEqual([230, 133]);
    expect(sorted<{tool: string; tokens: number}>(breakdown.items, row => row.tool).map(row => row.tokens)).toEqual([133, 230]);
    expect(projects.items.map((item: {name: string; tokens: number}) => [item.name, item.tokens])).toEqual([['/synthetic/codex-project', 230], ['/synthetic/private-project', 133]]);
  });
  it('names the repository of a project folder that is a git checkout, from its local remote', async () => {
    const repository = join(server.dir, 'checkout');
    await mkdir(join(repository, '.git'), {recursive: true});
    await writeFile(join(repository, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:synthetic-owner/synthetic-repo.git\n');
    await writeLog(join(roots.claude, 'checkout', 'session.jsonl'), {...claude('msg-9', 2, 3), sessionId: 'checkout-session', cwd: repository, timestamp: '2026-10-20T13:00:00.000Z'});
    await refresh(server);
    const {items} = await getJson(server, `/api/local/projects?${DAY}`);
    expect(items).toContainEqual({name: repository, tokens: 135, breakdown: {input: 2, output: 3, cacheRead: 100, cacheWrite: 30, reasoning: 3, cacheWrite1h: 20}, costMicrousd: expect.any(Number), sessions: 1, repository: 'synthetic-owner/synthetic-repo'});
    expect(items.filter((item: {repository: unknown}) => item.repository === null)).toHaveLength(2);
    // The newest session comes first.
    expect((await getJson(server, `/api/local/sessions?${DAY}`)).items[0]).toMatchObject({id: 'checkout-session', project: repository, lastUsedAt: '2026-10-20T13:00:00.000Z'});
  });
  it('reports nothing for a day outside the data, and the same totals through the CSV export', async () => {
    const empty = await everything('from=2026-10-19&to=2026-10-19');
    expect(empty.summary).toEqual({tokens: 0, breakdown: NONE, costMicrousd: null, costParts: null, sessions: 0, cacheRate: 0, byTool: [], byModel: [], daily: [], byHour: Array(24).fill(0), activity: {activeDays: 0, currentStreak: 0, longestStreak: 0, bestDay: null, averagePerActiveDay: 0}});
    expect([empty.sessions, empty.breakdown, empty.projects]).toEqual([{items: []}, {items: []}, {items: []}]);
    const {summary} = await everything(DAY);
    const rows = (await server.request(`/api/local/export?${DAY}`)).text.trimEnd().split('\r\n').slice(1);
    // total is the 11th column, always quoted.
    expect(rows.reduce((sum, row) => sum + Number(row.split('","')[10]), 0)).toBe(summary.tokens);
  });
  it('never returns prompt, response or tool-result text from any route', async () => {
    for (const path of ['/api/local/status', `/api/local/summary?${DAY}`, `/api/local/sessions?${DAY}`, `/api/local/breakdown?${DAY}`, `/api/local/projects?${DAY}`, `/api/local/export?${DAY}`, '/api/local/detect']) {
      expect((await server.request(path)).text, path).not.toContain(SECRET);
    }
  });
  it('rejects a range that is not valid, with the same error from every usage route', async () => {
    for (const route of ['summary', 'sessions', 'breakdown', 'projects', 'export']) expectError(await server.request(`/api/local/${route}?from=2026-10-21&to=2026-10-20`), 400, 'INVALID_FILTER');
  });
});
