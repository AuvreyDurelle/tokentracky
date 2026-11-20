import { describe, expect, it } from 'vitest';
import type { SessionSummary, UsageBreakdownRow } from '@tokentracky/core';
import { bestWeek, cachePerDay, costPerMillion, kindSeries, modelMix, paceToday, projectSeries, sessionLengths, tokensSpan, weekdayHourStats, weekly } from './tokens-model';

const kinds = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite, reasoning: 0 });
const row = (day: string, model: string, tokens: number, breakdown = kinds(tokens, 0, 0, 0), cost: number | null = tokens): UsageBreakdownRow =>
  ({ day, tool: 'claude', model, tokens, breakdown, costMicrousd: cost }) as UsageBreakdownRow;

describe('the Tokens page’s spans', () => {
  // Thursday 19 November 2026.
  const today = '2026-11-19';
  it('steps through calendar weeks and months, shows all time from the first day used, and takes a custom range as given', () => {
    expect(tokensSpan('month', 0, today, '2026-01-03', null)).toMatchObject({ from: '2026-11-01', to: '2026-11-19', canBack: true, canForward: false });
    expect(tokensSpan('week', 2, today, '2026-01-03', null)).toMatchObject({ from: '2026-11-02', to: '2026-11-08', canForward: true });
    expect(tokensSpan('all', 0, today, '2026-01-03', null)).toMatchObject({ from: '2026-01-03', to: today });
    expect(tokensSpan('week', 0, today, '2026-01-03', { from: '2026-10-05', to: '2026-10-11' })).toMatchObject({ from: '2026-10-05', to: '2026-10-11', canBack: false, canForward: false });
  });
  it('names the span: the month’s days so far, a week, all time or a custom range', () => {
    expect(tokensSpan('month', 0, today, null, null).title).toBe('1–19 November 2026 · day 19 of 30');
    expect(tokensSpan('month', 1, today, null, null).title).toBe('October 2026');
    expect(tokensSpan('week', 0, today, null, null).title).toMatch(/^Week of .*16.* · day 4 of 7$/);
  });
});

describe('the chart’s series', () => {
  const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
  it('adds a long span up by week from its first day', () => {
    expect(weekly(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], [1, 1, 1, 1, 1, 1, 1, 5])).toEqual({ days: ['a', 'h'], values: [7, 5] });
  });
  it('splits by project, the five largest and the rest, from each project’s days', () => {
    const projects = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) => ({ name, tokens: 60 - index * 10, daily: [{ day: '2026-11-02', tokens: 60 - index * 10 }] }));
    const series = projectSeries(projects, days);
    expect(series.map((item) => item.label)).toEqual(['a', 'b', 'c', 'd', 'e', 'Other']);
    expect(series[0]!.values).toEqual([0, 60, 0]);
    expect(series.at(-1)!.values).toEqual([0, 10, 0]);
  });
  it('splits by token type from each day’s rows', () => {
    const series = kindSeries([row('2026-11-01', 'm', 10, kinds(1, 2, 3, 4)), row('2026-11-01', 'n', 10, kinds(1, 2, 3, 4)), row('2026-11-03', 'm', 5, kinds(5, 0, 0, 0))], days);
    expect(series.map((item) => [item.label, item.values])).toEqual([['Input', [2, 0, 5]], ['Output', [4, 0, 0]], ['Cache read', [6, 0, 0]], ['Cache write', [8, 0, 0]]]);
  });
});

describe('today, best and streaks', () => {
  it('projects today’s tokens to the end of the UTC day once a fifth of it has passed', () => {
    expect(paceToday(500, Date.parse('2026-11-19T12:00:00Z'))).toBe(1000);
    expect(paceToday(500, Date.parse('2026-11-19T03:00:00Z'))).toBeNull();
  });
  it('finds the best calendar week, Monday to Sunday', () => {
    // A rolling week from Sunday the 8th would hold 70; calendar weeks hold 40, 60 and 50.
    const daily = [{ day: '2026-11-08', tokens: 40 }, { day: '2026-11-09', tokens: 30 }, { day: '2026-11-15', tokens: 30 }, { day: '2026-11-16', tokens: 50 }];
    expect(bestWeek(daily)).toEqual({ from: '2026-11-09', tokens: 60 });
    expect(bestWeek([])).toBeNull();
  });
});

describe('when you work', () => {
  it('buckets sessions by length with each bucket’s share of tokens', () => {
    const session = (minutes: number, tokens: number) => ({ startedAt: '2026-11-19T10:00:00.000Z', lastUsedAt: new Date(Date.parse('2026-11-19T10:00:00Z') + minutes * 60_000).toISOString(), tokens }) as SessionSummary;
    const buckets = sessionLengths([session(2, 10), session(10, 10), session(90, 80)]);
    expect(buckets.map((bucket) => [bucket.label, bucket.sessions, bucket.tokens])).toEqual([['<5m', 1, 10], ['5–15m', 1, 10], ['15–30m', 0, 0], ['30m–1h', 0, 0], ['1–2h', 1, 80], ['2–3h', 0, 0], ['3h+', 0, 0]]);
  });
  it('reads the busiest weekday, hour and hour of the week from the grid, Monday first', () => {
    const grid = Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => (day === 1 && hour === 14 ? 50 : day === 5 ? 1 : 0)));
    expect(weekdayHourStats(grid)).toMatchObject({ busiestDay: 1, busiestHour: 14, peak: { day: 1, hour: 14, tokens: 50 }, total: 74, weekend: 24, days: [0, 50, 0, 0, 0, 24, 0] });
  });
});

describe('models, cost and cache by day', () => {
  const days = ['2026-11-01', '2026-11-02'];
  it('reads each day’s cache hit rate: cache reads over everything read in', () => {
    expect(cachePerDay([row('2026-11-01', 'm', 100, kinds(5, 10, 90, 5))], days)).toEqual([0.9, null]);
  });
  it('reads each day’s cost per million tokens, none on a quiet or unpriced day', () => {
    expect(costPerMillion([{ day: '2026-11-01', tokens: 2e6, costMicrousd: 0.84e6 }, { day: '2026-11-02', tokens: 1e6, costMicrousd: null }], days)).toEqual([0.42, null]);
  });
  it('shares each day out among the largest models, the rest together', () => {
    const mix = modelMix([row('2026-11-01', 'a', 75), row('2026-11-01', 'b', 25), row('2026-11-02', 'b', 10)], days, 1);
    expect(mix.map((item) => [item.label, item.values])).toEqual([['a', [0.75, 0]], ['Other', [0.25, 1]]]);
  });
});
