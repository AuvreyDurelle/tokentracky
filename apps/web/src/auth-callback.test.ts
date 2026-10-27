import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AuthAdapter} from './auth';
import type {Health} from './api';

const health: Health = {mode: 'hosted', authConfigured: true, version: 'test', cloudUrl: null,
  supabaseUrl: 'https://callback-test.example', supabaseAnonKey: 'synthetic-public-key'};
const storageKey = 'sb-callback-test-auth-token';
const user = {id: 'synthetic-user', aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.test'};
const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600})).toString('base64url')}.synthetic`;
const session = {access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, user};
let storage: Map<string, string>;
let request: ReturnType<typeof vi.fn>;

function browser(url: string) {
  const location = new URL(url);
  vi.stubGlobal('window', {location, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    history: {state: null, replaceState: vi.fn((_state, _title, value: string) => {location.href = value;})}});
}
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key)});
  vi.stubGlobal('document', {visibilityState: 'hidden'});
  vi.stubGlobal('BroadcastChannel', undefined);
  request = vi.fn(async () => Response.json(user));
  vi.stubGlobal('fetch', request);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  browser('https://board.example/');
});
afterEach(async () => {
  // Let the SDK's deferred sign-in notification finish before removing its synthetic browser.
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real Supabase callback security (VULN-002)', () => {
  it.each(['signup', 'recovery', 'bearer'])('refuses an injected implicit %s session without contacting auth', async type => {
    browser(`https://board.example/#access_token=${token}&refresh_token=synthetic-refresh&expires_in=3600&token_type=bearer&type=${type}`);
    const auth = new AuthAdapter(); auth.configure(health);
    expect(await auth.state()).toBe('signed_out');
    expect(await auth.accessToken()).toBeNull();
    expect(storage.has(storageKey)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves an existing legitimate session when an injected implicit callback fails', async () => {
    storage.set(storageKey, JSON.stringify(session));
    browser('https://board.example/#access_token=attacker&refresh_token=attacker&expires_in=3600&token_type=bearer');
    const auth = new AuthAdapter(); auth.configure(health);
    expect(await auth.state()).toBe('signed_in');
    expect(await auth.accessToken()).toBe(token);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not exchange an unsolicited code when this browser has no verifier', async () => {
    browser('https://board.example/?code=unsolicited-code');
    const auth = new AuthAdapter(); auth.configure(health);
    expect(await auth.state()).toBe('signed_out');
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps a rejected verifier exchange signed out', async () => {
    storage.set(`${storageKey}-code-verifier`, JSON.stringify('wrong-verifier'));
    request.mockResolvedValue(Response.json({error: 'invalid_grant', error_description: 'Code verifier rejected'}, {status: 400}));
    browser('https://board.example/?code=attacker-code');
    const auth = new AuthAdapter(); auth.configure(health);
    expect(await auth.state()).toBe('signed_out');
    expect(await auth.accessToken()).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([false, true])('exchanges a browser-bound code and preserves recovery=%s', async recovery => {
    storage.set(`${storageKey}-code-verifier`, JSON.stringify(`browser-verifier${recovery ? '/recovery' : ''}`));
    request.mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toContain('/auth/v1/token?grant_type=pkce');
      expect(JSON.parse(init.body as string)).toEqual({auth_code: 'legitimate-code', code_verifier: 'browser-verifier'});
      return Response.json(session);
    });
    browser('https://board.example/?code=legitimate-code');
    const auth = new AuthAdapter(); auth.configure(health);
    const stop = auth.subscribe(() => {});
    expect(await auth.accessToken()).toBe(token);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await auth.state()).toBe(recovery ? 'recovery' : 'signed_in');
    expect(window.location.search).toBe('');
    expect(storage.has(`${storageKey}-code-verifier`)).toBe(false);
    stop();
  });

  it('starts password recovery with a verifier and an S256 challenge', async () => {
    request.mockResolvedValue(Response.json({}));
    const auth = new AuthAdapter(); auth.configure(health);
    await auth.requestPasswordReset('synthetic@example.test');
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/auth/v1/recover');
    expect(JSON.parse(init.body as string)).toMatchObject({email: 'synthetic@example.test', code_challenge_method: 's256'});
    expect(JSON.parse(init.body as string).code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...storage.values()].some(value => value.includes('/recovery'))).toBe(true);
  });
});
