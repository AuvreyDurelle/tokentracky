import type { ToolId } from '@tokentracky/core';
import { TOOLS } from './format';

/** At most this many tools get a leaderboard column of their own. */
export const TOOL_COLUMNS = 4;

/**
 * Tools with a leaderboard column: the ones with the most community tokens, largest first, at most `TOOL_COLUMNS`; a tool being ranked by keeps one.
 * Until anyone shares a tool split, Claude Code and Codex hold the place.
 */
export function toolColumns(totals: Partial<Record<ToolId, number | bigint>>, rankBy: string): ToolId[] {
  const shared = TOOLS.map((tool) => tool.id).filter((id) => (totals[id] ?? 0) > 0).sort((a, b) => totals[a]! === totals[b]! ? 0 : totals[a]! < totals[b]! ? 1 : -1);
  if (!shared.length) return TOOLS.slice(0, 2).map((tool) => tool.id);
  const own = shared.slice(0, TOOL_COLUMNS);
  const ranked = shared.find((id) => id === rankBy);
  return ranked && !own.includes(ranked) ? [...own.slice(0, TOOL_COLUMNS - 1), ranked] : own;
}
