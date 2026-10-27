import {describe, expect, it} from 'vitest';
import {activityStats} from './activity.ts';

const days = (...entries: Array<[string, number]>) => entries.map(([day, tokens]) => ({day, tokens}));
describe('activity stats', () => {
  it('counts streaks across month boundaries and ignores empty days', () => {
    const stats = activityStats(days(['2026-09-29', 5], ['2026-09-30', 7], ['2026-10-01', 1], ['2026-10-03', 0], ['2026-10-04', 100], ['2026-10-05', 2]), '2026-10-05');
    expect(stats).toEqual({activeDays: 5, currentStreak: 2, longestStreak: 3, bestDay: {day: '2026-10-04', tokens: 100}, averagePerActiveDay: 23});
  });
  it('keeps the current streak alive until today ends, then resets it', () => {
    const history = days(['2026-10-21', 1], ['2026-10-22', 1]);
    expect(activityStats(history, '2026-10-22').currentStreak).toBe(2);
    expect(activityStats(history, '2026-10-23').currentStreak).toBe(2);
    expect(activityStats(history, '2026-10-24').currentStreak).toBe(0);
  });
  it('merges duplicate days, picks the earliest of tied best days, and handles no activity', () => {
    expect(activityStats(days(['2026-10-02', 4], ['2026-10-01', 3], ['2026-10-01', 1]), '2026-10-02')).toMatchObject({activeDays: 2, longestStreak: 2, bestDay: {day: '2026-10-01', tokens: 4}});
    expect(activityStats([], '2026-10-02')).toEqual({activeDays: 0, currentStreak: 0, longestStreak: 0, bestDay: null, averagePerActiveDay: 0});
  });
});
