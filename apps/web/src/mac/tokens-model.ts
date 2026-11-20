import type { ProjectSummary, SessionSummary, UsageBreakdownRow } from '@tokentracky/core';
import { shortDay } from '../format';
import { addDays } from '../ranges';
import { usageSpan } from '../usage-span';
import type { ChartSeries } from './StackedAreaChart';

export type TokensPeriod = 'week' | 'month' | 'all';
export interface TokensSpan { from: string; to: string; title: string; canBack: boolean; canForward: boolean }

const MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_MS = 86_400_000;
const date = (day: string) => new Date(`${day}T00:00:00Z`);
const between = (from: string, to: string) => Math.round((date(to).getTime() - date(from).getTime()) / DAY_MS) + 1;

/**
 * The UTC days the Tokens page shows: a calendar week or month `back` steps before this one, up to today; everything
 * since the first day used for all time; or a custom range as chosen. The title says which, and how far a span under way
 * has got.
 */
export function tokensSpan(period: TokensPeriod, back: number, today: string, first: string | null, custom: { from: string; to: string } | null): TokensSpan {
  if (custom) return { ...custom, title: `${shortDay(custom.from)} – ${shortDay(custom.to)} ${date(custom.to).getUTCFullYear()}`, canBack: false, canForward: false };
  const span = usageSpan(period, back, today, first);
  if (period === 'all') return { ...span, title: `Since ${shortDay(span.from)} ${date(span.from).getUTCFullYear()}` };
  const end = period === 'week' ? addDays(span.from, 6) : new Date(Date.UTC(date(span.from).getUTCFullYear(), date(span.from).getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const length = between(span.from, end);
  const under = span.to < end;
  const title = period === 'month'
    ? under ? `1–${date(span.to).getUTCDate()} ${MONTH.format(date(span.from))} · day ${between(span.from, span.to)} of ${length}` : MONTH.format(date(span.from))
    : `Week of ${shortDay(span.from)}${under ? ` · day ${between(span.from, span.to)} of 7` : ''}`;
  return { ...span, title };
}

/** A long span added up seven days at a time from its first day: each week named by its first day. */
export function weekly(days: string[], values: number[]): { days: string[]; values: number[] } {
  const out = { days: [] as string[], values: [] as number[] };
  days.forEach((day, index) => {
    if (index % 7 === 0) { out.days.push(day); out.values.push(0); }
    out.values[out.values.length - 1]! += values[index] ?? 0;
  });
  return out;
}

const PROJECT_COLORS = ['var(--pink-2)', 'var(--tool-gemini)', 'var(--tool-opencode)', 'var(--tool-cline)', 'var(--gold)'];
/**
 * Series by project from each project's days: the five largest, then the rest together, then usage with no project,
 * which is each day's total in `rows` beyond what the projects account for.
 */
export function projectSeries(projects: ReadonlyArray<Pick<ProjectSummary, 'name' | 'tokens' | 'daily'>>, days: string[], rows: readonly UsageBreakdownRow[] = []): ChartSeries[] {
  const index = new Map(days.map((day, at) => [day, at]));
  const values = (project: Pick<ProjectSummary, 'daily'>) => {
    const out = days.map(() => 0);
    for (const day of project.daily ?? []) { const at = index.get(day.day); if (at !== undefined) out[at] += day.tokens; }
    return out;
  };
  const sorted = [...projects].sort((a, b) => b.tokens - a.tokens);
  const series: ChartSeries[] = sorted.slice(0, 5).map((project, at) => ({ key: project.name, label: projectName(project.name), color: PROJECT_COLORS[at]!, values: values(project) }));
  const rest = sorted.slice(5);
  if (rest.length) series.push({ key: 'other', label: 'Other', color: 'var(--heat-2)', values: days.map((_, at) => rest.reduce((sum, project) => sum + values(project)[at]!, 0)) });
  const none = days.map(() => 0);
  for (const row of rows) { const at = index.get(row.day); if (at !== undefined) none[at] += row.tokens; }
  for (const item of series) item.values.forEach((tokens, at) => { none[at] -= tokens; });
  if (none.some((tokens) => tokens > 0)) series.push({ key: 'none', label: 'No project', color: 'var(--heat-1)', values: none.map((tokens) => Math.max(0, tokens)) });
  return series;
}
export const projectName = (path: string | null) => path?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No project';

const KIND_SERIES = [
  { key: 'input', label: 'Input', color: 'var(--kind-input)' }, { key: 'output', label: 'Output', color: 'var(--kind-output)' },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--kind-cache-read)' }, { key: 'cacheWrite', label: 'Cache write', color: 'var(--kind-cache-write)' },
] as const;
/** Series by kind of token, in a fixed order, from each day's rows. */
export function kindSeries(rows: readonly UsageBreakdownRow[], days: string[]): ChartSeries[] {
  const index = new Map(days.map((day, at) => [day, at]));
  return KIND_SERIES.map((kind) => {
    const values = days.map(() => 0);
    for (const row of rows) { const at = index.get(row.day); if (at !== undefined) values[at] += row.breakdown[kind.key]; }
    return { key: kind.key, label: kind.label, color: kind.color, values, soft: kind.key === 'output' || undefined };
  });
}

/** Today's tokens carried on to the end of the UTC day at today's pace; none before a fifth of the day has passed. */
export function paceToday(tokens: number, now = Date.now()): number | null {
  const share = (now % DAY_MS) / DAY_MS;
  return share < 0.2 ? null : Math.round(tokens / share);
}

/** The calendar week, Monday to Sunday, with the most tokens. */
export function bestWeek(daily: ReadonlyArray<{ day: string; tokens: number }>): { from: string; tokens: number } | null {
  const weeks = new Map<string, number>();
  for (const { day, tokens } of daily) {
    const monday = addDays(day, -((date(day).getUTCDay() + 6) % 7));
    weeks.set(monday, (weeks.get(monday) ?? 0) + tokens);
  }
  let best: { from: string; tokens: number } | null = null;
  for (const [from, tokens] of weeks) if (tokens > 0 && (!best || tokens > best.tokens)) best = { from, tokens };
  return best;
}

const LENGTHS = [{ label: '<5m', under: 5 }, { label: '5–15m', under: 15 }, { label: '15–30m', under: 30 }, { label: '30m–1h', under: 60 }, { label: '1–2h', under: 120 }, { label: '2–3h', under: 180 }, { label: '3h+', under: Infinity }];
/** Sessions by length, from first request to last, with each bucket's tokens. */
export function sessionLengths(sessions: ReadonlyArray<Pick<SessionSummary, 'startedAt' | 'lastUsedAt' | 'tokens'>>): Array<{ label: string; sessions: number; tokens: number }> {
  const buckets = LENGTHS.map((bucket) => ({ label: bucket.label, sessions: 0, tokens: 0 }));
  for (const session of sessions) {
    // A session without times (from before they were kept) has no length.
    if (!session.startedAt || !session.lastUsedAt) continue;
    const minutes = (Date.parse(session.lastUsedAt) - Date.parse(session.startedAt)) / 60_000;
    const bucket = buckets[LENGTHS.findIndex((length) => minutes < length.under)]!;
    bucket.sessions++;
    bucket.tokens += session.tokens;
  }
  return buckets;
}

/** What the weekday-by-hour grid (Monday first) says: the busiest weekday, hour and hour of the week, and the weekend's share. */
export function weekdayHourStats(grid: number[][]) {
  const days = grid.map((hours) => hours.reduce((sum, tokens) => sum + tokens, 0));
  const hours = Array.from({ length: 24 }, (_, hour) => grid.reduce((sum, day) => sum + (day[hour] ?? 0), 0));
  let peak = { day: 0, hour: 0, tokens: 0 };
  grid.forEach((row, day) => row.forEach((tokens, hour) => { if (tokens > peak.tokens) peak = { day, hour, tokens }; }));
  return { days, hours, peak, total: days.reduce((sum, tokens) => sum + tokens, 0), weekend: (days[5] ?? 0) + (days[6] ?? 0),
    busiestDay: days.indexOf(Math.max(...days)), busiestHour: hours.indexOf(Math.max(...hours)) };
}

/** Each day's cache hit rate: cache reads over all tokens read in (input, cache reads and writes); none on a quiet day. */
export function cachePerDay(rows: readonly UsageBreakdownRow[], days: string[]): Array<number | null> {
  return days.map((day) => {
    let read = 0, all = 0;
    for (const row of rows) if (row.day === day) { read += row.breakdown.cacheRead; all += row.breakdown.input + row.breakdown.cacheRead + row.breakdown.cacheWrite; }
    return all ? Math.round((read / all) * 1000) / 1000 : null;
  });
}

/** Each day's estimated dollars per million tokens; none on a quiet or unpriced day. */
export function costPerMillion(daily: ReadonlyArray<{ day: string; tokens: number; costMicrousd: number | null }>, days: string[]): Array<number | null> {
  const byDay = new Map(daily.map((day) => [day.day, day]));
  return days.map((day) => {
    const entry = byDay.get(day);
    return !entry || !entry.tokens || entry.costMicrousd === null ? null : Math.round((entry.costMicrousd / entry.tokens) * 100) / 100;
  });
}

/** Each day's share among the `top` largest models over the span, the rest together; a quiet day shares nothing. */
export function modelMix(rows: readonly UsageBreakdownRow[], days: string[], top = 5): Array<{ key: string; label: string; values: number[] }> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.model, (totals.get(row.model) ?? 0) + row.tokens);
  const models = [...totals].sort((a, b) => b[1] - a[1]).slice(0, top).map(([model]) => model);
  const perDay = days.map((day) => rows.filter((row) => row.day === day));
  const share = (match: (model: string) => boolean) => perDay.map((dayRows) => {
    const all = dayRows.reduce((sum, row) => sum + row.tokens, 0);
    return all ? Math.round((dayRows.filter((row) => match(row.model)).reduce((sum, row) => sum + row.tokens, 0) / all) * 1000) / 1000 : 0;
  });
  const series = models.map((model) => ({ key: model, label: model, values: share((name) => name === model) }));
  if (totals.size > models.length) series.push({ key: 'other', label: 'Other', values: share((name) => !models.includes(name)) });
  return series;
}
