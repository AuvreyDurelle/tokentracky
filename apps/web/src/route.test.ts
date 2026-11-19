import { describe, expect, it } from 'vitest';
import { isMacPage, parseRoute, routePath } from './route';

describe('routes', () => {
  it.each(['tokens', 'achievements', 'settings', 'popover'] as const)('parses /%s', (page) => {
    expect(parseRoute(`/${page}`)).toEqual({ page });
    expect(routePath({ page })).toBe(`/${page}`);
  });
  it('marks only the Mac pages as local-only', () => {
    expect(['tokens', 'achievements', 'settings', 'popover'].every((page) => isMacPage(parseRoute(`/${page}`).page))).toBe(true);
    expect(['/', '/leaderboard', '/join', '/you', '/u/someone'].some((path) => isMacPage(parseRoute(path).page))).toBe(false);
  });
  it('keeps /you, which the runtime harness opens', () => expect(parseRoute('/you')).toEqual({ page: 'you' }));
  it('gives the town, its map and a visited town their own addresses, all local to the app', () => {
    expect(parseRoute('/town')).toEqual({ page: 'town' });
    expect(parseRoute('/town/map/')).toEqual({ page: 'town-map' });
    expect(parseRoute('/u/Cache-Money/town')).toEqual({ page: 'town-visit', alias: 'cache-money' });
    expect(parseRoute('/u/x/town')).toEqual({ page: 'missing' });
    expect(routePath({ page: 'town-map' })).toBe('/town/map');
    expect(routePath({ page: 'town-visit', alias: 'cache-money' })).toBe('/u/cache-money/town');
    expect(['/town', '/town/map', '/u/someone/town'].every((path) => isMacPage(parseRoute(path).page))).toBe(true);
  });
});
