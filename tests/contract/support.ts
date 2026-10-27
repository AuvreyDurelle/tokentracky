import {expect} from 'vitest';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {Reply, Server} from './runner.ts';
import {jsonl} from './fixtures.ts';

/** The UTC day of every fixture event in fixtures.ts. */
export const FIXTURE_DAY = '2026-10-20';

/** The uniform error body: exactly `{error:{code,message}}`, with a human-readable message that is never asserted. */
export function expectError(reply: Reply, status: number, code: string): void {
  expect(reply.headers['content-type']).toMatch(/^application\/json/);
  expect({status: reply.status, body: reply.json()}).toEqual({status, body: {error: {code, message: expect.stringMatching(/\S/)}}});
}

/**
 * Two full refresh cycles. A refresh joins a cycle that is already running, and enabling a source starts one in the
 * background, so the first call may return before the latest change was scanned; the second always starts afterwards.
 */
export async function refresh(server: Server): Promise<Reply> {
  let reply!: Reply;
  for (let pass = 0; pass < 2; pass++) {
    reply = await server.request('/api/local/refresh', {method: 'POST'});
    expect(reply.status).toBe(200);
  }
  return reply;
}

/** Where the tools' default log folders are: below the server's HOME when the runner owns it, otherwise the scratch directory. */
export const logRoots = (server: Server) => ({claude: join(server.home ?? server.dir, '.claude', 'projects'), codex: join(server.home ?? server.dir, '.codex', 'sessions')});

export async function writeLog(path: string, ...records: unknown[]): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, jsonl(...records));
}

export const configure = (server: Server, tool: string, enabled: boolean, paths: string[]) => server.request(`/api/local/sources/${tool}`, {method: 'PUT', json: {enabled, paths}});

/** GET a route that must succeed and return its parsed JSON body. */
export async function getJson(server: Server, path: string) {
  const reply = await server.request(path);
  expect({path, status: reply.status}).toEqual({path, status: 200});
  return reply.json();
}
