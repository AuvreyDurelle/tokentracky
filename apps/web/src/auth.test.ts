import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Health } from './api';

const { clientAuth, createClient } = vi.hoisted(() => {
  const clientAuth = { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn(), signInWithPassword: vi.fn(), signUp: vi.fn(), signInWithOAuth: vi.fn(), resetPasswordForEmail: vi.fn(), updateUser: vi.fn() };
  return { clientAuth, createClient: vi.fn(() => ({ auth: clientAuth })) };
});
vi.mock('@supabase/supabase-js', () => ({ createClient }));
import { AuthAdapter } from './auth';

const health: Health = { mode: 'hosted', authConfigured: true, version: 'test', cloudUrl: null, supabaseUrl: 'https://auth.example', supabaseAnonKey: 'public-test-key' };
beforeEach(() => vi.clearAllMocks());

describe('auth state and errors', () => {
  it('keeps unavailable auth distinct from signed-out auth', async () => {
    const auth = new AuthAdapter();
    expect(await auth.state()).toBe('unavailable');
    expect(await auth.accessToken()).toBeNull();
    auth.configure(health);
    clientAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await auth.state()).toBe('signed_out');
    expect(auth.providers).toEqual(['email']);
    auth.configure({ ...health, authProviders: ['google', 'email'] });
    expect(auth.providers).toEqual(['google', 'email']);
    auth.configure({ ...health, authConfigured: false, authProviders: ['google'] });
    expect(auth.providers).toEqual([]);
  });
  it('surfaces refresh errors instead of treating stale session data as valid', async () => {
    const auth = new AuthAdapter(); auth.configure(health);
    clientAuth.getSession.mockResolvedValue({ data: { session: { access_token: 'stale' } }, error: new Error('Refresh failed') });
    await expect(auth.state()).rejects.toThrow('Refresh failed');
    await expect(auth.accessToken()).rejects.toThrow('Refresh failed');
  });
  it('suggests the GitHub username as a name, and nothing for an email sign-in', async () => {
    const auth = new AuthAdapter();
    expect(await auth.suggestedAlias()).toBeNull();
    auth.configure(health);
    clientAuth.getSession.mockResolvedValue({ data: { session: { user: { user_metadata: { user_name: 'EXAMPLE-BUILDER', email: 'someone@example.com' } } } }, error: null });
    expect(await auth.suggestedAlias()).toBe('EXAMPLE-BUILDER');
    clientAuth.getSession.mockResolvedValue({ data: { session: { user: { user_metadata: { email: 'someone@example.com' } } } }, error: null });
    expect(await auth.suggestedAlias()).toBeNull();
  });
  it('returns a confirmed session token', async () => {
    const auth = new AuthAdapter(); auth.configure(health);
    clientAuth.getSession.mockResolvedValue({ data: { session: { access_token: 'synthetic-token' } }, error: null });
    expect(await auth.state()).toBe('signed_in');
    expect(await auth.accessToken()).toBe('synthetic-token');
  });
  it('reports signout failures to the caller', async () => {
    const auth = new AuthAdapter(); auth.configure(health);
    clientAuth.signOut.mockResolvedValue({ error: new Error('Offline signout failed') });
    await expect(auth.signOut()).rejects.toThrow('Offline signout failed');
    clientAuth.signOut.mockResolvedValue({ error: null });
    await expect(auth.signOut()).resolves.toBeUndefined();
  });
  it('subscribes to refresh and signout events and cleans up the listener', () => {
    const unsubscribe = vi.fn();
    clientAuth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
    const auth = new AuthAdapter(); auth.configure(health);
    const listener = vi.fn(); const stop = auth.subscribe(listener);
    const callback = clientAuth.onAuthStateChange.mock.calls[0][0];
    callback('TOKEN_REFRESHED', { access_token: 'refreshed', user: { id: 'user-1' } });
    callback('SIGNED_OUT', null);
    expect(listener.mock.calls).toEqual([['signed_in', 'user-1'], ['signed_out', null]]);
    stop(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('signs in and signs up with email and password, reporting when confirmation is pending', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://board.example' } });
    const auth = new AuthAdapter(); auth.configure(health);
    clientAuth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    await expect(auth.password('ada@example.com', 'correct horse', 'sign_in')).resolves.toBe(true);
    expect(clientAuth.signInWithPassword).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'correct horse' });
    clientAuth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    await expect(auth.password('ada@example.com', 'correct horse', 'sign_up')).resolves.toBe(false);
    expect(clientAuth.signUp).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'correct horse', options: { emailRedirectTo: 'https://board.example' } });
    clientAuth.signUp.mockResolvedValue({ data: { session: { access_token: 'new' } }, error: null });
    await expect(auth.password('ada@example.com', 'correct horse', 'sign_up')).resolves.toBe(true);
    clientAuth.signInWithPassword.mockResolvedValue({ data: {}, error: new Error('Invalid login credentials') });
    await expect(auth.password('ada@example.com', 'wrong', 'sign_in')).rejects.toThrow('Invalid login credentials');
    vi.unstubAllGlobals();
  });
  it('starts GitHub and Google sign-in and refuses every method without hosted auth', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://board.example' } });
    const auth = new AuthAdapter(); auth.configure(health);
    clientAuth.signInWithOAuth.mockResolvedValue({ error: null });
    await auth.google(); await auth.github();
    expect(clientAuth.signInWithOAuth.mock.calls.map(([options]) => options)).toEqual([
      { provider: 'google', options: { redirectTo: 'https://board.example' } }, { provider: 'github', options: { redirectTo: 'https://board.example' } }]);
    const unavailable = new AuthAdapter();
    await expect(unavailable.google()).rejects.toThrow('not configured');
    await expect(unavailable.password('a@b.c', 'x', 'sign_in')).rejects.toThrow('not configured');
    vi.unstubAllGlobals();
  });
  it('requests a recovery email with the configured site origin and surfaces delivery errors', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://board.example' } });
    const auth = new AuthAdapter(); auth.configure(health);
    clientAuth.resetPasswordForEmail.mockResolvedValue({ error: null });
    await auth.requestPasswordReset('ada@example.com');
    expect(clientAuth.resetPasswordForEmail).toHaveBeenCalledWith('ada@example.com', { redirectTo: 'https://board.example' });
    clientAuth.resetPasswordForEmail.mockResolvedValue({ error: new Error('Email delivery temporarily unavailable') });
    await expect(auth.requestPasswordReset('ada@example.com')).rejects.toThrow('Email delivery');
    await expect(new AuthAdapter().requestPasswordReset('ada@example.com')).rejects.toThrow('not configured');
    vi.unstubAllGlobals();
  });
  it('keeps recovery sessions out of account approval until the password has been changed', async () => {
    clientAuth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
    clientAuth.getSession.mockResolvedValue({ data: { session: { access_token: 'recovery-token' } }, error: null });
    const auth = new AuthAdapter(); auth.configure(health);
    const listener = vi.fn(); auth.subscribe(listener);
    const callback = clientAuth.onAuthStateChange.mock.calls[0][0];
    await expect(auth.updateRecoveredPassword('new-password')).rejects.toThrow('expired or is invalid');
    expect(clientAuth.updateUser).not.toHaveBeenCalled();
    callback('PASSWORD_RECOVERY', { access_token: 'recovery-token', user: { id: 'user-1' } });
    callback('TOKEN_REFRESHED', { access_token: 'refreshed-recovery-token', user: { id: 'user-1' } });
    expect(listener.mock.calls).toEqual([['recovery', 'user-1'], ['recovery', 'user-1']]);
    expect(await auth.state()).toBe('recovery');
    clientAuth.updateUser.mockResolvedValue({ error: new Error('Password policy rejected') });
    await expect(auth.updateRecoveredPassword('weak')).rejects.toThrow('Password policy');
    expect(await auth.state()).toBe('recovery');
    clientAuth.updateUser.mockResolvedValue({ error: null });
    await auth.updateRecoveredPassword('new-strong-password');
    expect(clientAuth.updateUser).toHaveBeenLastCalledWith({ password: 'new-strong-password' });
    expect(await auth.state()).toBe('signed_in');
    await expect(auth.updateRecoveredPassword('another-password')).rejects.toThrow('expired or is invalid');
  });
  it('rejects an expired recovery session and clears recovery on sign-out', async () => {
    clientAuth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
    const auth = new AuthAdapter(); auth.configure(health); auth.subscribe(vi.fn());
    const callback = clientAuth.onAuthStateChange.mock.calls[0][0];
    callback('PASSWORD_RECOVERY', { access_token: 'expired', user: { id: 'user-1' } });
    clientAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(auth.updateRecoveredPassword('new-password')).rejects.toThrow('expired or is invalid');
    expect(clientAuth.updateUser).not.toHaveBeenCalled();
    callback('SIGNED_OUT', null);
    clientAuth.getSession.mockResolvedValue({ data: { session: { access_token: 'ordinary-login' } }, error: null });
    expect(await auth.state()).toBe('signed_in');
  });
});
