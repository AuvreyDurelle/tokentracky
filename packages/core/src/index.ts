export * from './generated/index.ts';
import type { TokenCounts } from './generated/index.ts';
/** A leaderboard alias: 3-30 letters, numbers, underscores or hyphens, starting with a letter or number. */
export const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/;
/** Model ids that may be published: what tools log, without separators or free text. */
export function isPublicModel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][\w.:/@[\]-]{0,127}$/.test(value);
}
export function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

export { rankingWindow, isUtcDay, isSafeCount, checkedSum } from './ranking.ts';
export { activityStats } from './activity.ts';
export { BADGE_TIERS, badgeInputs, badgeProgress, type BadgeInputs } from './badges.ts';
