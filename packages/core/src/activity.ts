import type { ActivityStats } from './generated/index.ts';

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;

/** Streaks, best day and averages from daily totals (`YYYY-MM-DD` UTC days, any order). */
export function activityStats(daily: ReadonlyArray<{day: string; tokens: number}>, today: string): ActivityStats {
  const totals = new Map<string, number>();
  for (const {day, tokens} of daily) if (tokens > 0) totals.set(day, (totals.get(day) ?? 0) + tokens);
  const days = [...totals.keys()].sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  let bestDay: ActivityStats['bestDay'] = null;
  let sum = 0;
  for (const day of days) {
    const number = dayNumber(day);
    run = previous !== null && number - previous === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = number;
    const tokens = totals.get(day)!;
    sum += tokens;
    if (!bestDay || tokens > bestDay.tokens) bestDay = {day, tokens};
  }
  let current = 0;
  const end = dayNumber(today);
  const active = new Set(days.map(dayNumber));
  for (let cursor = active.has(end) ? end : end - 1; active.has(cursor); cursor--) current++;
  return {activeDays: days.length, currentStreak: current, longestStreak: longest, bestDay, averagePerActiveDay: days.length ? Math.round(sum / days.length) : 0};
}
