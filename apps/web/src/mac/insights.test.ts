import { describe, expect, it } from 'vitest';
import type { SessionSummary, UsageBreakdownRow } from '@tokentracky/core';
import { addDays } from '../ranges';
import { biggestSession, busiestWeekdayUtc, changeVsPrevious, dailyByModel, dailyByTool, favouriteModel, mostExpensiveDay, trendingModel } from './insights';

const row = (day: string, tool: UsageBreakdownRow['tool'], model: string, tokens: number, costMicrousd: number | null = tokens): UsageBreakdownRow => ({ day, tool, model, tokens, breakdown: NONE.breakdown, costMicrousd });
const NONE = { breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costParts: null };
const DAYS = ['2026-10-23', '2026-10-24', '2026-10-25'];

describe('dailyByTool', () => {
  it('aligns one series per tool to the days, largest first, with quiet days as zero', () => {
    const rows = [row('2026-10-23', 'codex', 'gpt', 5), row('2026-10-25', 'claude', 'opus', 7), row('2026-10-25', 'claude', 'sonnet', 3), row('2026-10-24', 'codex', 'gpt', 1, null)];
    expect(dailyByTool(rows, DAYS)).toEqual([
      { key: 'claude', tokens: [0, 0, 10], cost: [0, 0, 10] },
      { key: 'codex', tokens: [5, 1, 0], cost: [5, 0, 0] },
    ]);
  });
  it('ignores rows outside the days and is empty without rows', () => {
    expect(dailyByTool([row('2026-10-01', 'claude', 'opus', 9)], DAYS)).toEqual([]);
    expect(dailyByTool([], DAYS)).toEqual([]);
  });
});

describe('dailyByModel', () => {
  it('keeps the top models and folds the rest into one Other series', () => {
    const rows = ['a', 'b', 'c'].map((model, index) => row('2026-10-24', 'claude', model, 30 - index * 10)).concat(row('2026-10-25', 'codex', 'd', 4), row('2026-10-25', 'codex', 'c', 1));
    expect(dailyByModel(rows, DAYS, 2)).toEqual([
      { key: 'a', tokens: [0, 30, 0], cost: [0, 30, 0] },
      { key: 'b', tokens: [0, 20, 0], cost: [0, 20, 0] },
      { key: 'other', other: true, tokens: [0, 10, 5], cost: [0, 10, 5] },
    ]);
  });
  it('has no Other series when every model fits', () => {
    expect(dailyByModel([row('2026-10-25', 'claude', 'opus', 3)], DAYS).map((series) => series.key)).toEqual(['opus']);
  });
});

describe('favouriteModel', () => {
  it('picks the largest model with its share', () => {
    expect(favouriteModel([{ model: 'a', tokens: 25, costMicrousd: 1, ...NONE }, { model: 'b', tokens: 75, costMicrousd: null, ...NONE }])).toEqual({ model: 'b', tokens: 75, share: 0.75 });
  });
  it('is null without usage', () => {
    expect(favouriteModel([])).toBeNull();
    expect(favouriteModel([{ model: 'a', tokens: 0, costMicrousd: 0, ...NONE }])).toBeNull();
  });
});

describe('mostExpensiveDay', () => {
  it('picks the day with the largest known cost', () => {
    const daily = [{ day: '2026-10-23', tokens: 900, costMicrousd: null, ...NONE }, { day: '2026-10-24', tokens: 10, costMicrousd: 50, ...NONE }, { day: '2026-10-25', tokens: 20, costMicrousd: 40, ...NONE }];
    expect(mostExpensiveDay(daily)).toEqual({ day: '2026-10-24', tokens: 10, costMicrousd: 50, ...NONE });
  });
  it('is null when no day has a known cost', () => {
    expect(mostExpensiveDay([{ day: '2026-10-23', tokens: 9, costMicrousd: null, ...NONE }, { day: '2026-10-24', tokens: 0, costMicrousd: 0, ...NONE }])).toBeNull();
  });
});

describe('biggestSession', () => {
  const session = (id: string, tokens: number): SessionSummary => ({ id, project: null, tool: 'claude', model: 'opus', models: ['opus'], tokens, breakdown: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, costMicrousd: null, lastUsedAt: null });
  it('picks the session with the most tokens, or null', () => {
    expect(biggestSession([session('a', 5), session('b', 9), session('c', 2)])?.id).toBe('b');
    expect(biggestSession([])).toBeNull();
  });
});

describe('trendingModel', () => {
  const models = (entries: Record<string, number>) => Object.entries(entries).map(([model, tokens]) => ({ model, tokens, costMicrousd: null, ...NONE }));
  it('picks the largest gain in share points', () => {
    // a: 50% → 40%, b: 30% → 35%, c: 20% → 25% (ties on gain go to the larger share).
    expect(trendingModel(models({ a: 40, b: 35, c: 25 }), models({ a: 50, b: 30, c: 20 }))).toEqual({ model: 'b', share: 0.35, previousShare: 0.3, gain: 5 });
  });
  it('counts a model new this period as gaining from zero', () => {
    expect(trendingModel(models({ a: 50, new: 50 }), models({ a: 10 }))).toMatchObject({ model: 'new', previousShare: 0, gain: 50 });
  });
  it('is null when nothing gains or there is nothing to compare with', () => {
    expect(trendingModel(models({ a: 10 }), models({ a: 3 }))).toBeNull();
    expect(trendingModel(models({ a: 10 }), [])).toBeNull();
    expect(trendingModel([], models({ a: 3 }))).toBeNull();
  });
});

describe('busiestWeekdayUtc', () => {
  it('averages each UTC weekday and compares the busiest with a typical day', () => {
    // 2026-10-19 is a Monday; two weeks, with Tuesdays the busiest.
    const days = Array.from({ length: 14 }, (_, index) => ({ day: addDays('2026-10-19', index), tokens: index % 7 === 1 ? 40 : 10 }));
    days[8] = { ...days[8]!, tokens: 20 };
    const busiest = busiestWeekdayUtc(days)!;
    expect(busiest.weekday).toBe(1);
    expect(busiest.averages).toEqual([10, 30, 10, 10, 10, 10, 10]);
    expect(busiest.ratio).toBeCloseTo(30 / (180 / 14));
  });
  it('is null without usage', () => {
    expect(busiestWeekdayUtc([])).toBeNull();
    expect(busiestWeekdayUtc([{ day: '2026-10-19', tokens: 0 }])).toBeNull();
  });
});

describe('changeVsPrevious', () => {
  it('is the percent change, or null when the previous period is empty', () => {
    expect(changeVsPrevious(138, 100)).toBeCloseTo(38);
    expect(changeVsPrevious(50, 100)).toBe(-50);
    expect(changeVsPrevious(5, 0)).toBeNull();
    expect(changeVsPrevious(0, 0)).toBeNull();
  });
});
