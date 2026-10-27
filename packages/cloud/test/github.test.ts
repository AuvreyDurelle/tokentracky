import { describe, expect, it } from 'vitest';
import { supabaseGithubLogin } from '../src/index.ts';

const url = 'https://project.supabase.co';
/** A fake Supabase admin API answering every request with `user`. */
function admin(user: unknown, status = 200) {
  const calls: Array<{url: string; init: RequestInit | undefined}> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({url: String(input), init});
    return new Response(JSON.stringify(user), {status});
  }) as typeof fetch;
  return {calls, login: supabaseGithubLogin(url, 'service-role-key', fetchImpl)};
}

describe('Supabase GitHub login', () => {
  it('reads the GitHub identity of the signed-in user with the service key', async () => {
    const {calls, login} = admin({identities: [{provider: 'email', identity_data: {user_name: 'email-name'}}, {provider: 'github', identity_data: {user_name: 'octo-cat'}}]});
    expect(await login('user/1')).toBe('octo-cat');
    expect(calls).toEqual([{url: `${url}/auth/v1/admin/users/user%2F1`, init: {headers: {apikey: 'service-role-key', authorization: 'Bearer service-role-key'}, signal: expect.any(AbortSignal)}}]);
  });
  it('ignores user-editable metadata and other providers', async () => {
    const forged = {user_metadata: {user_name: 'octo-cat', preferred_username: 'octo-cat'}, identities: [{provider: 'google', identity_data: {user_name: 'octo-cat'}}]};
    expect(await admin(forged).login('user')).toBeNull();
    expect(await admin({user_metadata: {user_name: 'octo-cat'}}).login('user')).toBeNull();
  });
  it('rejects logins GitHub would not issue', async () => {
    for (const name of ['-octo', 'a'.repeat(40), 'octo cat', 'octo_cat', '', 42, null]) {
      expect(await admin({identities: [{provider: 'github', identity_data: {user_name: name}}]}).login('user'), String(name)).toBeNull();
    }
    expect(await admin({identities: [{provider: 'github', identity_data: {user_name: 'a'.repeat(39)}}]}).login('user')).toBe('a'.repeat(39));
  });
  it('answers null only when Supabase has no such user, and fails when it cannot answer', async () => {
    const github = {identities: [{provider: 'github', identity_data: {user_name: 'octo-cat'}}]};
    expect(await admin({}, 404).login('user')).toBeNull();
    for (const status of [401, 403, 429, 500, 503]) await expect(admin(github, status).login('user'), String(status)).rejects.toThrow(String(status));
  });
});
