const KEY = 'tokentracky.connect';
const LIFETIME_MS = 10 * 60_000;
const CODE = /^([BCDFGHJKLMNPQRSTVWXZ]{4})-?([BCDFGHJKLMNPQRSTVWXZ]{4})$/;

export function normalizeConnectCode(value: unknown): string | null {
  const match = typeof value === 'string' ? CODE.exec(value.trim().toUpperCase()) : null;
  return match ? `${match[1]}-${match[2]}` : null;
}

/**
 * The app opens `/?connect=CODE`. Keep the code across a sign-in redirect (which may return in
 * another tab) for as long as the hosted request can live, and remove it from the address bar.
 */
export function takeConnectCode(location: Pick<Location, 'href'>, history: Pick<History, 'replaceState'>, storage: Storage | null, now = Date.now()): string | null {
  const url = new URL(location.href);
  const fromUrl = normalizeConnectCode(url.searchParams.get('connect'));
  if (fromUrl) {
    url.searchParams.delete('connect');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    try { storage?.setItem(KEY, JSON.stringify({ code: fromUrl, savedAt: now })); } catch { /* Storage can be disabled; the code still works in this tab. */ }
    return fromUrl;
  }
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null') as { code?: unknown; savedAt?: unknown } | null;
    if (saved && typeof saved.savedAt === 'number' && now - saved.savedAt < LIFETIME_MS) return normalizeConnectCode(saved.code);
  } catch { /* Unreadable or disabled storage means there is no pending code. */ }
  return null;
}

export function forgetConnectCode(storage: Storage | null) {
  try { storage?.removeItem(KEY); } catch { /* Nothing to forget. */ }
}
