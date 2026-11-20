import { addDays } from './ranges';

export type UsagePeriod = '24h' | 'week' | 'month' | 'all';
export interface UsageSpan { from: string; to: string; title: string; canBack: boolean; canForward: boolean }

const DAY_MS = 86_400_000;
const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/**
 * The UTC days a profile's usage chart shows for a period, `back` steps before the current one: the calendar week from
 * Monday or the calendar month, up to `today`, or everything since `start` (the profile's year when unknown) for all
 * time, back at most the 3,660 days the server sends at once. Stepping stops at the builder's first week or month, and
 * at today.
 */
export function usageSpan(period: Exclude<UsagePeriod, '24h'>, back: number, today: string, start: string | null): UsageSpan {
  if (period === 'all') {
    const from = start ?? addDays(today, -364), earliest = addDays(today, -3659);
    return { from: from < earliest ? earliest : from, to: today, title: 'All time', canBack: false, canForward: false };
  }
  let from: string, end: string;
  if (period === 'week') {
    const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
    from = addDays(monday, -7 * back);
    end = addDays(from, 6);
  } else {
    const date = new Date(`${today}T00:00:00Z`);
    from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1)).toISOString().slice(0, 10);
    end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back + 1, 0)).toISOString().slice(0, 10);
  }
  return { from, to: end > today ? today : end, title: back === 0 ? (period === 'week' ? 'This week' : 'This month') : '', canBack: !start || from > start, canForward: back > 0 };
}

/**
 * Where a profile's history starts: its earliest published day (`firstDay`, from the server, or else the first day
 * with tokens in its year of daily totals), which comes before the account when joining brought earlier usage, or the
 * day the account was made.
 */
export function historyStart({ daily, memberSince, firstDay }: { daily: ReadonlyArray<{ day: string; tokens: number }>; memberSince: string; firstDay?: string }): string {
  const first = firstDay ?? daily.find(({ tokens }) => tokens > 0)?.day;
  return first && first < memberSince ? first : memberSince;
}

/** What a span's total is compared with: the same number of days just before it, as the server counts them. */
export function comparedWith(from: string, to: string): string {
  const days = dayCount(from, to);
  return days === 1 ? 'the day before' : days === 7 ? 'the week before' : `the ${days} days before`;
}

/** The best day and the average over the days with tokens. */
export function daySummary(days: ReadonlyArray<{ day: string; tokens: number }>): { best: { day: string; tokens: number } | null; average: number; activeDays: number } {
  let best: { day: string; tokens: number } | null = null, sum = 0, active = 0;
  for (const { day, tokens } of days) {
    if (tokens <= 0) continue;
    active++;
    sum += tokens;
    if (!best || tokens > best.tokens) best = { day, tokens };
  }
  return { best, average: active ? Math.round(sum / active) : 0, activeDays: active };
}

/** A long span's days added up seven at a time from its first day, with each week's cost (null when any day lacks one). */
export function byWeek(days: ReadonlyArray<{ day: string; tokens: number; costMicrousd?: number | null }>): Array<{ day: string; tokens: number; costMicrousd?: number | null; days: number }> {
  const weeks: Array<{ day: string; tokens: number; costMicrousd?: number | null; days: number }> = [];
  days.forEach((point, index) => {
    if (index % 7 === 0) weeks.push({ day: point.day, tokens: 0, ...('costMicrousd' in point ? { costMicrousd: 0 } : {}), days: 0 });
    const week = weeks.at(-1)!;
    week.tokens += point.tokens;
    week.days++;
    if ('costMicrousd' in point) week.costMicrousd = week.costMicrousd === null || point.costMicrousd == null ? null : week.costMicrousd! + point.costMicrousd;
  });
  return weeks;
}
