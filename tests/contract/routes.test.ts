import {beforeAll, describe, expect, it} from 'vitest';
import inventory from './routes.json';
import {startServer, type Init, type Server} from './runner.ts';
import {expectError} from './support.ts';

const routes: Array<{method: string; path: string; static?: boolean}> = inventory.routes;
/** A well-formed request for each route: a concrete path for templates, a body for writes. Everything else is sent as listed. */
const SAMPLES: Record<string, {path?: string; json?: unknown}> = {
  'PUT /api/local/sources/:id': {path: '/api/local/sources/claude', json: {enabled: false, paths: []}},
  'PUT /api/local/collection': {json: {paused: false}},
  'PUT /api/local/settings': {json: {menuBar: 'tokens', menuBarPeriod: 'today'}},
  // A well-formed link to a non-loopback http origin is refused before any network access.
  'PUT /api/local/cloud': {json: {url: 'http://example.com', deviceToken: 'x'.repeat(32), historyStart: null, shareTools: false, shareCost: false}},
  'GET /api/profiles/:alias': {path: '/api/profiles/someone'},
  'GET /api/profiles/:alias/stats': {path: '/api/profiles/someone/stats'},
  'GET /u/:alias': {path: '/u/Some-Builder'},
  'GET /assets/*': {path: '/assets/contract.js'},
};
const sample = ({method, path}: {method: string; path: string}): [string, Init] => {
  const {path: concrete = path, json} = SAMPLES[`${method} ${path}`] ?? {};
  return [concrete, {method, ...(json === undefined ? {} : {json})}];
};
let server: Server;
beforeAll(async () => {server = await startServer();});

describe('route inventory', () => {
  it('lists each method and path once, with a sample for every template', () => {
    const keys = routes.map(route => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const route of routes) {
      expect(['GET', 'POST', 'PUT', 'DELETE']).toContain(route.method);
      if (/[:*]/.test(route.path)) expect(SAMPLES, route.path).toHaveProperty([`${route.method} ${route.path}`]);
    }
    expect(Object.keys(SAMPLES).filter(key => !keys.includes(key))).toEqual([]);
  });
  it('answers every listed route with something other than 404', async () => {
    for (const route of routes.filter(route => !route.static || server.webRoot)) {
      const [path, init] = sample(route);
      const reply = await server.request(path, init);
      expect({route: `${route.method} ${route.path}`, status: reply.status}).not.toEqual({route: `${route.method} ${route.path}`, status: 404});
    }
  });
  it('protects every listed route with the session, answering 401 rather than 404 or a page', async () => {
    for (const route of routes) {
      const [path, init] = sample(route);
      const reply = await server.request(path, {...init, headers: {cookie: null}});
      expect({route: `${route.method} ${route.path}`, status: reply.status}).toEqual({route: `${route.method} ${route.path}`, status: 401});
      expectError(reply, 401, 'LOCAL_AUTH_REQUIRED');
    }
  });
});

describe('web app pages', () => {
  it('serves the web app as HTML at its pages and at a profile address whose alias fits the alias pattern', async () => {
    if (!server.webRoot) return;
    for (const path of ['/', '/privacy', '/terms', '/support', '/leaderboard', '/you', '/u/Some-Builder', '/u/abc', `/u/${'a'.repeat(30)}`, '/u/a_-', '/u/Some%2DBuilder']) {
      const reply = await server.request(path);
      expect({path, status: reply.status}).toEqual({path, status: 200});
      expect(reply.headers['content-type']).toMatch(/^text\/html/);
      expect(reply.text).toContain('contract workspace');
    }
  });
  it('answers 404 NOT_FOUND for a profile address whose alias is too short, too long or has a character outside the pattern', async () => {
    for (const path of ['/u/x', '/u/ab', `/u/${'a'.repeat(31)}`, '/u/-builder', '/u/_builder', '/u/bad.name', '/u/bad%20name', '/u/%C3%A9t%C3%A9', '/u/a/b', '/u/Some-Builder/']) {
      expectError(await server.request(path), 404, 'NOT_FOUND');
    }
  });
});

describe('unknown routes and the uniform error shape', () => {
  it('answers 404 NOT_FOUND for unknown paths under the session, whatever the method', async () => {
    for (const path of ['/api/nope', '/api/local', '/api/local/nope', '/api/local/status/extra', '/api/account', '/api/device-auth', '/api/ingest', '/privacy/extra']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) expectError(await server.request(path, {method}), 404, 'NOT_FOUND');
    }
    if (server.webRoot) expectError(await server.request('/assets/missing.js'), 404, 'NOT_FOUND');
  });
  it('answers 404 NOT_FOUND, not 405, when a known path is used with another method', async () => {
    for (const [method, path] of [['GET', '/api/local/refresh'], ['GET', '/api/local/scan'], ['POST', '/api/local/status'], ['DELETE', '/api/local/summary'], ['PUT', '/api/health'], ['POST', '/api/leaderboard'], ['GET', '/api/local/cloud'], ['GET', '/api/local/sync']] as const) {
      expectError(await server.request(path, {method}), 404, 'NOT_FOUND');
    }
  });
  it('answers 400 INVALID_REQUEST for a body that is not JSON', async () => {
    const headers = {'content-type': 'application/json'};
    for (const path of ['/api/local/collection', '/api/local/settings', '/api/local/sources/claude', '/api/local/cloud']) {
      for (const body of ['{"paused":', 'not json', '{']) expectError(await server.request(path, {method: 'PUT', body, headers}), 400, 'INVALID_REQUEST');
    }
  });
  it('wraps every error in exactly {error:{code,message}}', async () => {
    const replies = [
      await server.request('/api/nope'),
      await server.request('/api/local/summary?days=3'),
      await server.request('/api/local/collection', {method: 'PUT', json: {paused: 'yes'}}),
      await server.request('/api/local/sources/nope', {method: 'PUT', json: {enabled: false, paths: []}}),
      await server.request('/api/leaderboard'),
      await server.request('/api/local/sync', {method: 'POST'}),
      await server.request('/api/local/status', {headers: {cookie: null}}),
      await server.request('/api/local/status', {headers: {host: 'evil.example'}}),
    ];
    for (const reply of replies) {
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(reply.headers['content-type']).toMatch(/^application\/json/);
      const body = reply.json();
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
      expect(body.error.code).toMatch(/^[A-Z][A-Z_]+$/);
      expect(typeof body.error.message).toBe('string');
    }
  });
});
