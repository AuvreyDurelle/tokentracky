import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Health } from './api';
import { aliasFromHandle } from './publication';

export type AuthState = 'loading' | 'error' | 'unavailable' | 'signed_out' | 'signed_in' | 'recovery';
export type AuthProvider = 'email' | 'github' | 'google';
/** One way into the account, with the handle or address it uses. Never shown publicly. */
export interface SignInIdentity { provider: string; detail: string | null }

export class AuthAdapter {
  private client: SupabaseClient | null = null;
  private recovering = false;
  /** Sign-in methods enabled in the Supabase project; the sign-in form offers only these. */
  providers: AuthProvider[] = [];

  configure(health: Health) {
    // SECURITY: PKCE binds callbacks to this browser's verifier and rejects injected implicit sessions
    // (VULN-002). Do not remove.
    this.client = health.authConfigured && health.supabaseUrl && health.supabaseAnonKey
      ? createClient(health.supabaseUrl, health.supabaseAnonKey, { auth: { flowType: 'pkce' } })
      : null;
    this.providers = this.client ? health.authProviders ?? ['email'] : [];
  }

  get available() { return this.client !== null; }
  async state(): Promise<AuthState> {
    if (!this.client) return 'unavailable';
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    return data.session ? this.recovering ? 'recovery' : 'signed_in' : 'signed_out';
  }
  async accessToken(): Promise<string | null> {
    if (!this.client) return null;
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    return data.session?.access_token ?? null;
  }
  /** The sign-in handle (GitHub's username) as a leaderboard name, when the session has one. */
  async suggestedAlias(): Promise<string | null> {
    if (!this.client) return null;
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    const metadata = (data.session?.user.user_metadata ?? {}) as { user_name?: unknown; preferred_username?: unknown };
    return aliasFromHandle(metadata.user_name ?? metadata.preferred_username);
  }
  async identities(): Promise<SignInIdentity[]> {
    if (!this.client) return [];
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    return (data.session?.user.identities ?? []).map((identity) => {
      const info = (identity.identity_data ?? {}) as { user_name?: unknown; email?: unknown };
      return { provider: identity.provider, detail: typeof info.user_name === 'string' ? `@${info.user_name}` : typeof info.email === 'string' ? info.email : null };
    });
  }
  /** Every auth event with the session's user id. Supabase repeats the same session on load, tab focus and token refresh. */
  subscribe(listener: (state: AuthState, user: string | null) => void): () => void {
    if (!this.client) return () => {};
    const { data } = this.client.auth.onAuthStateChange((event, session) => {
      // Account reads run in a React effect outside the auth callback's lock.
      if (event === 'PASSWORD_RECOVERY') this.recovering = true;
      if (!session) this.recovering = false;
      listener(session ? this.recovering ? 'recovery' : 'signed_in' : 'signed_out', session?.user.id ?? null);
    });
    return () => data.subscription.unsubscribe();
  }
  /** Email and password. Returns false when the account was created but its email address still needs confirming. */
  async password(email: string, password: string, mode: 'sign_in' | 'sign_up'): Promise<boolean> {
    if (!this.client) throw new Error('Account sign-in is unavailable because hosted authentication is not configured.');
    if (mode === 'sign_in') {
      const { error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return true;
    }
    const { data, error } = await this.client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
    if (error) throw error;
    return data.session !== null;
  }
  async github() { await this.oauth('github'); }
  async google() { await this.oauth('google'); }
  async requestPasswordReset(email: string) {
    if (!this.client) throw new Error('Account sign-in is unavailable because hosted authentication is not configured.');
    const { error } = await this.client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    if (error) throw error;
  }
  async updateRecoveredPassword(password: string) {
    if (!this.client || !this.recovering || await this.state() !== 'recovery') {
      throw new Error('This password-reset link has expired or is invalid. Request a new link.');
    }
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw error;
    this.recovering = false;
  }
  private async oauth(provider: 'github' | 'google') {
    if (!this.client) throw new Error('Account sign-in is unavailable because hosted authentication is not configured.');
    const { error } = await this.client.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin } });
    if (error) throw error;
  }
  async signOut() {
    if (!this.client) return;
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
  }
}
