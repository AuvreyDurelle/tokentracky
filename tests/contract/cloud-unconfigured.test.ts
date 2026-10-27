import {beforeAll, describe, expect, it} from 'vitest';
import {startServer, type Server} from './runner.ts';
import {expectError, getJson} from './support.ts';

// A local server with no hosted service configured. The link body names the hosted service itself, so link validation needs
// no configuration; every case below is refused before any network access, and none names a host that could answer.
const LINK = {url: 'https://hosted.example', deviceToken: 't'.repeat(32), historyStart: null, shareTools: false, shareCost: false};
const link = (body: unknown) => server.request('/api/local/cloud', {method: 'PUT', json: body});
let server: Server;
beforeAll(async () => {server = await startServer();});

describe('proxies to the hosted service, with none configured', () => {
  it.each(['/api/leaderboard', '/api/leaderboard?period=all', '/api/leaderboard?period=month&tool=claude&page=2', '/api/profiles/someone', '/api/profiles/someone?period=all', '/api/profiles/a%2Fb', '/api/profiles/%E2%9C%93', '/api/profiles/someone/stats', '/api/profiles/a%2Fb/stats'])('GET %s answers 503 CLOUD_UNAVAILABLE', async path => {
    expectError(await server.request(path), 503, 'CLOUD_UNAVAILABLE');
  });
  it('answers 503 before it looks at the query, so a bad query is not a 400', async () => {
    expectError(await server.request('/api/leaderboard?period=nonsense&extra=1'), 503, 'CLOUD_UNAVAILABLE');
  });
  it('does not proxy anything else of the hosted API', async () => {
    // Not `/api/community`: the Rust server proxies it for the Mac app (503 CLOUD_UNAVAILABLE here) while the frozen
    // TypeScript server answers 404, so neither answer is the contract.
    for (const path of ['/api/account', '/api/device-policy', '/badge/someone.svg']) expectError(await server.request(path), 404, 'NOT_FOUND');
  });
});

describe('device connection, with no hosted service configured', () => {
  it('POST /api/local/connect answers 503 CLOUD_UNAVAILABLE', async () => {
    expectError(await server.request('/api/local/connect', {method: 'POST'}), 503, 'CLOUD_UNAVAILABLE');
    expectError(await server.request('/api/local/connect', {method: 'POST', json: {}}), 503, 'CLOUD_UNAVAILABLE');
  });
  it('POST /api/local/connect/poll answers 409 CONNECT_NOT_STARTED, as nothing was started', async () => {
    expectError(await server.request('/api/local/connect/poll', {method: 'POST'}), 409, 'CONNECT_NOT_STARTED');
  });
});

describe('sync and unlink, with nothing linked', () => {
  it('POST /api/local/sync answers 409 CLOUD_NOT_LINKED', async () => {
    expectError(await server.request('/api/local/sync', {method: 'POST'}), 409, 'CLOUD_NOT_LINKED');
  });
  it('DELETE /api/local/cloud answers 204 with no body, however often it is repeated', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await server.request('/api/local/cloud', {method: 'DELETE'});
      expect({status: reply.status, text: reply.text}).toEqual({status: 204, text: ''});
    }
  });
  it('shows nothing linked in the status and no hosted service in the health', async () => {
    expect(await getJson(server, '/api/local/status')).toMatchObject({cloudLinked: false, alias: null, lastSyncAt: null, syncError: null});
    expect(await getJson(server, '/api/health')).toMatchObject({mode: 'local', cloudUrl: null});
  });
});

describe('PUT /api/local/cloud validation', () => {
  it('answers 400 INVALID_REQUEST for a body that is not an object, or has a field it does not know', async () => {
    for (const body of [[], 'link', 7, null, {...LINK, extra: true}, {...LINK, generation: 'x'}]) expectError(await link(body), 400, 'INVALID_REQUEST');
    expectError(await server.request('/api/local/cloud', {method: 'PUT'}), 400, 'INVALID_REQUEST');
  });
  it('answers 400 INVALID_LINK unless the token is 20 to 256 characters without whitespace and the sharing choices are booleans', async () => {
    const bad: Array<Record<string, unknown>> = [
      {deviceToken: undefined}, {deviceToken: 't'.repeat(19)}, {deviceToken: 't'.repeat(257)}, {deviceToken: `${'t'.repeat(20)} ${'t'.repeat(20)}`}, {deviceToken: `${'t'.repeat(20)}\n`}, {deviceToken: 1234567890},
      {shareTools: undefined}, {shareTools: 'yes'}, {shareTools: 1}, {shareCost: undefined}, {shareCost: null}, {shareModels: 'yes'}, {shareModels: 1},
      // Checked before the URL and the history.
      {deviceToken: 'short', url: 'not a url', historyStart: 'never'},
    ];
    for (const change of bad) expectError(await link({...LINK, ...change}), 400, 'INVALID_LINK');
  });
  it('answers 400 INVALID_CLOUD_URL unless the URL is the HTTPS origin of the service (loopback HTTP is allowed)', async () => {
    const urls: unknown[] = [undefined, null, 7, '', 'not a url', 'hosted.example', 'http://hosted.example', 'ftp://hosted.example', 'https://user@hosted.example', 'https://user:secret@hosted.example',
      'https://hosted.example/path', 'https://hosted.example/api', 'https://hosted.example/?a=1', 'https://hosted.example/#section', 'javascript:alert(1)', 'http://127.0.0.1.hosted.example'];
    for (const url of urls) expectError(await link({...LINK, url}), 400, 'INVALID_CLOUD_URL');
  });
  it('answers 400 INVALID_HISTORY unless the history start is null or a UTC day no later than today', async () => {
    const days: unknown[] = [undefined, '', 'yesterday', '2026-02-30', '2026-13-01', '2026-1-1', '2999-01-01', '2999-01-01T00:00:00.000Z', 20261020, true, '2026-10-20T12:00:00.000Z', '2026-10-20T00:00:00+02:00', {day: '2026-10-20'}];
    for (const historyStart of days) expectError(await link({...LINK, historyStart}), 400, 'INVALID_HISTORY');
  });
  it('answers 413 INVALID_REQUEST for a body over 4 KiB', async () => {
    expectError(await link({...LINK, deviceToken: 't'.repeat(5000)}), 413, 'INVALID_REQUEST');
  });
  it('leaves the device unlinked after every refused request', async () => {
    expect(await getJson(server, '/api/local/status')).toMatchObject({cloudLinked: false, alias: null});
    expectError(await server.request('/api/local/sync', {method: 'POST'}), 409, 'CLOUD_NOT_LINKED');
  });
});
