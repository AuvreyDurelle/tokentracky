// Shared by the share card the profile page draws and the preview images the hosted API renders.

/** Active days and the longest run of consecutive active days in `daily` from the UTC day `from` on. */
export function windowActivity(daily: ReadonlyArray<{day: string; tokens: number}>, from: string): {activeDays: number; longestStreak: number} {
  let activeDays = 0, run = 0, longestStreak = 0;
  for (const {day, tokens} of daily) {
    if (day < from) continue;
    if (tokens > 0) { activeDays += 1; run += 1; longestStreak = Math.max(longestStreak, run); } else run = 0;
  }
  return {activeDays, longestStreak};
}

/** The facts joined by middots, dropping trailing ones until the line fits. */
export function fitFacts(facts: string[], fits: (text: string) => boolean): string {
  let shown = facts;
  while (shown.length > 1 && !fits(shown.join(' · '))) shown = shown.slice(0, -1);
  return shown.join(' · ');
}

const utcDay = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
const WRAP = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/;

/**
 * A wrap's UTC days: `YYYY` is a calendar year and `YYYY-MM` a month. `to` stops at `today` while the period is under way;
 * `previous` is the whole period before. Null for a malformed period or one that has not started.
 */
export function wrapRange(period: string, today: string): {from: string; to: string; previous: {from: string; to: string}} | null {
  const match = WRAP.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : null;
  const from = utcDay(year, month ?? 1, 1);
  const end = month ? utcDay(year, month + 1, 0) : utcDay(year, 12, 31);
  if (from > today) return null;
  const previous = month ? {from: utcDay(year, month - 1, 1), to: utcDay(year, month, 0)} : {from: utcDay(year - 1, 1, 1), to: utcDay(year - 1, 12, 31)};
  return {from, to: end < today ? end : today, previous};
}

/** "November 2026" for a month wrap, "2026" for a year. */
export function wrapLabel(period: string): string {
  const match = WRAP.exec(period);
  if (!match?.[2]) return period;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});
}

/** The month wrap before or after `period` (`YYYY-MM`), or the year before or after (`YYYY`). */
export function adjacentWrap(period: string, step: -1 | 1): string {
  const match = WRAP.exec(period);
  if (!match) return period;
  if (!match[2]) return String(Number(match[1]) + step);
  return utcDay(Number(match[1]), Number(match[2]) + step, 1).slice(0, 7);
}

/** 0 for no usage, else 1–4 by quartile of the active days, so one huge day doesn't flatten the rest. */
export function heatLevels(values: number[]): number[] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  const cut = (share: number) => active[Math.max(0, Math.ceil(active.length * share) - 1)]!;
  const bounds = active.length ? [cut(0.25), cut(0.5), cut(0.75)] : [];
  return values.map((value) => value <= 0 ? 0 : 1 + bounds.filter((bound) => value > bound).length);
}
