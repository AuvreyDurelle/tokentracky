import { useEffect, useState } from 'react';
import { ALIAS_PATTERN } from '@tokentracky/core';

/** Shareable addresses. `/` and `/leaderboard` both show the leaderboard; `/join` explains how to get on it. */
export type Route = { page: 'home' } | { page: 'leaderboard' } | { page: 'join' } | { page: 'you' } | { page: (typeof MAC_PAGES)[number] } | { page: 'profile'; alias: string } | { page: 'wrapped'; alias: string; period: string } | { page: 'vs'; a: string; b: string }
  | { page: 'town' } | { page: 'town-map' } | { page: 'town-visit'; alias: string } | { page: 'missing' };

/** The Mac app's own pages. Only the local app serves them; the website shows its missing page instead. */
const MAC_PAGES = ['tokens', 'achievements', 'settings', 'popover'] as const;

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { page: 'home' };
  if (path === '/leaderboard') return { page: 'leaderboard' };
  if (path === '/join') return { page: 'join' };
  if (path === '/you') return { page: 'you' };
  if (path === '/town') return { page: 'town' };
  if (path === '/town/map') return { page: 'town-map' };
  const town = /^\/u\/([^/]+)\/town$/.exec(path);
  if (town) return ALIAS_PATTERN.test(town[1]!) ? { page: 'town-visit', alias: town[1]!.toLowerCase() } : { page: 'missing' };
  const mac = MAC_PAGES.find((name) => path === `/${name}`);
  if (mac) return { page: mac };
  const profile = /^\/u\/([^/]+)$/.exec(path);
  if (profile && ALIAS_PATTERN.test(profile[1]!)) return { page: 'profile', alias: profile[1]!.toLowerCase() };
  // A month (`YYYY-MM`) or year (`YYYY`) wrap; the website only.
  const wrapped = /^\/wrapped\/([^/]+)\/(\d{4}(?:-(?:0[1-9]|1[0-2]))?)$/.exec(path);
  if (wrapped && ALIAS_PATTERN.test(wrapped[1]!)) return { page: 'wrapped', alias: wrapped[1]!.toLowerCase(), period: wrapped[2]! };
  // Two builders head to head; the website only.
  const vs = /^\/vs\/([^/]+)\/([^/]+)$/.exec(path);
  if (vs && ALIAS_PATTERN.test(vs[1]!) && ALIAS_PATTERN.test(vs[2]!)) return { page: 'vs', a: vs[1]!.toLowerCase(), b: vs[2]!.toLowerCase() };
  return { page: 'missing' };
}

export function routePath(route: Route): string {
  if (route.page === 'town-map') return '/town/map';
  if (route.page === 'town-visit') return `/u/${route.alias}/town`;
  return route.page === 'home' || route.page === 'missing' ? '/' : route.page === 'profile' ? `/u/${route.alias}` : route.page === 'wrapped' ? `/wrapped/${route.alias}/${route.period}` : route.page === 'vs' ? `/vs/${route.a}/${route.b}` : `/${route.page}`;
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
