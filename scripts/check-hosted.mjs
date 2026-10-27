import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';
import { performance } from 'node:perf_hooks';

/** Bounded, read-only probes. Reports contain no response bodies, account data or credentials. */
export async function checkHosted(origin, { fetcher = globalThis.fetch, requiredProviders = ['email'], timeoutMs = 15000 } = {}) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('Supply an HTTPS origin without a path or credentials');
  const results = [];
  const check = (name, passed, detail) => results.push({ name, passed: !!passed, detail });
  let health;
  for (const path of ['/api/health', '/api/leaderboard?period=all&pageSize=1', '/privacy', '/terms', '/support', '/api/local/status']) {
    const started = performance.now();
    try {
      const response = await fetcher(origin + path, { redirect: 'error', signal: globalThis.AbortSignal.timeout(timeoutMs) });
      const expected = path === '/api/local/status' ? 404 : 200;
      check(path, response.status === expected, `HTTP ${response.status}; ${Math.round(performance.now() - started)} ms`);
      if (path === '/api/health') {
        health = await response.json();
        check('hosted auth', health.mode === 'hosted' && health.authConfigured === true, 'Hosted authentication configuration');
        check('advertised providers', requiredProviders.every(provider => health.authProviders?.includes(provider)), `Required: ${requiredProviders.join(', ')}`);
      }
      if (path.startsWith('/api/')) check(`${path}: cache`, /\bno-store\b/.test(response.headers.get('cache-control') ?? ''), 'API responses must not be cached');
      check(`${path}: nosniff`, response.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options');
      if (path === '/privacy') {
        const csp = response.headers.get('content-security-policy') ?? '';
        check('browser security headers', csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && response.headers.get('referrer-policy') === 'no-referrer', 'CSP and referrer policy');
      }
      // Do not print public profiles or entire health payloads, even on failure.
      if (path !== '/api/health') await response.body?.cancel();
    } catch {
      check(path, false, 'Request failed, redirected, timed out, or returned invalid JSON');
    }
  }
  if (health?.supabaseUrl && health?.supabaseAnonKey) {
    // Avoid sending the public API key to an unexpected destination returned by a compromised origin.
    const auth = new URL(health.supabaseUrl);
    if (auth.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(auth.hostname) || auth.origin !== health.supabaseUrl) {
      check('auth provider configuration', false, 'Unexpected Supabase origin');
    } else {
      try {
        const response = await fetcher(auth.origin + '/auth/v1/settings', { headers: { apikey: health.supabaseAnonKey }, redirect: 'error', signal: globalThis.AbortSignal.timeout(timeoutMs) });
        const settings = await response.json();
        check('enabled providers', response.ok && requiredProviders.every(provider => settings.external?.[provider] === true), `Required: ${requiredProviders.join(', ')}`);
        check('advertised providers enabled', health.authProviders?.every(provider => settings.external?.[provider] === true), 'Site and identity-provider configuration agree');
        // This is an observation, not a policy assertion or an email-delivery test.
        results.push({ name: 'email confirmation', passed: null, detail: settings.mailer_autoconfirm === true ? 'Auto-confirmation enabled' : 'Email confirmation required' });
      } catch {
        check('auth provider configuration', false, 'Could not verify public auth settings');
      }
    }
  } else check('auth provider configuration', false, 'Public auth configuration missing');
  return { origin, checkedAt: new Date().toISOString(), passed: results.every(result => result.passed !== false), results,
    notVerified: ['OAuth sign-in', 'Email receipt and recovery completion', 'Backup restoration', 'Alert delivery', 'Per-client and distributed rate limits', 'Native approval'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await checkHosted(process.argv[2] ?? 'https://tokentracky.com', {
      requiredProviders: (process.env.TOKENTRACKY_CHECK_PROVIDERS ?? 'email,github,google').split(','),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.passed) process.exitCode = 1;
  } catch {
    process.stderr.write('Hosted check failed: supply a reachable HTTPS origin and valid probe configuration.\n');
    process.exitCode = 1;
  }
}
