import {describe, expect, it} from 'vitest';
import {BADGE_IDS, BADGE_TIERS, badgeInputs, badgeProgress} from './index.ts';

const days = (...entries: Array<[string, number]>) => entries.map(([day, tokens]) => ({day, tokens}));
describe('badge tiers', () => {
  it('uses the F7 thresholds in display order', () => {
    expect(BADGE_IDS).toEqual(['token-titan', 'big-day', 'marathoner', 'streak', 'weekend-warrior', 'momentum', 'veteran', 'podium', 'multitool', 'polyglot', 'trendsetter']);
    expect(BADGE_TIERS).toEqual({
      'token-titan': [100e6, 1e9, 10e9, 100e9], 'big-day': [10e6, 100e6, 500e6, 3e9], marathoner: [7, 30, 100, 365], streak: [3, 7, 30, 100],
      'weekend-warrior': [5, 20, 50, 100], momentum: [200, 600, 1500, 4000], veteran: [30, 90, 180, 365], podium: [100, 30, 10, 3],
      multitool: [2, 4, 6, 10], polyglot: [5, 15, 30, 60], trendsetter: [2, 5, 10, 20],
    });
  });
  for (const id of BADGE_IDS) {
    it(`${id} reaches each tier exactly at its threshold`, () => {
      const tiers = BADGE_TIERS[id];
      tiers.forEach((threshold, index) => {
        const short = id === 'podium' ? threshold + 1 : threshold - 1;
        expect(badgeProgress(id, short)).toEqual({id, tier: index, value: short, next: threshold});
        expect(badgeProgress(id, threshold)).toEqual({id, tier: index + 1, value: threshold, next: tiers[index + 1] ?? null});
      });
      const beyond = id === 'podium' ? 1 : Number.MAX_SAFE_INTEGER;
      expect(badgeProgress(id, beyond)).toEqual({id, tier: 4, value: beyond, next: null});
      expect(badgeProgress(id, 0)).toEqual({id, tier: 0, value: 0, next: tiers[0]});
    });
  }
});

describe('badge inputs', () => {
  it('counts the best day, active days and the longest streak broken by a gap', () => {
    const inputs = badgeInputs(days(['2026-10-01', 5], ['2026-10-02', 7], ['2026-10-03', 1], ['2026-10-04', 0], ['2026-10-05', 100], ['2026-10-06', 2], ['2026-10-06', 3]), '2026-10-06');
    expect(inputs).toMatchObject({bestDay: 100, activeDays: 5, longestStreak: 3});
  });
  it('counts active UTC Saturdays and Sundays only', () => {
    // 17 Saturday, 18 Sunday, 19 Monday, 23 Friday, 24 Saturday (empty), 25 Sunday.
    expect(badgeInputs(days(['2026-10-17', 1], ['2026-10-18', 1], ['2026-10-19', 1], ['2026-10-23', 1], ['2026-10-24', 0], ['2026-10-25', 1]), '2026-10-25').weekendDays).toBe(3);
  });
  it('measures the best week-over-week growth in hundredths, from Monday-start weeks whose prior week has 10M', () => {
    // A 10x jump from a 9M week is ignored; then 90M → 300M is 3.33x.
    const weeks = days(['2026-10-05', 9e6], ['2026-10-12', 90e6], ['2026-10-19', 300e6]);
    expect(badgeInputs(weeks, '2026-10-25').momentum).toBe(333);
    // Sunday and the next Monday fall in different weeks.
    expect(badgeInputs(days(['2026-10-18', 10e6], ['2026-10-19', 25e6]), '2026-10-25').momentum).toBe(250);
    // Growth needs consecutive weeks: an empty week in between breaks it.
    expect(badgeInputs(days(['2026-10-05', 50e6], ['2026-10-19', 500e6]), '2026-10-25').momentum).toBe(0);
  });
  it('counts veteran days from the first active day, and nothing without activity', () => {
    expect(badgeInputs(days(['2026-09-20', 0], ['2026-09-23', 1], ['2026-10-20', 4]), '2026-10-23').veteran).toBe(30);
    // A first upload whose day is ahead of the server's clock (skew around UTC midnight) is not negative.
    expect(badgeInputs(days(['2026-10-24', 5]), '2026-10-23').veteran).toBe(0);
    expect(badgeInputs([], '2026-10-23')).toEqual({bestDay: 0, activeDays: 0, longestStreak: 0, weekendDays: 0, momentum: 0, veteran: 0});
  });
});
