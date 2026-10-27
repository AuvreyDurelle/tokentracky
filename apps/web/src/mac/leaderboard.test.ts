import { describe, expect, it } from 'vitest';
import type { PublicProfile } from '@tokentracky/core';
import { MAIN_TOOLS, gapToNext, lastSeven, otherTokens, pagerItems } from './leaderboard';

const row = (alias: string, rank: number, tokens: number) => ({ alias, rank, tokens, previousRank: null, daily: [] }) as PublicProfile;

describe('leaderboard helpers', () => {
  it('names the four tools that get their own columns', () => {
    expect(MAIN_TOOLS).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });
  it('sums tools outside the main columns into Other', () => {
    expect(otherTokens({ claude: 5, codex: 4, gemini: 3, opencode: 2, cline: 1, kilo: 6 })).toBe(7);
    expect(otherTokens({ claude: 5 })).toBe(0);
    expect(otherTokens(undefined)).toBeNull();
  });
  it('measures the gap to the builder one rank up', () => {
    const rows = [row('a', 41, 19_700_000_000), row('me', 42, 18_400_000_000), row('b', 43, 1)];
    expect(gapToNext(rows, 'me')).toEqual({ ahead: rows[0], tokens: 1_300_000_000 });
    expect(gapToNext(rows.slice(1), 'me')).toBeNull();
    expect(gapToNext(rows, 'nobody')).toBeNull();
    expect(gapToNext([row('me', 1, 5)], 'me')).toBeNull();
  });
  it('keeps the last seven of the fourteen daily totals', () => {
    expect(lastSeven(Array.from({ length: 14 }, (_, i) => i))).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(lastSeven([1, 2])).toEqual([1, 2]);
  });
  it('lists pages with ellipses around the current one', () => {
    expect(pagerItems(1, 1)).toEqual([1]);
    expect(pagerItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pagerItems(1, 251)).toEqual([1, 2, 3, 4, '…', 251]);
    expect(pagerItems(100, 251)).toEqual([1, '…', 99, 100, 101, '…', 251]);
    expect(pagerItems(251, 251)).toEqual([1, '…', 248, 249, 250, 251]);
  });
});
