/** The GitHub login of a Supabase user, read from the identity GitHub wrote, never from user-editable metadata. */
export type GithubLogin = (subject: string) => Promise<string | null>;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const TIMEOUT_MS = 3000;
/** Null only when Supabase says the user has no GitHub identity; throws when it cannot answer, so the caller keeps what it has. */
export function supabaseGithubLogin(url: string, serviceRoleKey: string, fetchImpl: typeof fetch = fetch): GithubLogin {
  return async subject => {
    const response = await fetchImpl(`${url}/auth/v1/admin/users/${encodeURIComponent(subject)}`, {
      headers: {apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}`},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub login lookup failed with status ${response.status}`);
    const user = await response.json() as {identities?: Array<{provider?: string; identity_data?: {user_name?: unknown}}>};
    const login = user.identities?.find(identity => identity.provider === 'github')?.identity_data?.user_name;
    return typeof login === 'string' && LOGIN.test(login) ? login : null;
  };
}
