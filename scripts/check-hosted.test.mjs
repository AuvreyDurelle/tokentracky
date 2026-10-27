import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHosted } from './check-hosted.mjs';

const response = (body, status = 200) => new globalThis.Response(JSON.stringify(body), { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "object-src 'none'; frame-ancestors 'none'",
} });
const health = { mode: 'hosted', authConfigured: true, authProviders: ['email'], supabaseUrl: 'https://synthetic.supabase.co', supabaseAnonKey: 'test-public-key' };
function probe(overrides = {}) {
  return async url => {
    if (url.endsWith('/api/health')) return response({ ...health, ...overrides });
    if (url.endsWith('/auth/v1/settings')) return response({ external: { email: true }, mailer_autoconfirm: false });
    return response({}, url.endsWith('/api/local/status') ? 404 : 200);
  };
}
test('bounded baseline probes pass without claiming live user flows', async () => {
  const report = await checkHosted('https://board.example', { fetcher: probe() });
  assert.equal(report.passed, true);
  assert.ok(report.notVerified.includes('Email receipt and recovery completion'));
  assert.equal(JSON.stringify(report).includes('test-public-key'), false);
});
test('release check fails when advertised or enabled OAuth providers are missing', async () => {
  const report = await checkHosted('https://board.example', { fetcher: probe(), requiredProviders: ['email', 'github', 'google'] });
  assert.equal(report.passed, false);
  assert.equal(report.results.find(check => check.name === 'enabled providers').passed, false);
});
test('untrusted auth origins never receive the public key', async () => {
  const requests = [];
  const fetcher = async url => { requests.push(url); return probe({ supabaseUrl: 'https://attacker.example' })(url); };
  const report = await checkHosted('https://board.example', { fetcher });
  assert.equal(report.passed, false);
  assert.equal(requests.some(url => url.startsWith('https://attacker.example')), false);
});
test('network failures are redacted and fail closed', async () => {
  const report = await checkHosted('https://board.example', { fetcher: async () => { throw new Error('sensitive details'); } });
  assert.equal(report.passed, false);
  assert.equal(JSON.stringify(report).includes('sensitive details'), false);
});
