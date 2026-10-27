import {join} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {claude} from './fixtures.ts';
import {startServer, type Server} from './runner.ts';
import {configure, FIXTURE_DAY, logRoots, refresh, writeLog} from './support.ts';

const HEADER = '"tool","model","timestamp","project","session","input","output","cache_read","cache_write","reasoning","total","cost_microusd"';
const COLUMNS = HEADER.split(',').map(name => name.slice(1, -1));
const DAY = `from=${FIXTURE_DAY}&to=${FIXTURE_DAY}`;
const ROW = /^"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/;
let server: Server;
let roots: ReturnType<typeof logRoots>;

/** A claude record whose `input` count (unique per record) identifies its CSV row; the other fields override the fixture's. */
const record = (input: number, fields: {project?: string; model?: string; session?: string} = {}) => {
  const base = claude(`msg-${input}`, input, 0);
  return {...base, ...(fields.project === undefined ? {} : {cwd: fields.project}), ...(fields.session === undefined ? {} : {sessionId: fields.session}),
    message: {...base.message, ...(fields.model === undefined ? {} : {model: fields.model})}};
};
// Every field the adapters take from a log is text of up to a few KB without control characters, so a tab, CR or LF cannot
// start a cell here; the other formula starters can, including after leading spaces.
const SCENARIOS: Array<[input: number, field: 'project' | 'model' | 'session', value: string, cell: string]> = [
  [1, 'project', '=1+1+cmd', "'=1+1+cmd"],
  [2, 'project', '+SUM(A1:A9)', "'+SUM(A1:A9)"],
  [3, 'project', '-2+3', "'-2+3"],
  [4, 'project', '@SUM(A1)', "'@SUM(A1)"],
  [5, 'project', '  =1+1', "'  =1+1"],
  [6, 'project', ' @evil', "' @evil"],
  [7, 'project', '=HYPERLINK("http://evil.example","click")', `'=HYPERLINK("http://evil.example","click")`],
  [8, 'model', '=1+1', "'=1+1"],
  [9, 'session', '@session', "'@session"],
  [10, 'model', '-model', "'-model"],
  // Left alone: the starter is not first, or there is none.
  [11, 'project', 'a=b', 'a=b'],
  [12, 'project', 'x+y-z@w', 'x+y-z@w'],
  [13, 'project', '  plain text', '  plain text'],
  [14, 'project', 'say "hi", then leave', 'say "hi", then leave'],
  [15, 'project', '/synthetic/private-project', '/synthetic/private-project'],
];

/** RFC 4180 rows of quoted cells, CRLF separated. Fails on anything else (unquoted cells, bare LF). */
function parse(text: string): string[][] {
  expect(text.endsWith('\r\n')).toBe(true);
  const lines = text.slice(0, -2).split('\r\n');
  for (const line of lines) expect(line).toMatch(ROW);
  return lines.map(line => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1]!.replaceAll('""', '"')));
}
const exportOf = async (query: string) => {
  const reply = await server.request(`/api/local/export?${query}`);
  expect(reply.status).toBe(200);
  return reply;
};
const rowsOf = async (query: string) => {
  const [header, ...rows] = parse((await exportOf(query)).text);
  expect(header).toEqual(COLUMNS);
  return rows.map(row => Object.fromEntries(COLUMNS.map((name, index) => [name, row[index]!])));
};

beforeAll(async () => {
  server = await startServer();
  roots = logRoots(server);
  await writeLog(join(roots.claude, 'p', 'session.jsonl'), ...SCENARIOS.map(([input, field, value]) => record(input, {[field]: value})));
});

describe('GET /api/local/export', () => {
  it('is an empty CSV with only the header row before any source is authorised', async () => {
    const reply = await exportOf(DAY);
    expect(reply.text).toBe(`${HEADER}\r\n`);
  });
  it('downloads as text/csv with a fixed attachment file name', async () => {
    expect((await configure(server, 'claude', true, [roots.claude])).status).toBe(200);
    await refresh(server);
    const reply = await exportOf(DAY);
    expect(reply.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(reply.headers['content-disposition']).toBe('attachment; filename="tokentracky-usage.csv"');
    expect(reply.headers['cache-control']).toBe('no-store');
  });
  it('writes the header row, then one CRLF-terminated row per event, every cell quoted', async () => {
    const reply = await exportOf(DAY);
    expect(reply.text.startsWith(`${HEADER}\r\n`)).toBe(true);
    const rows = parse(reply.text);
    expect(rows).toHaveLength(SCENARIOS.length + 1);
    for (const row of rows) expect(row).toHaveLength(12);
  });
  it('carries each event: tool, model, UTC timestamp, project, session, the five counts, their total, and the cost', async () => {
    const rows = await rowsOf(DAY);
    const row = rows.find(item => item.input === '15')!;
    // claude('msg-15', 15, 0): 15 input + 100 cache read + 30 cache write, no output or reasoning.
    expect(row).toEqual({tool: 'claude', model: 'claude-sonnet-4-6', timestamp: `${FIXTURE_DAY}T12:00:00.000Z`, project: '/synthetic/private-project', session: 'claude-session',
      input: '15', output: '0', cache_read: '100', cache_write: '30', reasoning: '0', total: '145', cost_microusd: expect.stringMatching(/^\d+$/)});
  });
  it.each(SCENARIOS)('neutralises a formula that starts a cell, and only that (event %i: %s %j)', async (input, field, _value, cell) => {
    const row = (await rowsOf(DAY)).find(item => item.input === String(input))!;
    expect(row[field]).toBe(cell);
    // Only the text fields are ever touched; the numbers are never prefixed.
    for (const name of ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'total']) expect(row[name]).toMatch(/^\d+$/);
  });
  it('applies the same range, tool and text filters as the other usage routes', async () => {
    expect(await rowsOf('from=2026-10-21&to=2026-10-21')).toEqual([]);
    expect(await rowsOf(`${DAY}&tool=codex`)).toEqual([]);
    expect((await rowsOf(`${DAY}&tool=claude`)).length).toBe(SCENARIOS.length);
    expect((await rowsOf(`${DAY}&q=A1:A9`)).map(row => row.input)).toEqual(['2']);
    expect((await rowsOf(`${DAY}&q=hyperlink`)).map(row => row.input)).toEqual(['7']);
  });
  it('contains no prompt or response text', async () => {
    expect((await exportOf(DAY)).text).not.toContain('PRIVATE_PROMPT_MARKER');
  });
});
