import { describe, expect, it } from 'vitest';
import { parseRoute, routePath } from './route';

describe('routes', () => {
  it.each(['tokens', 'achievements', 'settings', 'popover'] as const)('parses /%s', (page) => {
    expect(parseRoute(`/${page}`)).toEqual({ page });
    expect(routePath({ page })).toBe(`/${page}`);
  });
  it('keeps /you, which the runtime harness opens', () => expect(parseRoute('/you')).toEqual({ page: 'you' }));
});
