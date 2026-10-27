import type { PublicProfile, ToolId } from '@tokentracky/core';

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
