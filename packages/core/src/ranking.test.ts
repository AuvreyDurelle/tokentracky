import { describe, expect, it } from 'vitest';
import { checkedSum, isUtcDay, rankingWindow, totalTokens } from './index.ts';

describe('accounting and public UTC windows', () => {
  it('counts reasoning exactly once and includes disjoint cache counters', () => {
    expect(totalTokens({input: 100, output: 60, cacheRead: 40, cacheWrite: 20, reasoning: 50})).toBe(220);
  });
  it('uses the prior Monday across year/month boundaries, independent of local timezone', () => {
    expect(rankingWindow('week', new Date('2026-01-01T00:01:00Z'))).toBe('2025-12-29T00:00:00.000Z');
    expect(rankingWindow('week', new Date('2026-01-04T23:59:59Z'))).toBe('2025-12-29T00:00:00.000Z');
    expect(rankingWindow('week', new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05T00:00:00.000Z');
    expect(rankingWindow('month', new Date('2026-01-01T00:01:00Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(rankingWindow('all')).toBeNull();
  });
  it('rejects rollover dates and unsafe aggregate totals', () => {
    expect(isUtcDay('2026-02-29')).toBe(false);
    expect(isUtcDay('2024-02-29')).toBe(true);
    expect(isUtcDay('2026-02-01T00:00:00Z')).toBe(false);
    expect(() => checkedSum([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
    expect(() => checkedSum([1, -1])).toThrow(RangeError);
  });
});
