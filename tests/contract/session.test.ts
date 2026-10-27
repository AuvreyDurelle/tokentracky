import {createHash} from 'node:crypto';
import {beforeAll, describe, expect, it} from 'vitest';
import {startServer, type Reply, type Server} from './runner.ts';
import {expectError, SECURITY_HEADERS} from './support.ts';

// The tests below run in order on one server: the launch link is one-use, so the first test that needs a session redeems it.
const HTML_RECOVERY_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const NO_SESSION = {cookie: null, origin: null};
const pick = (headers: Record<string, string>, names: string[]) => Object.fromEntries(names.map(name => [name, headers[name]]));
const securityHeaders = (reply: Reply) => pick(reply.headers, Object.keys(SECURITY_HEADERS));
let server: Server;
let launch: string;
let hosts: string[];
let origins: string[];

beforeAll(async () => {
  server = await startServer({login: false});
  const link = new URL(server.launchUrl);
  launch = link.pathname + link.search;
  hosts = ['evil.example', `evil.example:${link.port}`, `${link.hostname}.evil.example:${link.port}`, ...(link.port ? [link.hostname] : [])];
  origins = ['http://evil.example', `http://evil.example:${link.port}`, `https://${link.host}`, 'null'];
});

describe('launch link', () => {
  it('refuses every route before a session exists, without revealing which routes exist', async () => {
    for (const path of ['/api/local/status', '/api/health', '/api/nope', '/']) expectError(await server.request(path, {headers: NO_SESSION}), 401, 'LOCAL_AUTH_REQUIRED');
    const page = await server.request('/', {headers: {...NO_SESSION, accept: 'text/html,application/xhtml+xml'}});
    expect(page.status).toBe(401);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toBe(HTML_RECOVERY_CSP);
    expect(pick(page.headers, ['x-content-type-options', 'cache-control', 'referrer-policy'])).toEqual({'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer'});
    expect(page.text).toMatch(/^<!doctype html>/i);
    expect(page.cookies).toEqual([]);
    // Only the workspace page falls back to HTML; API routes always answer with the JSON error.
    expectError(await server.request('/api/local/status', {headers: {...NO_SESSION, accept: 'text/html'}}), 401, 'LOCAL_AUTH_REQUIRED');
  });
  it('rejects a wrong Host before it looks at the launch link, and keeps the link usable', async () => {
    for (const host of hosts) {
      const reply = await server.request(launch, {headers: {...NO_SESSION, host}});
      expectError(reply, 403, 'ORIGIN_REJECTED');
      expect(reply.cookies).toEqual([]);
    }
  });
  it('rejects unknown launch tokens', async () => {
    for (const path of ['/?launch=', '/?launch=not-a-token', '/?launch=' + 'a'.repeat(32), '/api/local/status?launch=not-a-token']) {
      const reply = await server.request(path, {headers: NO_SESSION});
      expectError(reply, 401, 'LOCAL_AUTH_REQUIRED');
      expect(reply.cookies).toEqual([]);
    }
  });
  it('exchanges the launch link once for an HttpOnly, SameSite=Strict session cookie', async () => {
    // A link opened from another app is a cross-site navigation; the link itself authorises the entry.
    const first = await server.request(launch, {headers: {...NO_SESSION, 'sec-fetch-site': 'cross-site'}});
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^text\/html/);
    expect(first.cookies).toHaveLength(1);
    const [cookie] = first.cookies as [string];
    expect(cookie).toMatch(/^[^=;\s]+=[^;\s]+/);
    expect(cookie).toMatch(/;\s*HttpOnly\s*(?:;|$)/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict\s*(?:;|$)/i);
    expect(cookie).toMatch(/;\s*Path=\/\s*(?:;|$)/i);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    // The token never stays in a URL: a local document commits the cookie, then replaces itself with "/".
    const script = /<script>([\s\S]*?)<\/script>/.exec(first.text)?.[1];
    expect(script).toMatch(/location\.replace\(["']\/["']\)/);
    const digest = createHash('sha256').update(script!).digest('base64');
    expect(first.headers['content-security-policy']).toBe(`default-src 'none'; script-src 'sha256-${digest}'; base-uri 'none'; frame-ancestors 'none'`);
    expect(pick(first.headers, ['x-content-type-options', 'cache-control', 'referrer-policy', 'permissions-policy'])).toEqual({
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()'});
    expect(first.text).not.toContain(launch.split('launch=')[1]!);

    const replay = await server.request(launch, {headers: NO_SESSION});
    expectError(replay, 401, 'LOCAL_AUTH_REQUIRED');
    expect(replay.cookies).toEqual([]);
    const replayPage = await server.request(launch, {headers: {...NO_SESSION, accept: 'text/html'}});
    expect(replayPage.status).toBe(401);
    expect(replayPage.headers['content-type']).toMatch(/^text\/html/);
    expect(replayPage.headers['content-security-policy']).toBe(HTML_RECOVERY_CSP);
    expect(replayPage.text).not.toContain(launch.split('launch=')[1]!);
    expect(replayPage.cookies).toEqual([]);

    server.cookie = cookie.split(';')[0]!;
    // Replaying a spent link neither revokes nor replaces the session that it created.
    expect((await server.request('/api/local/status', {headers: {origin: null}})).status).toBe(200);
  });
});

describe('session protection', () => {
  it('requires the session cookie on every request', async () => {
    const [name, value] = server.cookie!.split('=') as [string, string];
    const wrong = value.slice(0, -1) + (value.endsWith('a') ? 'b' : 'a');
    for (const cookie of [null, '', `${name}=`, `${name}=${wrong}`, `${name}=${value}${value}`, `other=${value}`]) {
      expectError(await server.request('/api/local/status', {headers: {cookie}}), 401, 'LOCAL_AUTH_REQUIRED');
      expectError(await server.request('/api/local/refresh', {method: 'POST', headers: {cookie}}), 401, 'LOCAL_AUTH_REQUIRED');
    }
    expectError(await server.request('/api/nope', {headers: {cookie: null}}), 401, 'LOCAL_AUTH_REQUIRED');
  });
  it('accepts reads with or without an Origin header when the cookie and Host are right', async () => {
    expect((await server.request('/api/local/status')).status).toBe(200);
    expect((await server.request('/api/local/status', {headers: {origin: null}})).status).toBe(200);
  });
  it('rejects a wrong Host, even with a valid cookie and for the launch route', async () => {
    for (const host of hosts) {
      expectError(await server.request('/api/local/status', {headers: {host}}), 403, 'ORIGIN_REJECTED');
      expectError(await server.request('/api/local/refresh', {method: 'POST', headers: {host}}), 403, 'ORIGIN_REJECTED');
      expectError(await server.request('/api/local/status', {headers: {host, cookie: null}}), 403, 'ORIGIN_REJECTED');
    }
  });
  it('rejects a wrong Origin on reads and on changes, even with a valid cookie', async () => {
    for (const origin of origins) {
      expectError(await server.request('/api/local/status', {headers: {origin}}), 403, 'ORIGIN_REJECTED');
      expectError(await server.request('/api/local/refresh', {method: 'POST', headers: {origin}}), 403, 'ORIGIN_REJECTED');
    }
  });
  it('requires the workspace Origin for every change, and changes nothing without it', async () => {
    expectError(await server.request('/api/local/refresh', {method: 'POST', headers: {origin: null}}), 403, 'ORIGIN_REQUIRED');
    expectError(await server.request('/api/local/scan', {method: 'POST', headers: {origin: null}}), 403, 'ORIGIN_REQUIRED');
    expectError(await server.request('/api/local/collection', {method: 'PUT', json: {paused: true}, headers: {origin: null}}), 403, 'ORIGIN_REQUIRED');
    expectError(await server.request('/api/local/cloud', {method: 'DELETE', headers: {origin: null}}), 403, 'ORIGIN_REQUIRED');
    // The rejected pause had no effect: a refresh still runs (it would answer 409 if collection were paused).
    expect((await server.request('/api/local/refresh', {method: 'POST'})).status).toBe(200);
  });
  it('rejects cross-site fetches even with a valid cookie, and allows same-origin and direct navigation', async () => {
    expectError(await server.request('/api/local/status', {headers: {'sec-fetch-site': 'cross-site'}}), 403, 'LOCAL_AUTH_REQUIRED');
    expectError(await server.request('/api/local/refresh', {method: 'POST', headers: {'sec-fetch-site': 'cross-site'}}), 403, 'LOCAL_AUTH_REQUIRED');
    for (const site of ['same-origin', 'none']) expect((await server.request('/api/local/status', {headers: {'sec-fetch-site': site}})).status).toBe(200);
  });
});

describe('response headers', () => {
  it('sets every security header with its exact value on every kind of response', async () => {
    const replies: Array<[string, Reply]> = [
      ['health', await server.request('/api/health')],
      ['status', await server.request('/api/local/status')],
      ['empty 204', await server.request('/api/local/cloud', {method: 'DELETE'})],
      ['400 filter', await server.request('/api/local/summary?days=3')],
      ['400 body', await server.request('/api/local/collection', {method: 'PUT', json: {}})],
      ['404', await server.request('/api/nope')],
      ['503', await server.request('/api/leaderboard')],
      ['csv', await server.request('/api/local/export')],
      ['401', await server.request('/api/local/status', {headers: {cookie: null}})],
      ['403 host', await server.request('/api/local/status', {headers: {host: 'evil.example'}})],
      ['403 origin', await server.request('/api/local/refresh', {method: 'POST', headers: {origin: null}})],
      ...(server.webRoot ? [['workspace page', await server.request('/')] as [string, Reply]] : []),
    ];
    for (const [label, reply] of replies) expect({label, headers: securityHeaders(reply)}).toEqual({label, headers: SECURITY_HEADERS});
  });
  it('sends no CORS headers, so only the workspace origin can read responses', async () => {
    for (const headers of [{}, {origin: 'http://evil.example'}] as Array<Record<string, string>>) {
      const reply = await server.request('/api/local/status', {headers});
      expect(Object.keys(reply.headers).filter(name => name.startsWith('access-control-'))).toEqual([]);
    }
  });
});
