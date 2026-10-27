import { BADGE_IDS, badgeInputs, badgeProgress, type BadgeId, type BadgeProgress, type UsageSummary } from '@tokentracky/core';
import { formatCompact } from '../format';
import { ACHIEVEMENT_COPY, TIER_NAMES, formatBadgeValue } from './achievement-copy';

/** The page's sections (achievements.html), each badge in one. */
export const GROUPS: Array<{ title: string; note: string; ids: BadgeId[] }> = [
  { title: 'Volume', note: 'How much you build with AI.', ids: ['token-titan', 'big-day'] },
  { title: 'Consistency', note: 'Showing up, day after day.', ids: ['marathoner', 'streak', 'weekend-warrior', 'veteran'] },
  { title: 'Growth', note: 'Your biggest step up from one week to the next.', ids: ['momentum'] },
  { title: 'Range', note: 'The tools and models you use.', ids: ['multitool', 'polyglot', 'trendsetter'] },
  { title: 'Leaderboard', note: 'Where you have stood on the board.', ids: ['podium'] },
];

/** Badges that need the leaderboard: a rank, and models measured against when they reached the board. */
export const JOIN_TO_EARN: BadgeId[] = ['podium', 'trendsetter'];

/** How far a badge is towards its next tier, 0 to 1: value ÷ threshold, or threshold ÷ rank for podium (unranked is 0). Null at diamond. */
export function nextRatio(badge: BadgeProgress): number | null {
  if (badge.next === null) return null;
  if (badge.id === 'podium') return badge.value > 0 ? Math.min(1, badge.next / badge.value) : 0;
  return badge.next > 0 ? Math.min(1, badge.value / badge.next) : 0;
}

/** What is left before the next tier, in the badge's unit. */
export function toGo(badge: BadgeProgress): string {
  if (badge.next === null) return 'Top tier reached';
  const unit = ACHIEVEMENT_COPY[badge.id].unit;
  if (unit === 'rank') return badge.value > 0 ? `${badge.value - badge.next} places to go` : `Reach ${formatBadgeValue(badge.id, badge.next)}`;
  if (unit === 'growth') return `Needs a ${formatBadgeValue(badge.id, badge.next)} week`;
  return `${formatBadgeValue(badge.id, badge.next - badge.value)} to go`;
}

/** A threshold for a tier track: 100B, 15×, #3, 365. */
export function shortValue(id: BadgeId, value: number): string {
  const unit = ACHIEVEMENT_COPY[id].unit;
  return unit === 'tokens' ? formatCompact(value) : unit === 'growth' || unit === 'rank' ? formatBadgeValue(id, value) : String(value);
}

/** How many badges sit at each tier, none to diamond. */
export function tierCounts(badges: BadgeProgress[]): number[] {
  return [0, 1, 2, 3, 4].map((tier) => badges.filter((badge) => badge.tier === tier).length);
}

/** The three badges closest to their next tier, in display order on a tie; `skip` leaves out ones that can't be earned here. */
export function upNext(badges: BadgeProgress[], skip: readonly BadgeId[] = []): BadgeProgress[] {
  return badges.flatMap((badge) => { const ratio = nextRatio(badge); return ratio === null || skip.includes(badge.id) ? [] : [{ badge, ratio }]; })
    .sort((a, b) => b.ratio - a.ratio).slice(0, 3).map((entry) => entry.badge);
}

/** Before joining: the same badges worked out on this Mac from a year of local totals. Podium and trendsetter need the board, so they stay at 0. */
export function localBadges(summary: UsageSummary, today: string): BadgeProgress[] {
  const inputs = badgeInputs(summary.daily, today);
  const values: Record<BadgeId, number> = {
    'token-titan': summary.tokens, 'big-day': inputs.bestDay, marathoner: inputs.activeDays, streak: inputs.longestStreak,
    'weekend-warrior': inputs.weekendDays, momentum: inputs.momentum, veteran: inputs.veteran, podium: 0,
    multitool: summary.byTool.filter((tool) => tool.tokens > 0).length, polyglot: summary.byModel.filter((model) => model.tokens > 0).length, trendsetter: 0,
  };
  return BADGE_IDS.map((id) => badgeProgress(id, values[id]));
}

/** The value set against the next threshold: "18.4B of 100B", "14 of 15 models", "#42 · needs #30"; the value alone at diamond. */
export function progressOf(badge: BadgeProgress): string {
  const unit = ACHIEVEMENT_COPY[badge.id].unit;
  if (badge.next === null) return formatBadgeValue(badge.id, badge.value);
  if (unit === 'tokens') return `${formatCompact(badge.value)} of ${formatCompact(badge.next)}`;
  if (unit === 'growth' || unit === 'rank') return `${formatBadgeValue(badge.id, badge.value)} · needs ${formatBadgeValue(badge.id, badge.next)}`;
  return `${badge.value} of ${formatBadgeValue(badge.id, badge.next)}`;
}

/** A badge tile's line: the value, and how far it is to the next tier ("18.4B · 64% to Gold"), or "Top tier" at diamond. */
export function tierProgress(badge: BadgeProgress): string {
  const ratio = nextRatio(badge);
  const value = formatBadgeValue(badge.id, badge.value);
  return ratio === null ? `${value} · Top tier` : `${value} · ${Math.floor(ratio * 100)}% to ${TIER_NAMES[badge.tier + 1]}`;
}
