import { rankingWindow, type LeaderboardPeriod, type PublicProfile, type ToolId } from '@tokentracky/core';
import { shortDay } from '../format';

const HOUR_MS = 3_600_000;

/** The tools with a column of their own; every other tool adds up into Other. */
export const MAIN_TOOLS = ['claude', 'codex', 'gemini', 'opencode'] as const satisfies readonly ToolId[];

/** Tokens from tools outside the columns, the main ones unless given; null when the builder doesn't share a tool split. */
export function otherTokens(toolTokens: Partial<Record<ToolId, number>> | undefined, columns: readonly ToolId[] = MAIN_TOOLS): number | null {
  if (!toolTokens) return null;
  return Object.entries(toolTokens).reduce((sum, [tool, tokens]) => (columns as readonly string[]).includes(tool) ? sum : sum + (tokens ?? 0), 0);
}

/** The builder one rank above `me` and the tokens between you; null when `me` leads or either is missing. */
export function gapToNext(rows: readonly PublicProfile[], me: string): { ahead: PublicProfile; tokens: number } | null {
  const mine = rows.find((row) => row.alias === me);
  const ahead = mine && rows.find((row) => row.rank === mine.rank - 1);
  return mine && ahead ? { ahead, tokens: ahead.tokens - mine.tokens } : null;
}

/** The last seven of a row's fourteen daily totals. */
export function lastSeven(daily: readonly number[]): number[] { return daily.slice(-7); }

/** Page numbers for the pager: all of them up to seven, otherwise the ends and the current page's neighbours. */
export function pagerItems(page: number, pages: number): Array<number | '…'> {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
  if (pages <= 7) return range(1, pages);
  if (page <= 3) return [...range(1, 4), '…', pages];
  if (page >= pages - 2) return [1, '…', ...range(pages - 3, pages)];
  return [1, '…', page - 1, page, page + 1, '…', pages];
}

/** Where the board's window starts: 24 whole UTC hours before this hour began, Monday 00:00 UTC, the 1st, or never. */
export function windowStartOf(period: LeaderboardPeriod, now = Date.now()): string | null {
  if (period === '24h') return new Date(Math.floor(now / HOUR_MS) * HOUR_MS - 24 * HOUR_MS).toISOString();
  return rankingWindow(period, new Date(now));
}

/** When the current window moves on: the next whole hour for the last 24 hours, Monday 00:00 UTC for the week, the 1st for the month. */
export function resetText(period: LeaderboardPeriod, windowStart: string | null, now = Date.now()): { window: string; verb: string; left: string } | null {
  if (period === 'all' || !windowStart) return null;
  const start = new Date(windowStart);
  const end = period === '24h' ? start.getTime() + 25 * HOUR_MS : period === 'week' ? start.getTime() + 7 * 86_400_000 : Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  const minutes = Math.max(0, Math.round((end - now) / 60_000));
  const left = minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  if (period === '24h') return { window: 'Last 24 hours', verb: 'updates', left };
  return { window: `${period === 'week' ? 'Week' : 'Month'} of ${shortDay(windowStart.slice(0, 10))}`, verb: 'resets', left };
}

/** Whole days to close `gap` tokens on the builder above, from each of your last seven daily totals; null when you are not gaining. */
export function daysToPass(gap: number, mine: readonly number[], ahead: readonly number[]): number | null {
  const pace = (daily: readonly number[]) => lastSeven(daily).reduce((sum, tokens) => sum + tokens, 0) / 7;
  const gain = pace(mine) - pace(ahead);
  return gain > 0 ? Math.max(1, Math.ceil(gap / gain)) : null;
}

/** A row's move since the end of yesterday; `new` when it had no tokens before today (and always on 24-hour rows). */
export function rankMove(row: Pick<PublicProfile, 'rank' | 'previousRank'>): { kind: 'up' | 'down' | 'same' | 'new'; by: number } {
  if (row.previousRank === null) return { kind: 'new', by: 0 };
  const by = row.previousRank - row.rank;
  return by > 0 ? { kind: 'up', by } : by < 0 ? { kind: 'down', by: -by } : { kind: 'same', by: 0 };
}
