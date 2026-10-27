import { BADGE_IDS, badgeProgress, type BadgeId, type UsageSummary } from '@tokentracky/core';
import { describe, expect, it } from 'vitest';
import { GROUPS, JOIN_TO_EARN, localBadges, nextRatio, progressOf, shortValue, tierCounts, toGo, upNext } from './achievements';

describe('badge progress', () => {
  it('measures the way to the next tier as value over threshold', () => {
    expect(nextRatio(badgeProgress('token-titan', 18.4e9))).toBeCloseTo(0.184);
    expect(nextRatio(badgeProgress('streak', 0))).toBe(0);
    expect(nextRatio(badgeProgress('marathoner', 400))).toBeNull();
  });
  it('treats podium as a rank, where lower is closer and 0 has not started', () => {
    expect(nextRatio(badgeProgress('podium', 200))).toBe(0.5);
    expect(nextRatio(badgeProgress('podium', 42))).toBeCloseTo(30 / 42);
    expect(nextRatio(badgeProgress('podium', 0))).toBe(0);
    expect(nextRatio(badgeProgress('podium', 1))).toBeNull();
  });
  it('says what is left before the next tier, in the badge’s unit', () => {
    expect(toGo(badgeProgress('token-titan', 18.4e9))).toBe('81.6B to go');
    expect(toGo(badgeProgress('streak', 34))).toBe('66 days to go');
    expect(toGo(badgeProgress('multitool', 3))).toBe('1 tool to go');
    expect(toGo(badgeProgress('podium', 42))).toBe('12 places to go');
    expect(toGo(badgeProgress('podium', 0))).toBe('Reach #100');
    expect(toGo(badgeProgress('momentum', 340))).toBe('Needs a 6× week');
    expect(toGo(badgeProgress('veteran', 400))).toBe('Top tier reached');
  });
  it('sets the value against the next threshold', () => {
    expect(progressOf(badgeProgress('token-titan', 18.4e9))).toBe('18.4B of 100B');
    expect(progressOf(badgeProgress('polyglot', 14))).toBe('14 of 15 models');
    expect(progressOf(badgeProgress('momentum', 520))).toBe('5.2× · needs 6×');
    expect(progressOf(badgeProgress('podium', 42))).toBe('#42 · needs #30');
    expect(progressOf(badgeProgress('streak', 120))).toBe('120 days');
  });
  it('labels thresholds briefly', () => {
    expect(shortValue('token-titan', 100e9)).toBe('100B');
    expect(shortValue('momentum', 1500)).toBe('15×');
    expect(shortValue('podium', 3)).toBe('#3');
    expect(shortValue('marathoner', 365)).toBe('365');
  });
});

describe('the achievements page', () => {
  const badges = BADGE_IDS.map((id) => badgeProgress(id, ({ 'token-titan': 18.4e9, 'big-day': 412e6, marathoner: 214, streak: 34, 'weekend-warrior': 41, momentum: 520, veteran: 301, podium: 42, multitool: 5, polyglot: 14, trendsetter: 1 } as Record<BadgeId, number>)[id]));
  it('files every badge in exactly one group', () => {
    expect(GROUPS.flatMap((group) => group.ids).sort()).toEqual([...BADGE_IDS].sort());
    expect(GROUPS.map((group) => group.title)).toEqual(['Volume', 'Consistency', 'Growth', 'Range', 'Leaderboard']);
  });
  it('counts badges at each tier', () => {
    expect(tierCounts(badges)).toEqual([1, 3, 3, 4, 0]);
  });
  it('picks the three badges closest to their next tier, leaving out ones you cannot earn here', () => {
    // polyglot 14/15, momentum 520/600, veteran 301/365, multitool 5/6, podium 30/42 …
    expect(upNext(badges).map((badge) => badge.id)).toEqual(['polyglot', 'momentum', 'multitool']);
    expect(upNext(badges, ['polyglot']).map((badge) => badge.id)).toEqual(['momentum', 'multitool', 'veteran']);
    expect(upNext(BADGE_IDS.map((id) => badgeProgress(id, 0)), JOIN_TO_EARN)).toHaveLength(3);
  });
});

describe('badges before joining', () => {
  const day = (offset: number) => new Date(Date.UTC(2026, 9, 25 + offset)).toISOString().slice(0, 10);
  // Thursday 15 October to Sunday 25 October 2026, every day active.
  const summary = {
    tokens: 150e6, costMicrousd: null, sessions: 3, cacheRate: 0,
    activity: { activeDays: 11, currentStreak: 11, longestStreak: 11, bestDay: null, averagePerActiveDay: 0 },
    byTool: [{ tool: 'claude', tokens: 100e6, costMicrousd: null }, { tool: 'codex', tokens: 50e6, costMicrousd: null }, { tool: 'gemini', tokens: 0, costMicrousd: null }],
    byModel: Array.from({ length: 5 }, (_, index) => ({ model: `m${index}`, tokens: 1, costMicrousd: null })),
    daily: Array.from({ length: 11 }, (_, index) => ({ day: day(index - 10), tokens: index === 10 ? 50e6 : 10e6, costMicrousd: null })),
  } as UsageSummary;
  it('works the progress out on this Mac with the same thresholds', () => {
    const local = Object.fromEntries(localBadges(summary, '2026-10-25').map((badge) => [badge.id, badge]));
    expect(Object.keys(local)).toEqual([...BADGE_IDS]);
    expect(local['token-titan']).toEqual({ id: 'token-titan', tier: 1, value: 150e6, next: 1e9 });
    expect(local['big-day']!.value).toBe(50e6);
    expect(local.marathoner).toMatchObject({ value: 11, tier: 1 });
    expect(local.streak).toMatchObject({ value: 11, tier: 2 });
    expect(local['weekend-warrior']!.value).toBe(4);
    expect(local.veteran!.value).toBe(10);
    expect(local.multitool).toMatchObject({ value: 2, tier: 1 });
    expect(local.polyglot).toMatchObject({ value: 5, tier: 1 });
    for (const id of JOIN_TO_EARN) expect(local[id]).toMatchObject({ value: 0, tier: 0 });
  });
});
