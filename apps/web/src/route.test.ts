import { describe, expect, it } from 'vitest';
import { parseRoute, routePath } from './route';

describe('routes', () => {
  it.each(['tokens', 'achievements', 'settings', 'popover'] as const)('parses /%s', (page) => {
    expect(parseRoute(`/${page}`)).toEqual({ page });
    expect(routePath({ page })).toBe(`/${page}`);
  });
  it('keeps /you, which the runtime harness opens', () => expect(parseRoute('/you')).toEqual({ page: 'you' }));
  it('gives the town, its map and a visited town their own addresses, all local to the app', () => {
    expect(parseRoute('/town')).toEqual({ page: 'town' });
    expect(parseRoute('/town/map/')).toEqual({ page: 'town-map' });
    expect(parseRoute('/u/Cache-Money/town')).toEqual({ page: 'town-visit', alias: 'cache-money' });
    expect(parseRoute('/u/x/town')).toEqual({ page: 'missing' });
    expect(routePath({ page: 'town-map' })).toBe('/town/map');
    expect(routePath({ page: 'town-visit', alias: 'cache-money' })).toBe('/u/cache-money/town');
  });
  it('gives clubs and a club’s pages their own addresses in the app', () => {
    expect(parseRoute('/clubs')).toEqual({ page: 'clubs', tab: 'mine' });
    expect(parseRoute('/clubs/league')).toEqual({ page: 'clubs', tab: 'league' });
    expect(parseRoute('/clubs/new')).toEqual({ page: 'missing' });
    expect(parseRoute('/c/Night-Shift')).toEqual({ page: 'club', slug: 'night-shift', tab: 'board' });
    expect(parseRoute('/c/night-shift/members')).toEqual({ page: 'club', slug: 'night-shift', tab: 'members' });
    expect(parseRoute('/c/night-shift/settings')).toEqual({ page: 'missing' });
    for (const route of [{ page: 'clubs', tab: 'mine' }, { page: 'clubs', tab: 'matchups' }, { page: 'club', slug: 'night-shift', tab: 'board' }, { page: 'club', slug: 'night-shift', tab: 'challenge' }] as const) expect(parseRoute(routePath(route))).toEqual(route);
  });
});
