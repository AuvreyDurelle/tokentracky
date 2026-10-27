import type { SessionSummary, UsageBreakdownRow, UsageSummary } from '@tokentracky/core';
import { addDays } from '../ranges';

/** One series' tokens and known cost (micro-USD) per day, aligned to the chart's days. `other` marks the folded-in rest. */
export interface DailySeries { key: string; other?: true; tokens: number[]; cost: number[] }

const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

/** Groups rows by `key` into series over `days`, largest first. Unpriced rows add tokens but no cost. */
function series(rows: UsageBreakdownRow[], days: string[], key: (row: UsageBreakdownRow) => string): DailySeries[] {
  const index = new Map(days.map((day, position) => [day, position]));
  const groups = new Map<string, DailySeries>();
  for (const row of rows) {
    const position = index.get(row.day);
    if (position === undefined) continue;
    const id = key(row);
    let group = groups.get(id);
    if (!group) groups.set(id, group = { key: id, tokens: new Array<number>(days.length).fill(0), cost: new Array<number>(days.length).fill(0) });
    group.tokens[position]! += row.tokens;
    group.cost[position]! += row.costMicrousd ?? 0;
  }
  return [...groups.values()].sort((a, b) => total(b.tokens) - total(a.tokens) || a.key.localeCompare(b.key));
}

/** Breakdown rows as one series per tool over `days`, quiet days as zero, largest first. */
export function dailyByTool(rows: UsageBreakdownRow[], days: string[]): DailySeries[] {
  return series(rows, days, (row) => row.tool);
}

/** The `top` largest models over `days`, then everything else as one Other series. */
export function dailyByModel(rows: UsageBreakdownRow[], days: string[], top = 5): DailySeries[] {
  const models = series(rows, days, (row) => row.model);
  const rest = models.slice(top);
  if (!rest.length) return models;
  const sum = (pick: (item: DailySeries) => number[]) => days.map((_, position) => rest.reduce((value, item) => value + pick(item)[position]!, 0));
  return [...models.slice(0, top), { key: 'other', other: true, tokens: sum((item) => item.tokens), cost: sum((item) => item.cost) }];
}

/** The model with the most tokens and its share of all of them; null without usage. */
export function favouriteModel(byModel: UsageSummary['byModel']): { model: string; tokens: number; share: number } | null {
  const sum = total(byModel.map((item) => item.tokens));
  const best = byModel.reduce<UsageSummary['byModel'][number] | null>((top, item) => !top || item.tokens > top.tokens ? item : top, null);
  return best && sum > 0 ? { model: best.model, tokens: best.tokens, share: best.tokens / sum } : null;
}

type Day = UsageSummary['daily'][number];
/** The day with the largest known cost; null when no day has one. */
export function mostExpensiveDay(daily: Day[]): Day & { costMicrousd: number } | null {
  let best: (Day & { costMicrousd: number }) | null = null;
  for (const day of daily) if (day.costMicrousd !== null && day.costMicrousd > (best?.costMicrousd ?? 0)) best = { ...day, costMicrousd: day.costMicrousd };
  return best;
}

/** The session with the most tokens. */
export function biggestSession(sessions: SessionSummary[]): SessionSummary | null {
  return sessions.reduce<SessionSummary | null>((best, session) => !best || session.tokens > best.tokens ? session : best, null);
}

/** The model whose share of tokens grew most since the previous period, in share points to one decimal (ties go to the larger share). Null when nothing grew or either period is empty. */
export function trendingModel(current: UsageSummary['byModel'], previous: UsageSummary['byModel']): { model: string; share: number; previousShare: number; gain: number } | null {
  const now = total(current.map((item) => item.tokens)), before = total(previous.map((item) => item.tokens));
  if (!now || !before) return null;
  const earlier = new Map(previous.map((item) => [item.model, item.tokens / before]));
  let best: { model: string; share: number; previousShare: number; gain: number } | null = null;
  for (const item of current) {
    const share = item.tokens / now, previousShare = earlier.get(item.model) ?? 0;
    const gain = Math.round((share - previousShare) * 1000) / 10;
    if (gain > 0 && (!best || gain > best.gain || (gain === best.gain && share > best.share))) best = { model: item.model, share, previousShare, gain };
  }
  return best;
}

/** Mean tokens per UTC weekday (Monday first) over every day given, and how the busiest compares with the mean day. Pass every day of the window, quiet ones as zero. */
export function busiestWeekdayUtc(daily: Array<{ day: string; tokens: number }>): { weekday: number; averages: number[]; ratio: number } | null {
  const sums = new Array<number>(7).fill(0), counts = new Array<number>(7).fill(0);
  for (const { day, tokens } of daily) {
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    sums[weekday]! += tokens; counts[weekday]! += 1;
  }
  const all = total(sums);
  if (!all) return null;
  const averages = sums.map((sum, weekday) => counts[weekday] ? sum / counts[weekday]! : 0);
  const weekday = averages.indexOf(Math.max(...averages));
  return { weekday, averages, ratio: averages[weekday]! / (all / daily.length) };
}

/** Percent change from the previous period; null when it had nothing to compare with. */
export function changeVsPrevious(current: number, previous: number): number | null {
  return previous ? ((current - previous) / previous) * 100 : null;
}

/** Tokens and cost over the `days` UTC days ending `today`, and the percent change from the `days` before (null with nothing before).
 *  Cost is null when a day in the window has no known price. */
export function recentTotals(daily: Array<{ day: string; tokens: number; costMicrousd: number | null }>, today: string, days: number): { tokens: number; costMicrousd: number | null; change: number | null } {
  const from = addDays(today, 1 - days), before = addDays(from, -days);
  let tokens = 0, previous = 0, costMicrousd: number | null = 0;
  for (const point of daily) {
    if (point.day >= from && point.day <= today) {
      tokens += point.tokens;
      costMicrousd = costMicrousd === null || point.costMicrousd === null ? null : costMicrousd + point.costMicrousd;
    } else if (point.day >= before && point.day < from) previous += point.tokens;
  }
  return { tokens, costMicrousd, change: changeVsPrevious(tokens, previous) };
}

/** The hour of day with the most tokens, 0 to 23, and its share of them; null without usage. `byHour` is the summary's 24 totals. */
export function busiestHour(byHour: number[]): { hour: number; share: number } | null {
  const sum = total(byHour);
  if (!sum) return null;
  const hour = byHour.indexOf(Math.max(...byHour));
  return { hour, share: byHour[hour]! / sum };
}
