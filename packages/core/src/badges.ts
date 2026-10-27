import type { BadgeId, BadgeProgress } from './generated/index.ts';
import { activityStats } from './activity.ts';

/** F7 thresholds for bronze, silver, gold and diamond. Podium's are ranks, so lower is better. */
export const BADGE_TIERS: Record<BadgeId, [number, number, number, number]> = {
  'token-titan': [100e6, 1e9, 10e9, 100e9],
  'big-day': [10e6, 100e6, 500e6, 3e9],
  marathoner: [7, 30, 100, 365],
  streak: [3, 7, 30, 100],
  'weekend-warrior': [5, 20, 50, 100],
  // Week-over-week growth in hundredths: 2×, 6×, 15×, 40×.
  momentum: [200, 600, 1500, 4000],
  veteran: [30, 90, 180, 365],
  podium: [100, 30, 10, 3],
  multitool: [2, 4, 6, 10],
  polyglot: [5, 15, 30, 60],
  trendsetter: [2, 5, 10, 20],
};
/** Momentum counts a week only when the week before it has at least this many tokens. */
const MOMENTUM_FLOOR = 10e6;
const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;

export interface BadgeInputs {bestDay: number; activeDays: number; longestStreak: number; weekendDays: number; momentum: number; veteran: number}

/** The day-based badge measures from daily totals (`YYYY-MM-DD` UTC days, any order). Weeks start on Monday (UTC). */
export function badgeInputs(daily: ReadonlyArray<{day: string; tokens: number}>, today: string): BadgeInputs {
  const activity = activityStats(daily, today);
  let weekendDays = 0;
  let first = Infinity;
  const active = new Set<number>();
  const weeks = new Map<number, number>();
  // Plain sums are safe: ingest refuses an account whose total is not a safe integer, and every week is part of that total.
  for (const {day, tokens} of daily) {
    if (tokens <= 0) continue;
    const number = dayNumber(day);
    // Day 0 (1970-01-01) was a Thursday; `weekday` counts from Monday.
    const weekday = (number + 3) % 7;
    if (!active.has(number) && weekday >= 5) weekendDays++;
    active.add(number);
    first = Math.min(first, number);
    weeks.set(number - weekday, (weeks.get(number - weekday) ?? 0) + tokens);
  }
  let momentum = 0;
  for (const [monday, tokens] of weeks) {
    const prior = weeks.get(monday - 7) ?? 0;
    if (prior >= MOMENTUM_FLOOR) momentum = Math.max(momentum, Math.floor(tokens * 100 / prior));
  }
  return {bestDay: activity.bestDay?.tokens ?? 0, activeDays: activity.activeDays, longestStreak: activity.longestStreak, weekendDays, momentum,
    // Never negative: a first day ahead of `today` (clock skew around UTC midnight) counts as day 0.
    veteran: active.size ? Math.max(0, dayNumber(today) - first) : 0};
}

/** A badge's tier (0 none … 4 diamond) and the next tier's threshold. Podium's value is a rank, where 0 means never ranked. */
export function badgeProgress(id: BadgeId, value: number): BadgeProgress {
  const tiers = BADGE_TIERS[id];
  const tier = tiers.filter(threshold => id === 'podium' ? value > 0 && value <= threshold : value >= threshold).length;
  return {id, tier, value, next: tiers[tier] ?? null};
}
