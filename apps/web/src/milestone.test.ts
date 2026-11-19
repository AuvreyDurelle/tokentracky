import { describe, expect, it } from 'vitest';
import { milestoneCopy } from './Milestone';

describe('milestone copy', () => {
  it('words a weekly placing, a token count and a badge tier, for the banner and for a post', () => {
    expect(milestoneCopy({ id: 'week-1:2026-11-16', kind: 'week', rank: 1 })).toEqual({ title: 'You’re #1 on the leaderboard this week', post: 'I’m #1 on the Tokentracky leaderboard this week.' });
    expect(milestoneCopy({ id: 'week-10:2026-11-16', kind: 'week', rank: 10 }).title).toBe('You’re in the top 10 this week');
    expect(milestoneCopy({ id: 'tokens-1000000000', kind: 'tokens', tokens: 1e9 })).toEqual({ title: 'You’ve passed 1B tokens', post: 'I’ve passed 1B AI coding tokens on Tokentracky.' });
    expect(milestoneCopy({ id: 'badge-streak-3', kind: 'badge', badge: 'streak', tier: 3 })).toEqual({ title: 'You earned Gold Streak', post: 'I earned the Gold Streak badge on Tokentracky.' });
  });
});
