import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Publication } from '@tokentracky/core';
import { ApiError, type ApiClient } from './api';
import { badgeUrl, cardUrl, HostedAccount, ModerationNotice, ProfileForm, SignIn } from './Account';
import type { AuthAdapter, AuthState } from './auth';
import { Connect, connectComputer, prefill } from './Connect';
import { CONNECT_NOTICE } from './publication';

const api = {} as ApiClient;
const render = (publication: Publication | null, repair = false) => renderToStaticMarkup(<ProfileForm api={api} publication={publication} repair={repair} onSaved={() => {}} />);
// Older saves can carry narrower fields; the form never shows or sends them.
const saved: Publication = { alias: 'builder', historyStart: '2026-01-05T00:00:00.000Z', shareTools: false, shareCost: false, shareModels: false, generation: 'internal' };
const choices = /type="(?:radio|checkbox)"|role="switch"/;

// Rendering verifies the actual controlled form: a name and nothing to choose or consent to.
describe('leaderboard profile form', () => {
  it('asks new members for a name only, with no history choice, sharing switches or consent box', () => {
    const html = render(null);
    expect(html).toContain('Leaderboard name');
    expect(html).toMatch(/<button class="btn primary lg">Continue<\/button>/);
    expect(html).toContain('How you’ll appear');
    expect(html).not.toMatch(choices);
    expect(html).not.toMatch(/consent|I can leave/i);
    expect(html).not.toContain('Saving resets your public totals');
  });
  it('shows a saved name with Save disabled until it changes, without its saved history or sharing fields', () => {
    const html = render(saved);
    expect(html).toContain('value="builder"');
    expect(html).toMatch(/<button class="btn primary sm" disabled="">Save name<\/button>/);
    expect(html).not.toContain('Saving resets your public totals');
    expect(html).not.toMatch(choices);
    expect(html).not.toMatch(/Since Jan 5|history since/);
  });
  it('lets a held listing save its unchanged name, saying that saving resets public totals', () => {
    const html = render(saved, true);
    expect(html).toMatch(/<button class="btn primary sm">Save name<\/button>/);
    expect(html).toContain('Saving resets your public totals');
  });
});

describe('connect screen', () => {
  const connect = (publication: Publication | null, authState: AuthState = 'signed_in') => renderToStaticMarkup(<Connect api={api} auth={{ providers: [] } as unknown as AuthAdapter} authState={authState} account={{ publication, devices: [] }}
    accountLoading={false} accountError={null} refreshAccount={async () => {}} code="QWTR-BKXM" origin="https://tokentracky.test" onFinish={() => {}} onProfile={() => {}} />);
  it('has two steps, sign in then name and connect, with the code shown on both', () => {
    const signIn = connect(null, 'signed_out');
    expect(signIn).toContain('Step 1 of 2');
    expect(signIn).toContain('QWTR-BKXM');
    const name = connect(null);
    expect(name).toContain('Step 2 of 2');
    expect(name).toContain('Name and connect');
    expect(name).toContain('Leaderboard name');
    expect(name).toContain('QWTR-BKXM');
  });
  it.each([['choosing a name', null], ['connecting as a member', saved]] as const)('says what connecting publishes, as a notice and not a checkbox, while %s', (_, publication) => {
    const html = connect(publication);
    expect(html).toContain(CONNECT_NOTICE);
    expect(html).not.toMatch(choices);
  });
  it('keeps Connect disabled until the name is valid and the code is looked up', () => {
    expect(connect(null)).toMatch(/<button class="btn primary lg" disabled="">Connect<\/button>/);
  });
  it('asks a member who already has a name for nothing but the match', () => {
    const html = connect(saved);
    expect(html).toContain('Connect this computer');
    expect(html).not.toContain('Leaderboard name');
  });
  it('fills in the suggested name only until the member types', () => {
    expect(prefill({ alias: '', typed: false }, 'example-builder')).toEqual({ alias: 'example-builder', typed: false });
    expect(prefill({ alias: 'mine', typed: true }, 'example-builder')).toEqual({ alias: 'mine', typed: true });
    expect(prefill({ alias: '', typed: true }, 'example-builder')).toEqual({ alias: '', typed: true });
    expect(prefill({ alias: '', typed: false }, null)).toEqual({ alias: '', typed: false });
  });
  it('saves the name with server defaults, then approves the computer', async () => {
    const calls: string[] = [];
    const client = {
      publication: async (value: unknown) => { calls.push(`publication ${JSON.stringify(value)}`); return { publication: { ...saved, alias: 'example-builder' } }; },
      approveDevice: async (code: string) => { calls.push(`approve ${code}`); },
    };
    expect(await connectComputer(client, 'QWTR-BKXM', null, 'EXAMPLE-BUILDER')).toBe('example-builder');
    expect(calls).toEqual(['publication {"alias":"EXAMPLE-BUILDER"}', 'approve QWTR-BKXM']);
    calls.length = 0;
    expect(await connectComputer(client, 'QWTR-BKXM', 'builder', '')).toBe('builder');
    expect(calls).toEqual(['approve QWTR-BKXM']);
  });
  it('approves nothing when the name is taken, so the code still works', async () => {
    const approved: string[] = [];
    const client = {
      publication: async () => { throw new ApiError(409, 'CONFLICT', 'Alias or active publishing device is already in use'); },
      approveDevice: async (code: string) => { approved.push(code); },
    };
    await expect(connectComputer(client, 'QWTR-BKXM', null, 'builder')).rejects.toThrow('Alias or active publishing device is already in use');
    expect(approved).toEqual([]);
  });
});

describe('account page', () => {
  const account = (publication: Publication | null) => renderToStaticMarkup(<HostedAccount api={api} auth={{ providers: [] } as unknown as AuthAdapter} authState="signed_in" account={{ publication, devices: [] }}
    accountLoading={false} accountError={null} refreshAccount={async () => {}} refreshAuth={async () => {}} deleteAccount={async () => {}} onViewBoard={() => {}} onProfile={() => {}} />);
  it('has a listing, computer, sign-in, badge and danger zone, and no sharing section', () => {
    vi.stubGlobal('window', { location: { origin: 'https://tokentracky.test' } });
    try {
      const html = account(saved);
      for (const section of ['Your listing', 'Computers', 'Sign-in', 'README badge', 'Danger zone', 'Delete Tokentracky data']) expect(html).toContain(section);
      expect(html).toContain('href="#danger"');
      expect(html).not.toMatch(/Leave the leaderboard|Count my tokens|Show my|>Sharing</);
      expect(html).not.toMatch(choices);
    } finally { vi.unstubAllGlobals(); }
  });
  it('onboards a member without a name: step 1 of 3, no settings, deletion still reachable', () => {
    const html = account(null);
    expect(html).toContain('Step 1 of 3');
    expect(html).toContain('Pick your leaderboard name');
    expect(html).toContain('Delete Tokentracky data');
    expect(html).not.toMatch(/Your listing|README badge|Account sections/);
  });
  it('builds the badge address for each metric and window, adding nothing for the defaults', () => {
    expect(badgeUrl('https://tokentracky.test', 'builder', 'tokens', 'all')).toBe('https://tokentracky.test/badge/builder.svg');
    expect(badgeUrl('https://tokentracky.test', 'builder', 'rank', 'week')).toBe('https://tokentracky.test/badge/builder.svg?metric=rank&period=week');
    expect(badgeUrl('https://tokentracky.test', 'builder', 'tokens', 'month')).toBe('https://tokentracky.test/badge/builder.svg?period=month');
    expect(cardUrl('https://tokentracky.test', 'builder', 'dark', 'all')).toBe('https://tokentracky.test/card/builder.svg');
    expect(cardUrl('https://tokentracky.test', 'builder', 'light', 'week')).toBe('https://tokentracky.test/card/builder.svg?theme=light&period=week');
  });
});

describe('sign-in methods', () => {
  const signIn = (providers: AuthAdapter['providers']) => renderToStaticMarkup(<SignIn auth={{ providers } as AuthAdapter} />);
  it('offers only the providers enabled in Supabase Auth', () => {
    const email = signIn(['email']);
    expect(email).toContain('type="password"');
    expect(email).toContain('Sign in with email');
    expect(email).toContain('Create an account');
    expect(email).not.toMatch(/GitHub|Google|>or</);
    const all = signIn(['github', 'google', 'email']);
    expect(all).toContain('Continue with GitHub');
    expect(all).toContain('Continue with Google');
    expect(all).toContain('>or<');
    const oauthOnly = signIn(['google']);
    expect(oauthOnly).toContain('Continue with Google');
    expect(oauthOnly).not.toMatch(/GitHub|type="password"|>or</);
    expect(signIn([])).toContain('Sign-in is not set up');
  });
  it('opens on Create account when joining', () => {
    const html = renderToStaticMarkup(<SignIn auth={{ providers: ['email'] } as AuthAdapter} signUp />);
    expect(html).toContain('Create account');
    expect(html).toContain('Already have an account?');
    expect(html).not.toContain('Sign in with email');
  });
});

describe('moderation notice', () => {
  it('names the days under review and says local data is untouched, without reasons', () => {
    const html = renderToStaticMarkup(<ModerationNotice moderation={{ state: 'hidden', days: ['2026-10-22', '2026-10-23', 'unknown'] }} />);
    expect(html).toContain('hidden from public pages while we review unusual totals for Oct 22, Oct 23 and undated usage.');
    expect(html).toContain('Your local data is not affected.');
    expect(html).toContain('href="/support"');
  });
  it('tells a banned member they can no longer publish', () => {
    const html = renderToStaticMarkup(<ModerationNotice moderation={{ state: 'banned' }} />);
    expect(html).toContain('This account can no longer publish to the leaderboard.');
    expect(html).toContain('role="alert"');
  });
});
