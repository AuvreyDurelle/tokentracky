import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {startServer, type Server} from './runner.ts';

const TOOLS = [['claude', 'Claude Code'], ['cline', 'Cline'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['gemini', 'Gemini CLI'], ['kilo', 'Kilo Code'], ['opencode', 'OpenCode'], ['roo', 'Roo Code']] as const;
/**
 * Tools only some implementations read. Each is listed; one that is read asks for
 * permission and offers its folder, one that is not is unsupported and offers none.
 */
const LATER = [['codebuddy', 'CodeBuddy'], ['commandcode', 'Command Code'], ['copilot', 'GitHub Copilot'], ['deepseek', 'DeepSeek Harness'], ['dumate', 'DuMate'], ['everycode', 'Every Code'], ['goose', 'Goose'], ['grok', 'Grok Build'], ['hermes', 'Hermes Agent'], ['kimi', 'Kimi Code'], ['lmstudio', 'LM Studio'], ['mimo', 'Mimo Code'], ['minimax', 'MiniMax Code'], ['omo', 'OmO'], ['omp', 'oh-my-pi'], ['openclaw', 'OpenClaw'], ['pi', 'pi'], ['primeagent', 'Prime Agent'], ['reasonix', 'Reasonix'], ['unsloth', 'Unsloth Studio'], ['zcode', 'ZCode'], ['zed', 'Zed Agent']] as const;
const ALL = [...TOOLS, ...LATER].sort(([a], [b]) => a < b ? -1 : 1);
/** The default folder suggested for one-click Start tracking when the tool's folder does not exist here. */
const defaults = (home: string): Record<string, string[]> => ({
  claude: [join(home, '.claude', 'projects')], cline: [join(home, '.cline', 'data', 'sessions')], codex: [join(home, '.codex', 'sessions')], cursor: [],
  gemini: [join(home, '.gemini', 'tmp')], kilo: [join(home, '.local', 'share', 'kilo', 'kilo.db')], opencode: [join(home, '.local', 'share', 'opencode', 'opencode.db')],
  roo: [join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks')],
});
const source = (id: string, name: string, paths: string[] | null) => ({
  id, name, enabled: false, state: id === 'cursor' ? 'unsupported' : 'permission_required', paths: paths ?? expect.any(Array), lastImportedAt: null, eventCount: 0, message: expect.stringMatching(/\S/),
  capabilities: id === 'cursor' ? {tokens: false, models: false, projects: false, costs: false, quotas: false} : {tokens: true, models: true, projects: id !== 'gemini', costs: false, quotas: false},
});
const later = (id: string, name: string) => expect.objectContaining({id, name, enabled: false, lastImportedAt: null, eventCount: 0, state: expect.stringMatching(/^(?:unsupported|permission_required)$/), paths: expect.any(Array)});
let server: Server;
beforeAll(async () => {server = await startServer();});

describe('GET /api/health', () => {
  it('describes a local server with no hosted service and no sign-in', async () => {
    const reply = await server.request('/api/health');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    expect(reply.json()).toEqual({mode: 'local', authConfigured: false, version: expect.stringMatching(/^\d+\.\d+\.\d+/), cloudUrl: null, supabaseUrl: null, supabaseAnonKey: null, authProviders: []});
  });
});

describe('GET /api/local/status', () => {
  it('reports a fresh collector: every tool, nothing enabled, nothing scanned, the next refresh an hour away', async () => {
    const reply = await server.request('/api/local/status');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    const body = reply.json();
    expect(Object.keys(body).sort()).toEqual(['alias', 'cloudLinked', 'collecting', 'lastRefreshAt', 'lastScanAt', 'lastSyncAt', 'nextRefreshAt', 'pricingVersion', 'refreshing', 'sources', 'syncError']);
    const suggested = server.home ? defaults(server.home) : null;
    expect(body).toEqual({
      sources: ALL.map(([id, name]) => LATER.some(([other]) => other === id) ? later(id, name) : source(id, name, suggested && suggested[id]!)),
      collecting: false, lastScanAt: null, cloudLinked: false, lastSyncAt: null, syncError: null, alias: null,
      lastRefreshAt: null, nextRefreshAt: expect.any(String), refreshing: false, pricingVersion: expect.stringMatching(/^litellm:[0-9a-f]{12}$/),
    });
    const next = Date.parse(body.nextRefreshAt) - Date.now();
    expect(new Date(body.nextRefreshAt).toISOString()).toBe(body.nextRefreshAt);
    expect(next).toBeGreaterThan(3_500_000);
    expect(next).toBeLessThanOrEqual(3_700_000);
  });
});

describe('GET /api/local/detect', () => {
  it('lists nothing when no tool folder exists', async () => {
    const reply = await server.request('/api/local/detect');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    if (server.home) expect(reply.json()).toEqual({tools: []});
    else {
      expect(Object.keys(reply.json())).toEqual(['tools']);
      for (const tool of reply.json().tools) expect(tool).toEqual({id: expect.any(String), name: expect.any(String), paths: expect.any(Array)});
    }
  });
  it('finds the tools whose default folders or database files exist, and suggests them in the status', async ctx => {
    if (!server.home) return ctx.skip('needs a server whose HOME the runner controls');
    const home = server.home;
    const claudeRoots = [join(home, '.claude', 'projects'), join(home, '.config', 'claude', 'projects')];
    const opencode = join(home, '.local', 'share', 'opencode', 'opencode.db');
    for (const folder of [...claudeRoots, join(home, '.codex', 'sessions'), join(home, '.local', 'share', 'opencode')]) await mkdir(folder, {recursive: true});
    await writeFile(opencode, '');
    // A database path that is a folder, and a log folder that is a file, are not installations.
    await mkdir(join(home, '.local', 'share', 'kilo', 'kilo.db'), {recursive: true});
    await writeFile(join(home, '.gemini'), '');
    const detected = [{id: 'claude', name: 'Claude Code', paths: claudeRoots}, {id: 'codex', name: 'Codex', paths: [join(home, '.codex', 'sessions')]}, {id: 'opencode', name: 'OpenCode', paths: [opencode]}];
    expect((await server.request('/api/local/detect')).json()).toEqual({tools: detected});
    const sources = Object.fromEntries((await server.request('/api/local/status')).json().sources.filter((entry: {id: string}) => TOOLS.some(([id]) => id === entry.id)).map((entry: {id: string; paths: string[]}) => [entry.id, entry.paths]));
    expect(sources).toEqual({...defaults(home), claude: claudeRoots, codex: [join(home, '.codex', 'sessions')], opencode: [opencode]});
  });
});
