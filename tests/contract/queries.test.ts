import {join} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {claude, codex, context, meta, usage} from './fixtures.ts';
import {startServer, type Reply, type Server} from './runner.ts';
import {configure, DAY_MS, expectError, getJson, logRoots, refresh, utcDay, writeLog} from './support.ts';

// Rolling ranges and filters. The fixture records are re-dated relative to now, so the data sits well inside or outside each
// window whatever the date: 10 days ago is in the 30-day window and not the 7-day one, and so on.
const now = Date.now();
const ago = (days: number) => new Date(now - days * DAY_MS - 5_000).toISOString();
// Claude Code: 10 + 0 + 100 + 30 = 140 tokens today, 150 ten days ago, 160 a hundred days ago.
const claudeAt = (id: string, input: number, timestamp: string) => ({...claude(id, input, 0), timestamp});
// Codex totals are cumulative: 300 tokens 400 days ago, then 200 more 40 days ago.
const codexLog = [meta, context, {...codex(usage(300)), timestamp: ago(400)}, {...codex(usage(500)), timestamp: ago(40)}];
const TOKENS = {today: 140, tenDays: 150, fortyDays: 200, hundredDays: 160, fourHundredDays: 300};
const EVERYTHING = 'from=2000-01-01&to=2099-12-31';
let server: Server;
const tokens = async (query: string) => (await getJson(server, `/api/local/summary?${query}`)).tokens;
const ROUTES = ['summary', 'sessions', 'breakdown', 'projects', 'export'];
const bad = async (query: string, code = 'INVALID_FILTER') => {
  for (const route of ROUTES) expectError(await server.request(`/api/local/${route}?${query}`), 400, code);
};

beforeAll(async () => {
  server = await startServer();
  const roots = logRoots(server);
  await writeLog(join(roots.claude, 'p', 'session.jsonl'), claudeAt('a', 10, ago(0)), claudeAt('b', 20, ago(10)), claudeAt('c', 30, ago(100)));
  await writeLog(join(roots.codex, 'rollout.jsonl'), ...codexLog);
  for (const tool of ['claude', 'codex'] as const) expect((await configure(server, tool, true, [roots[tool]])).status).toBe(200);
  await refresh(server);
});

describe('rolling and custom ranges', () => {
  it('defaults to the last 7 days', async () => {
    expect(await tokens('')).toBe(TOKENS.today);
  });
  it.each([
    [7, TOKENS.today],
    [30, TOKENS.today + TOKENS.tenDays],
    [90, TOKENS.today + TOKENS.tenDays + TOKENS.fortyDays],
    [365, TOKENS.today + TOKENS.tenDays + TOKENS.fortyDays + TOKENS.hundredDays],
  ])('days=%i covers a rolling window that reaches back that many days', async (days, expected) => {
    expect(await tokens(`days=${days}`)).toBe(expected);
    const [sessions, projects] = [await getJson(server, `/api/local/sessions?days=${days}`), await getJson(server, `/api/local/projects?days=${days}`)];
    expect(sessions.items.reduce((sum: number, item: {tokens: number}) => sum + item.tokens, 0)).toBe(expected);
    expect(projects.items.reduce((sum: number, item: {tokens: number}) => sum + item.tokens, 0)).toBeLessThanOrEqual(expected);
  });
  it('covers inclusive UTC days for today and custom ranges', async () => {
    const [today, tenDays, hundred, fourHundred] = [utcDay(Date.parse(ago(0))), utcDay(Date.parse(ago(10))), utcDay(Date.parse(ago(100))), utcDay(Date.parse(ago(400)))];
    expect(await tokens(`from=${today}&to=${today}`)).toBe(TOKENS.today);
    expect(await tokens(`from=${tenDays}&to=${today}`)).toBe(TOKENS.today + TOKENS.tenDays);
    expect(await tokens(`from=${tenDays}&to=${tenDays}`)).toBe(TOKENS.tenDays);
    expect(await tokens(`from=${hundred}&to=${hundred}`)).toBe(TOKENS.hundredDays);
    expect(await tokens(`from=${fourHundred}&to=${fourHundred}`)).toBe(TOKENS.fourHundredDays);
    // Days between the first and last data day are empty; ranges outside the window the rolling days cannot reach still work.
    expect(await tokens(`from=${utcDay(now - 5 * DAY_MS)}&to=${utcDay(now - 2 * DAY_MS)}`)).toBe(0);
    expect(await tokens(EVERYTHING)).toBe(Object.values(TOKENS).reduce((sum, value) => sum + value, 0));
  });
  it('shifts a rolling window back by offset days, for the previous period', async () => {
    expect(await tokens('offset=0')).toBe(TOKENS.today);
    expect(await tokens('offset=5')).toBe(TOKENS.tenDays);
    expect(await tokens('days=7&offset=5')).toBe(TOKENS.tenDays);
    expect(await tokens('days=30&offset=30')).toBe(TOKENS.fortyDays);
    expect(await tokens('days=90&offset=90')).toBe(TOKENS.hundredDays);
    expect(await tokens('days=90&offset=365')).toBe(TOKENS.fourHundredDays);
    expect(await tokens('days=365&offset=365')).toBe(TOKENS.fourHundredDays);
  });
  it('reports the daily split of a range, oldest day first, adding up to the total', async () => {
    const summary = await getJson(server, `/api/local/summary?${EVERYTHING}`);
    expect(summary.daily.map((row: {day: string}) => row.day)).toEqual([ago(400), ago(100), ago(40), ago(10), ago(0)].map(stamp => utcDay(Date.parse(stamp))));
    expect(summary.daily.map((row: {tokens: number}) => row.tokens)).toEqual([TOKENS.fourHundredDays, TOKENS.hundredDays, TOKENS.fortyDays, TOKENS.tenDays, TOKENS.today]);
    expect(summary.activity).toMatchObject({activeDays: 5, longestStreak: 1, bestDay: {tokens: TOKENS.fourHundredDays}});
    const breakdown = (await getJson(server, `/api/local/breakdown?${EVERYTHING}`)).items;
    expect(breakdown.map((row: {day: string}) => row.day)).toEqual(summary.daily.map((row: {day: string}) => row.day));
  });
  it('filters by tool and by text in the session, project or model', async () => {
    expect(await tokens('days=90&tool=codex')).toBe(TOKENS.fortyDays);
    expect(await tokens('days=90&tool=claude')).toBe(TOKENS.today + TOKENS.tenDays);
    expect(await tokens('days=90&tool=all')).toBe(TOKENS.today + TOKENS.tenDays + TOKENS.fortyDays);
    expect(await tokens('days=90&tool=gemini')).toBe(0);
    expect(await tokens('days=90&q=GPT-5')).toBe(TOKENS.fortyDays);
    expect(await tokens('days=90&q=codex-project')).toBe(TOKENS.fortyDays);
    expect(await tokens('days=90&q=claude-session')).toBe(TOKENS.today + TOKENS.tenDays);
    expect(await tokens('days=90&q=no-such-text')).toBe(0);
    expect(await tokens('days=90&tool=codex&q=sonnet')).toBe(0);
    expect((await getJson(server, '/api/local/summary?days=90&tool=codex')).byTool).toEqual([{tool: 'codex', tokens: TOKENS.fortyDays, breakdown: expect.any(Object), costMicrousd: expect.any(Number), costParts: expect.any(Object), sessions: 1}]);
    expect((await getJson(server, '/api/local/sessions?days=90&tool=codex')).items).toHaveLength(1);
  });
  it('reports an empty range with null cost, zero activity and empty lists', async () => {
    expect(await getJson(server, '/api/local/summary?days=90&q=no-such-text')).toEqual({tokens: 0, breakdown: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0}, costMicrousd: null, costParts: null, sessions: 0, cacheRate: 0, byTool: [], byModel: [], daily: [], byHour: Array(24).fill(0),
      activity: {activeDays: 0, currentStreak: 0, longestStreak: 0, bestDay: null, averagePerActiveDay: 0}});
  });
});

describe('invalid queries', () => {
  it('rejects a rolling window that is not 7, 30, 90 or 365 days, on every usage route', async () => {
    for (const days of ['0', '1', '14', '60', '366', '-7', '7.5', 'abc', '']) await bad(`days=${days}`);
  });
  it('rejects a half range, an inverted range, an impossible day, a loose format, or days mixed with a range', async () => {
    for (const query of ['from=2026-10-20', 'to=2026-10-20', 'from=2026-10-21&to=2026-10-20', 'from=2026-02-30&to=2026-03-01', 'from=2026-13-01&to=2026-13-02', 'from=2026-1-1&to=2026-1-2',
      'from=20261020&to=20261021', 'from=&to=', 'from=today&to=today', 'days=7&from=2026-10-20&to=2026-10-20', 'days=30&to=2026-10-20']) await bad(query);
  });
  it('rejects an offset outside 0 to 365 days, a fractional or non-numeric one, and one with a custom range', async () => {
    for (const offset of ['-1', '366', '7.5', 'abc']) expectError(await server.request(`/api/local/summary?days=7&offset=${offset}`), 400, 'INVALID_FILTER');
    const today = utcDay(now);
    expectError(await server.request(`/api/local/summary?from=${today}&to=${today}&offset=7`), 400, 'INVALID_FILTER');
  });
  it('rejects an unknown tool and a search text longer than 200 characters', async () => {
    await bad('tool=nope');
    await bad('tool=Claude');
    await bad(`q=${'a'.repeat(201)}`);
    expect((await server.request(`/api/local/summary?q=${'a'.repeat(200)}`)).status).toBe(200);
  });
  it('rejects a query parameter it does not know with INVALID_REQUEST', async () => {
    await bad('days=7&extra=1', 'INVALID_REQUEST');
    await bad('page=2', 'INVALID_REQUEST');
  });
  it('answers an invalid query with JSON, not CSV, on the export route', async () => {
    const reply: Reply = await server.request('/api/local/export?days=3');
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    expect(reply.text).not.toContain('"tool","model"');
  });
});
