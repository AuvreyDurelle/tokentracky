import { useEffect, useState } from 'react';
import { ALIAS_PATTERN } from '@tokentracky/core';

/** Shareable addresses. `/` and `/leaderboard` both show the leaderboard; `/join` explains how to get on it. */
export type Route = { page: 'home' } | { page: 'leaderboard' } | { page: 'join' } | { page: 'you' } | { page: (typeof MAC_PAGES)[number] } | { page: 'profile'; alias: string } | { page: 'missing' };

/** The Mac app's own pages. Only the local app serves them; the website shows its missing page instead. */
const MAC_PAGES = ['tokens', 'achievements', 'settings', 'popover'] as const;
/** True for a page only the local app has, which the website answers as missing. */
export const isMacPage = (page: Route['page']) => (MAC_PAGES as readonly string[]).includes(page);

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { page: 'home' };
  if (path === '/leaderboard') return { page: 'leaderboard' };
  if (path === '/join') return { page: 'join' };
  if (path === '/you') return { page: 'you' };
  const mac = MAC_PAGES.find((name) => path === `/${name}`);
  if (mac) return { page: mac };
  const profile = /^\/u\/([^/]+)$/.exec(path);
  if (profile && ALIAS_PATTERN.test(profile[1]!)) return { page: 'profile', alias: profile[1]!.toLowerCase() };
  return { page: 'missing' };
}

export function routePath(route: Route): string {
  return route.page === 'home' || route.page === 'missing' ? '/' : route.page === 'profile' ? `/u/${route.alias}` : `/${route.page}`;
}

/** The current route, kept in step with the address bar and Back/Forward. */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const navigate = (next: Route) => {
    const path = routePath(next);
    if (path !== window.location.pathname) window.history.pushState(null, '', path);
    setRoute(next);
    window.scrollTo(0, 0);
  };
  return [route, navigate];
}

export type LinkTag = 'share' | 'readme';
/** Shared links carry `?ref=share` and README links `?ref=readme`. Takes the tag off the address bar so a reload is not counted twice. */
export function takeLinkTag(location: Pick<Location, 'href'>, history: Pick<History, 'replaceState'>): LinkTag | null {
  const url = new URL(location.href);
  const tag = url.searchParams.get('ref');
  if (tag === null) return null;
  url.searchParams.delete('ref');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  return tag === 'share' || tag === 'readme' ? tag : null;
}
