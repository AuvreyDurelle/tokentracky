import { describe, expect, it } from 'vitest';
import { byWeek, comparedWith, daySummary, usageSpan, historyStart } from './usage-span';

describe('usage spans', () => {
  it('starts a profile’s history at its first day with tokens, even before the account was made', () => {
    const daily = [{ day: '2026-10-21', tokens: 0 }, { day: '2026-10-22', tokens: 0 }, { day: '2026-10-23', tokens: 58 }, { day: '2026-11-19', tokens: 9 }];
    expect(historyStart({ daily, memberSince: '2026-11-19' })).toBe('2026-10-23');
    expect(historyStart({ daily: [{ day: '2026-11-20', tokens: 5 }], memberSince: '2026-11-19' })).toBe('2026-11-19');
    expect(historyStart({ daily: [], memberSince: '2026-11-19' })).toBe('2026-11-19');
    // The server's earliest published day reaches past the year the daily totals cover.
    expect(historyStart({ daily, memberSince: '2026-11-19', firstDay: '2025-03-02' })).toBe('2025-03-02');
  });
  // Thursday 19 November 2026.
  const today = '2026-11-19';
  it('shows the calendar week from Monday, stepping back a week at a time', () => {
    expect(usageSpan('week', 0, today, '2026-01-03')).toMatchObject({ from: '2026-11-16', to: '2026-11-19', title: 'This week', canBack: true, canForward: false });
    expect(usageSpan('week', 1, today, '2026-01-03')).toMatchObject({ from: '2026-11-09', to: '2026-11-15', canForward: true });
    // A week across two months.
    expect(usageSpan('week', 3, today, '2026-01-03')).toMatchObject({ from: '2026-10-26', to: '2026-11-01' });
    // No stepping back before the builder's first week.
    expect(usageSpan('week', 0, today, '2026-11-17').canBack).toBe(false);
  });
  it('shows the calendar month, up to today for this one', () => {
    expect(usageSpan('month', 0, today, '2026-01-03')).toMatchObject({ from: '2026-11-01', to: '2026-11-19', title: 'This month' });
    expect(usageSpan('month', 1, today, '2026-01-03')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(usageSpan('month', 11, today, '2026-01-03')).toMatchObject({ from: '2025-12-01', to: '2025-12-31', canBack: false });
  });
  it('shows everything since the builder joined for all time, without stepping', () => {
    expect(usageSpan('all', 0, today, '2026-01-03')).toMatchObject({ from: '2026-01-03', to: '2026-11-19', title: 'All time', canBack: false, canForward: false });
    // Without a start, the profile's year.
    expect(usageSpan('all', 0, today, null)).toMatchObject({ from: '2025-11-20', to: '2026-11-19' });
  });
  it('names what a span is compared with: the same number of days just before', () => {
    expect(comparedWith('2026-11-09', '2026-11-15')).toBe('the week before');
    expect(comparedWith('2026-11-01', '2026-11-19')).toBe('the 19 days before');
    expect(comparedWith('2026-11-19', '2026-11-19')).toBe('the day before');
  });
  it('finds the best day and the average active day', () => {
    expect(daySummary([{ day: 'a', tokens: 0 }, { day: 'b', tokens: 6 }, { day: 'c', tokens: 2 }])).toEqual({ best: { day: 'b', tokens: 6 }, average: 4, activeDays: 2 });
    expect(daySummary([{ day: 'a', tokens: 0 }])).toEqual({ best: null, average: 0, activeDays: 0 });
  });
  it('adds a long span up by week, each week from its first day', () => {
    const days = Array.from({ length: 10 }, (_, index) => ({ day: `2026-11-${String(index + 1).padStart(2, '0')}`, tokens: index + 1, costMicrousd: index === 3 ? null : 10 }));
    expect(byWeek(days)).toEqual([{ day: '2026-11-01', tokens: 28, costMicrousd: null, days: 7 }, { day: '2026-11-08', tokens: 27, costMicrousd: 30, days: 3 }]);
    expect(byWeek([{ day: '2026-11-01', tokens: 1 }])).toEqual([{ day: '2026-11-01', tokens: 1, days: 1 }]);
  });
});
