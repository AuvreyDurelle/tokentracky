export * from './generated/index.ts';
import type { TokenCounts } from './generated/index.ts';
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
