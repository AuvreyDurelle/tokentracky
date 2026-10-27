export type Preset = 'today' | 7 | 30 | 90 | 365;
/** The You page's reporting period: a preset ending today, or a custom span of UTC days. */
export type RangeChoice = { preset: Preset } | { preset: 'custom'; from: string; to: string };
export interface DayRange { from: string; to: string }
/** Instants in milliseconds, `[since, until)`. */
export interface HourWindow { since: number; until: number }

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const utcToday = (now = new Date()) => now.toISOString().slice(0, 10);
export const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);

/** Inclusive UTC days, so every total, chart and export covers exactly the days it names. */
export function dayRange(choice: RangeChoice, now = new Date()): DayRange {
  const today = utcToday(now);
  if (choice.preset === 'custom') return { from: choice.from, to: choice.to };
  return { from: choice.preset === 'today' ? today : addDays(today, 1 - choice.preset), to: today };
}

export function rangeLabel(choice: RangeChoice): string {
  if (choice.preset === 'today') return 'today';
  if (choice.preset === 'custom') return choice.from === choice.to ? choice.from : `${choice.from} to ${choice.to}`;
  return choice.preset === 365 ? 'last 12 months' : `last ${choice.preset} days`;
}

/** Every UTC day from `from` to `to`, with zero for days that have no usage. */
export function fillRange<T extends { day: string; tokens: number }>(daily: T[], { from, to }: DayRange, value: (point: T) => number = (point) => point.tokens): Array<{ day: string; tokens: number }> {
  const byDay = new Map(daily.map((point) => [point.day, value(point)]));
  const days: Array<{ day: string; tokens: number }> = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push({ day, tokens: byDay.get(day) ?? 0 });
  return days;
}

/** Number of UTC days in an inclusive range. */
export const rangeLength = ({ from, to }: DayRange) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** The span of the same length ending the day before `range` starts: the period it is compared with. */
export function previousRange(range: DayRange): DayRange {
  return { from: addDays(range.from, -rangeLength(range)), to: addDays(range.from, -1) };
}

export function previousLabel(choice: RangeChoice, range: DayRange): string {
  if (choice.preset === 'today') return 'vs yesterday';
  if (choice.preset === 365) return 'vs previous 12 months';
  const length = rangeLength(range);
  return length === 1 ? 'vs previous day' : `vs previous ${length} days`;
}

/** The last 24 whole hours on this computer's clock: at 11:30 they run from 11:00 yesterday to 11:00 today, the last being
 * 10:00 to 11:00. The hour under way joins when it ends. */
export function last24Hours(now = new Date()): HourWindow {
  const until = new Date(now);
  until.setMinutes(0, 0, 0);
  return { since: until.getTime() - DAY_MS, until: until.getTime() };
}

/** The window of the same length ending where `window` starts: the period it is compared with. */
export const previousWindow = ({ since, until }: HourWindow): HourWindow => ({ since: since - (until - since), until: since });

/** Each hour's first instant in `window`, as the API writes it. */
export const hourList = ({ since, until }: HourWindow) => Array.from({ length: Math.round((until - since) / HOUR_MS) }, (_, index) => new Date(since + index * HOUR_MS).toISOString());
