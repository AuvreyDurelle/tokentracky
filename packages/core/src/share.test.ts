import { describe, expect, it } from 'vitest';
import { adjacentWrap, wrapLabel, wrapRange } from './share.ts';

describe('wrap periods', () => {
  it('spans a whole past month or year, with the whole period before it', () => {
    expect(wrapRange('2026-10', '2026-11-19')).toEqual({from: '2026-10-01', to: '2026-10-31', previous: {from: '2026-09-01', to: '2026-09-30'}});
    expect(wrapRange('2025', '2026-11-19')).toEqual({from: '2025-01-01', to: '2025-12-31', previous: {from: '2024-01-01', to: '2024-12-31'}});
    expect(wrapRange('2024-02', '2026-11-19')?.to).toBe('2024-02-29');
  });
  it('counts a period under way up to today, and crosses into the year before for January', () => {
    expect(wrapRange('2026-11', '2026-11-19')).toEqual({from: '2026-11-01', to: '2026-11-19', previous: {from: '2026-10-01', to: '2026-10-31'}});
    expect(wrapRange('2026', '2026-11-19')?.to).toBe('2026-11-19');
    expect(wrapRange('2027-01', '2027-01-01')).toEqual({from: '2027-01-01', to: '2027-01-01', previous: {from: '2026-12-01', to: '2026-12-31'}});
  });
  it('refuses malformed periods and ones that have not started', () => {
    for (const period of ['2026-13', '2026-1', '26', '2026-11-01', 'all', '2026-00', '']) expect(wrapRange(period, '2026-11-19'), period).toBeNull();
    expect(wrapRange('2026-12', '2026-11-19')).toBeNull();
    expect(wrapRange('2027', '2026-11-19')).toBeNull();
  });
  it('names periods and steps between them', () => {
    expect(wrapLabel('2026-11')).toBe('November 2026');
    expect(wrapLabel('2026')).toBe('2026');
    expect(adjacentWrap('2026-01', -1)).toBe('2025-12');
    expect(adjacentWrap('2026-12', 1)).toBe('2027-01');
    expect(adjacentWrap('2026', -1)).toBe('2025');
  });
});
