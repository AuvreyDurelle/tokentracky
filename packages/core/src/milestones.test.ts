import { describe, expect, it } from 'vitest';
import { BADGE_IDS, type ProfileStats } from './generated/index.ts';
import { milestones, nextMilestone } from './milestones.ts';

const stats = (week: number, all: number, tiers: Partial<Record<(typeof BADGE_IDS)[number], number>> = {}): Pick<ProfileStats, 'periods' | 'badges'> => ({
  periods: {week: {rank: week, tokens: 1, builders: 500}, month: {rank: 1, tokens: 1, builders: 500}, all: {rank: 1, tokens: all, builders: 500}},
  badges: BADGE_IDS.map((id) => ({id, tier: tiers[id] ?? 0, value: 0, next: null})),
});

describe('milestones', () => {
  it('lists the best weekly placing for the week, the highest token count passed, then badges by tier', () => {
    expect(milestones(stats(2, 3.4e9, {streak: 2, podium: 4}), '2026-11-16')).toEqual([
      {id: 'week-3:2026-11-16', kind: 'week', rank: 3},
      {id: 'tokens-1000000000', kind: 'tokens', tokens: 1e9},
      {id: 'badge-podium-4', kind: 'badge', badge: 'podium', tier: 4},
      {id: 'badge-streak-2', kind: 'badge', badge: 'streak', tier: 2},
    ]);
  });
  it('leaves out a rank outside the top 100, no rank, and fewer than 100M tokens', () => {
    expect(milestones(stats(101, 99e6), '2026-11-16')).toEqual([]);
    expect(milestones(stats(0, 1e8), '2026-11-16')).toEqual([{id: 'tokens-100000000', kind: 'tokens', tokens: 1e8}]);
    expect(milestones(stats(1, 2e12), '2026-11-16').map((milestone) => milestone.id)).toEqual(['week-1:2026-11-16', 'tokens-1000000000000']);
  });
});

describe('next milestone', () => {
  const reached = milestones(stats(10, 1.2e10, {veteran: 1}), '2026-11-16');
  it('shows one milestone the first time, counting the rest as seen', () => {
    expect(nextMilestone(reached, null)).toEqual({show: reached[0], seen: ['tokens-10000000000', 'badge-veteran-1']});
  });
  it('shows the first one not seen, then nothing once all are seen', () => {
    expect(nextMilestone(reached, ['week-10:2026-11-16']).show).toEqual(reached[1]);
    expect(nextMilestone(reached, reached.map((milestone) => milestone.id)).show).toBeNull();
  });
  it('counts a weaker placing in the same week as seen once a stronger one has been', () => {
    expect(nextMilestone(milestones(stats(2, 0), '2026-11-16'), ['week-1:2026-11-16']).show).toBeNull();
    expect(nextMilestone(milestones(stats(2, 0), '2026-11-16'), ['week-1:2026-11-09']).show?.id).toBe('week-3:2026-11-16');
    expect(nextMilestone(milestones(stats(1, 0), '2026-11-16'), ['week-3:2026-11-16']).show?.id).toBe('week-1:2026-11-16');
  });
  it('shows a placing again in a new week and a badge again at a new tier', () => {
    const seen = reached.map((milestone) => milestone.id);
    expect(nextMilestone(milestones(stats(10, 1.2e10, {veteran: 1}), '2026-11-23'), seen).show?.id).toBe('week-10:2026-11-23');
    expect(nextMilestone(milestones(stats(200, 1.2e10, {veteran: 2}), '2026-11-16'), seen).show?.id).toBe('badge-veteran-2');
  });
});
