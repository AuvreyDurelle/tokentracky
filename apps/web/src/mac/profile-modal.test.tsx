import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BADGE_IDS, badgeProgress, type ProfileStats } from '@tokentracky/core';
import { ProfileCard, ProfileDialog, modelBars, toggleLike } from './ProfileModal';

const markup = (element: ReactElement) => renderToStaticMarkup(element).replaceAll('<!-- -->', '');
const VALUES: Record<string, number> = { 'token-titan': 1.1e12, 'big-day': 30.1e9, marathoner: 294, streak: 210, 'weekend-warrior': 81, momentum: 340, veteran: 357, podium: 1, multitool: 5, polyglot: 31, trendsetter: 0 };
const stats: ProfileStats = {
  alias: 'marenh',
  periods: { week: { rank: 1, tokens: 31e9, builders: 1 }, month: { rank: 1, tokens: 120e9, builders: 1 }, all: { rank: 1, tokens: 1.1e12, builders: 1 } },
  daily: Array.from({ length: 365 }, (_, index) => ({ day: new Date(Date.UTC(2025, 9, 26 + index)).toISOString().slice(0, 10), tokens: index % 3 ? 3e9 : 0 })),
  activity: { activeDays: 294, currentStreak: 210, longestStreak: 210, bestDay: { day: '2026-10-06', tokens: 30.1e9 }, averagePerActiveDay: 3.7e9 },
  toolTokens: { claude: 912.4e9, codex: 168.9e9, opencode: 14.6e9 },
  costMicrousd: 653_400e6,
  models: [{ model: 'claude-opus-5-5', tokens: 433e9, costMicrousd: 213_400e6 }, { model: 'claude-fable-5-1', tokens: 171.2e9, costMicrousd: 197_700e6 }, { model: 'gpt-6.1-sol', tokens: 112.6e9, costMicrousd: 41_820e6 }],
  likes: 14, memberSince: '2025-11-03', githubLogin: 'marenh',
  badges: BADGE_IDS.map((id) => badgeProgress(id, VALUES[id]!)),
};
const card = (props: Partial<Parameters<typeof ProfileCard>[0]> = {}) => markup(<ProfileCard stats={stats} likes={14} like={{ liked: false, pending: false }} onLike={() => {}} onClose={() => {}} headingId="pf" {...props} />);

describe('ProfileCard', () => {
  it('links GitHub only for a member who signed in with it', () => {
    expect(card()).toContain('href="https://github.com/marenh"');
    expect(card()).toContain('target="_blank"');
    expect(card({ stats: { ...stats, githubLogin: undefined } })).not.toContain('github.com');
  });
  it('shows the key stats compactly with the rank and member-since date', () => {
    const html = card();
    for (const text of ['>1.1T<', '>$653.4K<', '>294<', '>3.7B<', '#1 All time', 'Member since Nov 3, 2025', '210 days', '30.1B', 'claude-opus-5-5']) expect(html).toContain(text);
  });
  it('sizes the top-model bars against the largest', () => {
    const html = card();
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:39.5%"');
    expect(html).toContain('style="width:26%"');
    expect(modelBars([{ model: 'a', tokens: 50 }, { model: 'b', tokens: 0 }]).map((bar) => bar.width)).toEqual([100, 0]);
  });
  it('shows every badge with its tier and the way to the next', () => {
    const html = card();
    for (const name of ['Token Titan', 'Big Day', 'Marathoner', 'Streak', 'Weekend Warrior', 'Momentum', 'Veteran', 'Podium', 'Multitool', 'Polyglot', 'Trendsetter']) expect(html).toContain(`>${name}<`);
    expect(html).toContain('class="m-emb t4"');
    expect(html).toContain('class="m-emb t0"');
    expect(html).toContain('10 of 11 earned');
    expect(html).toContain('5 tools · 83% to Gold');
  });
  it('shows the like count, as a button only where you can like', () => {
    expect(card()).toMatch(/<button[^>]*aria-pressed="false"[^>]*>.*14<\/button>/);
    const fixed = card({ like: null });
    expect(fixed).not.toMatch(/<button[^>]*class="pf-like/);
    expect(fixed).toContain('>14<');
  });
  it('charts the usage like the website, as daily, cumulative or calendar over 30 days, 90 days or 12 months, or the last 24 hours', () => {
    const html = card();
    for (const label of ['Daily', 'Cumulative', 'Calendar', '24h', '30d', '90d', '12m']) expect(html).toMatch(new RegExp(`<button[^>]*>${label}</button>`));
    expect(html).toContain('aria-label="Tokens per UTC day, last 90 days"');
  });
  it('splits all-time tokens by type with shares, reasoning inside output, only when every day carries types', () => {
    const html = card({ stats: { ...stats, breakdown: { input: 100, output: 50, cacheRead: 800, cacheWrite: 50, reasoning: 30 } } });
    expect(html).toContain('All time · share of 1,000 tokens');
    expect(html).toContain('aria-label="Input 10%, Output 5.0%, Cache read 80%, Cache write 5.0%"');
    expect(html).toContain('Of which reasoning 30');
    expect(card()).not.toContain('Token types');
  });
  it('says when a builder keeps their tools or models private', () => {
    const html = card({ stats: { ...stats, toolTokens: undefined, models: undefined, costMicrousd: undefined } });
    expect(html).toContain('marenh doesn’t share a tool split.');
    expect(html).toContain('marenh doesn’t share a model mix.');
    expect(html).toContain('Not shared');
  });
});

describe('ProfileDialog', () => {
  it('is a modal dialog named by its heading', () => {
    const html = markup(<ProfileDialog labelledBy="pf" onClose={() => {}}><h2 id="pf">marenh</h2></ProfileDialog>);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="pf"');
  });
});

describe('likes', () => {
  it('flips the like and its count, and flipping back rolls it back', () => {
    expect(toggleLike({ liked: false, likes: 14 })).toEqual({ liked: true, likes: 15 });
    expect(toggleLike(toggleLike({ liked: true, likes: 3 }))).toEqual({ liked: true, likes: 3 });
  });
});
