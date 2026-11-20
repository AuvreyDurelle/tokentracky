import { describe, expect, it } from 'vitest';
import type { PublicProfile } from '@tokentracky/core';
import { MAIN_TOOLS, daysToPass, gapToNext, lastSeven, otherTokens, pagerItems, rankMove, resetText, windowStartOf } from './leaderboard';

const row = (alias: string, rank: number, tokens: number) => ({ alias, rank, tokens, previousRank: null, daily: [] }) as PublicProfile;

describe('leaderboard helpers', () => {
  it('names the four tools that get their own columns', () => {
    expect(MAIN_TOOLS).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });
  it('sums tools outside the main columns into Other', () => {
    expect(otherTokens({ claude: 5, codex: 4, gemini: 3, opencode: 2, cline: 1, kilo: 6 })).toBe(7);
    expect(otherTokens({ claude: 5 })).toBe(0);
    expect(otherTokens(undefined)).toBeNull();
    expect(otherTokens({ claude: 50, codex: 30, cline: 15, roo: 5 }, ['claude', 'codex'])).toBe(20);
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
  it('says when the window moves on: the next whole hour, Monday 00:00 UTC or the 1st', () => {
    expect(resetText('24h', '2026-10-22T12:00:00.000Z', Date.parse('2026-10-23T12:28:00Z'))).toEqual({ window: 'Last 24 hours', verb: 'updates', left: '32m' });
    expect(resetText('week', '2026-10-19T00:00:00.000Z', Date.parse('2026-10-24T20:00:00Z'))).toMatchObject({ verb: 'resets', left: '1d 4h' });
    expect(resetText('month', '2026-10-01T00:00:00.000Z', Date.parse('2026-10-31T21:30:00Z'))).toMatchObject({ verb: 'resets', left: '2h 30m' });
    expect(resetText('all', null)).toBeNull();
  });
  it('starts each window where the board starts it', () => {
    const now = Date.parse('2026-11-19T14:35:00Z');
    expect(windowStartOf('24h', now)).toBe('2026-11-18T14:00:00.000Z');
    expect(windowStartOf('week', now)).toBe('2026-11-16T00:00:00.000Z');
    expect(windowStartOf('month', now)).toBe('2026-11-01T00:00:00.000Z');
    expect(windowStartOf('all', now)).toBeNull();
  });
  it('counts the days to pass the builder above at the last week’s pace, or none when they are as fast', () => {
    const week = (perDay: number) => [...Array(7).fill(0), ...Array(7).fill(perDay)];
    // 164 behind, gaining 90 a day: two days.
    expect(daysToPass(164, week(190), week(100))).toBe(2);
    // Exactly enough in one day still takes that day.
    expect(daysToPass(90, week(190), week(100))).toBe(1);
    expect(daysToPass(10, week(100), week(100))).toBeNull();
    expect(daysToPass(10, week(50), week(100))).toBeNull();
    // Only the last seven days count.
    expect(daysToPass(100, [...Array(7).fill(999), ...Array(7).fill(150)], week(100))).toBe(2);
  });
  it('reads the move since the end of yesterday from the previous rank', () => {
    expect(rankMove({ ...row('a', 38, 1), previousRank: 41 })).toEqual({ kind: 'up', by: 3 });
    expect(rankMove({ ...row('a', 9, 1), previousRank: 7 })).toEqual({ kind: 'down', by: 2 });
    expect(rankMove({ ...row('a', 5, 1), previousRank: 5 })).toEqual({ kind: 'same', by: 0 });
    expect(rankMove(row('a', 212, 1))).toEqual({ kind: 'new', by: 0 });
  });
});
