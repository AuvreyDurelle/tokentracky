import type { BadgeId } from '@tokentracky/core';
import { formatCompact, formatExact, formatShare } from '../format';

type Unit = 'tokens' | 'days' | 'weekend days' | 'growth' | 'rank' | 'tools' | 'models';

/** achievement badges: name, what it measures and that measure's unit. */
export const ACHIEVEMENT_COPY: Record<BadgeId, { name: string; description: string; unit: Unit }> = {
  'token-titan': { name: 'Token Titan', description: 'Total tokens across every tool.', unit: 'tokens' },
  'big-day': { name: 'Big Day', description: 'Your best single UTC day.', unit: 'tokens' },
  marathoner: { name: 'Marathoner', description: 'Days with any usage.', unit: 'days' },
  streak: { name: 'Streak', description: 'Your longest run of active days in a row.', unit: 'days' },
  'weekend-warrior': { name: 'Weekend Warrior', description: 'Active Saturdays and Sundays (UTC).', unit: 'weekend days' },
  momentum: { name: 'Momentum', description: 'Best week-over-week growth, after a week of at least 10M.', unit: 'growth' },
  veteran: { name: 'Veteran', description: 'Days since your first published day.', unit: 'days' },
  podium: { name: 'Podium', description: 'The best all-time rank you have reached.', unit: 'rank' },
  multitool: { name: 'Multitool', description: 'Different tools used.', unit: 'tools' },
  polyglot: { name: 'Polyglot', description: 'Different models used.', unit: 'models' },
  trendsetter: { name: 'Trendsetter', description: 'Models you used within 7 days of their first appearance on the board.', unit: 'models' },
};

/** Tier 0 to 4. */
export const TIER_NAMES = ['None', 'Bronze', 'Silver', 'Gold', 'Diamond'] as const;

/** "4.2% of builders", or null before anyone is on the board. */
export function rarityText(holders: number, builders: number): string | null {
  return builders > 0 ? `${formatShare(holders, builders)} of builders` : null;
}

/** A badge's measure in its unit: 18.4B, 30 days, 2.5×, #42. */
export function formatBadgeValue(id: BadgeId, value: number): string {
  const unit = ACHIEVEMENT_COPY[id].unit;
  if (unit === 'tokens') return formatCompact(value);
  if (unit === 'growth') return `${Number((value / 100).toFixed(1))}×`;
  if (unit === 'rank') return value > 0 ? `#${formatExact(value)}` : 'Unranked';
  return `${formatExact(value)} ${value === 1 ? unit.slice(0, -1) : unit}`;
}
