import type { BadgeId, ProfileStats } from './generated/index.ts';

/** Something worth sharing that a member has reached, with an id that changes when it is reached anew. */
export type Milestone =
  | { id: string; kind: 'week'; rank: 1 | 3 | 10 | 100 }
  | { id: string; kind: 'tokens'; tokens: number }
  | { id: string; kind: 'badge'; badge: BadgeId; tier: number };

const TOKEN_STEPS = [1e12, 1e11, 1e10, 1e9, 1e8];
const RANK_STEPS = [1, 3, 10, 100] as const;

/**
 * What the published profile has reached, most impressive first: the best weekly placing (keyed to the week, from the
 * Monday `weekStart`, so placing again next week counts again), the highest token count passed, and each badge's tier.
 */
export function milestones(stats: Pick<ProfileStats, 'periods' | 'badges'>, weekStart: string): Milestone[] {
  const reached: Milestone[] = [];
  const {rank} = stats.periods.week;
  const placing = rank > 0 ? RANK_STEPS.find((step) => rank <= step) : undefined;
  if (placing) reached.push({id: `week-${placing}:${weekStart}`, kind: 'week', rank: placing});
  const tokens = TOKEN_STEPS.find((step) => stats.periods.all.tokens >= step);
  if (tokens) reached.push({id: `tokens-${tokens}`, kind: 'tokens', tokens});
  for (const badge of [...stats.badges].filter((badge) => badge.tier > 0).sort((a, b) => b.tier - a.tier)) {
    reached.push({id: `badge-${badge.id}-${badge.tier}`, kind: 'badge', badge: badge.id, tier: badge.tier});
  }
  return reached;
}

/**
 * The milestone to show and the ids seen once it is: the first reached one not seen yet. Without anything seen yet
 * (`null`), everything reached counts as seen but the first, so a member who joins with a history sees one milestone,
 * not a backlog.
 */
export function nextMilestone(reached: Milestone[], seen: readonly string[] | null): {show: Milestone | null; seen: string[]} {
  const known = seen ?? reached.slice(1).map((milestone) => milestone.id);
  // A placing seen this week covers weaker ones: #1, then dropping to #2, is not news.
  const covered = (milestone: Milestone) => known.includes(milestone.id) || (milestone.kind === 'week' && known.some((id) => {
    const match = /^week-(\d+):(.+)$/.exec(id);
    return !!match && match[2] === milestone.id.slice(milestone.id.indexOf(':') + 1) && Number(match[1]) <= milestone.rank;
  }));
  return {show: reached.find((milestone) => !covered(milestone)) ?? null, seen: [...known]};
}
