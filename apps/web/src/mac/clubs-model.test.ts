import { describe, expect, it } from 'vitest';
import { cumulative, edge, isHot, leadByDay, raceDomain, slugOf, timeLeft, weekProgress } from './clubs-model';

describe('cumulative', () => {
  it('adds each day to the days before it', () => {
    expect(cumulative([5, 0, 3, 2])).toEqual([5, 5, 8, 10]);
    expect(cumulative([])).toEqual([]);
  });
});

describe('leadByDay', () => {
  it('names the side ahead on running totals after each day, not on that day alone', () => {
    // b wins Tuesday on the day (6 to 2) but a still leads the week, 7 to 7 is level, then b goes ahead.
    expect(leadByDay([5, 2, 0, 1], [1, 6, 0, 5])).toEqual(['a', null, null, 'b']);
  });
});

describe('edge', () => {
  it('favours the bigger figure, or the smaller when lower wins', () => {
    expect(edge(10, 4)).toBe('a');
    expect(edge(4, 10)).toBe('b');
    expect(edge(2, 6, true)).toBe('a');
    expect(edge(6, 2, true)).toBe('b');
  });
  it('gives no edge when level or when either side has no figure', () => {
    expect(edge(3, 3)).toBeNull();
    expect(edge(null, 3)).toBeNull();
    expect(edge(3, undefined, true)).toBeNull();
  });
});

describe('timeLeft', () => {
  it('splits the time to the end into days, hours, minutes and seconds', () => {
    const now = Date.UTC(2026, 10, 19, 17, 47, 48);
    expect(timeLeft(Date.UTC(2026, 10, 23), now)).toEqual({ days: 3, hours: 6, minutes: 12, seconds: 12 });
  });
  it('stops at zero once the end has passed', () => {
    expect(timeLeft(1000, 5000)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  });
});

describe('weekProgress', () => {
  it('counts from Monday 00:00 UTC', () => {
    expect(weekProgress(new Date(Date.UTC(2026, 10, 16)))).toEqual({ done: 0, day: 0 });
    expect(weekProgress(new Date(Date.UTC(2026, 10, 19, 12)))).toEqual({ done: 3.5 / 7, day: 3 });
    expect(weekProgress(new Date(Date.UTC(2026, 10, 22, 23, 59))).day).toBe(6);
  });
});

describe('isHot', () => {
  it('needs three members and 60% of them active', () => {
    expect(isHot(6, 10)).toBe(true);
    expect(isHot(5, 10)).toBe(false);
    expect(isHot(2, 2)).toBe(false);
  });
});

describe('slugOf', () => {
  it('lowercases words and joins them with single hyphens', () => {
    expect(slugOf('Night Shift')).toBe('night-shift');
    expect(slugOf("  Rock & Roll's Café ")).toBe('rock-roll-s-cafe');
  });
});

describe('raceDomain', () => {
  it('starts at zero with room above when asked to', () => {
    expect(raceDomain([50, 100], true)).toEqual([0, 108]);
    expect(raceDomain([0, 0], true)).toEqual([0, 1]);
  });
  it('otherwise hugs the values, so close rates still part', () => {
    const [low, high] = raceDomain([8690, 9190], false);
    expect(low).toBeCloseTo(8615);
    expect(high).toBeCloseTo(9265);
  });
  it('opens a flat line and an empty chart', () => {
    expect(raceDomain([7, 7], false)).toEqual([6.65, 7.35]);
    expect(raceDomain([], false)).toEqual([0, 1]);
  });
});
