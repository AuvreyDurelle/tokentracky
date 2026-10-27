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
});
