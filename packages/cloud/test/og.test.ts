import { describe, expect, it } from 'vitest';
import { BADGE_IDS, type ProfileStats, type Wrapped } from '@tokentracky/core';
import { compareCardSvg, leadText, pngFromSvg, profileCardSvg, publicSite, wrappedCardSvg } from '../src/og.ts';

/** A profile whose 365 days end on Thursday 2026-10-22, active on the last three. */
function stats(overrides: Partial<ProfileStats> = {}): ProfileStats {
  const daily = Array.from({length: 365}, (_, index) => ({day: new Date(Date.UTC(2026, 9, 22) - (364 - index) * 86_400_000).toISOString().slice(0, 10), tokens: index >= 362 ? 1_000_000 * (index - 361) : 0}));
  return {
    alias: 'token-wizard', daily, likes: 0, memberSince: '2026-01-01',
    periods: {week: {rank: 3, tokens: 6_000_000, builders: 40}, month: {rank: 5, tokens: 6_000_000, builders: 40}, all: {rank: 12, tokens: 1_250_000_000, builders: 40}},
    activity: {activeDays: 120, currentStreak: 3, longestStreak: 9, bestDay: null, averagePerActiveDay: 0},
    badges: BADGE_IDS.map(id => ({id, tier: 0, value: 0, next: 1})),
    ...overrides,
  };
}

describe('profile preview card', () => {
  it('shows the window\'s rank, tokens and activity with the profile address', () => {
    const svg = profileCardSvg(stats({models: [{model: 'gpt-6.2-astra', tokens: 9}]}), 'all', 'https://tokentracky.com');
    expect(svg).toContain('width="1200" height="630"');
    expect(svg).toContain('>token-wizard<');
    expect(svg).toContain('>#12 all time<');
    expect(svg).toContain('>1.3B<');
    expect(svg).toContain('>tokens all time · 120 active days · longest streak 9 days · favourite gpt-6.2-astra<');
    expect(svg).toContain('>tokentracky.com/u/token-wizard<');
    expect(svg.match(/<rect /g)).toHaveLength(2 + 365);
  });
  it('counts a week\'s days from its Monday, the last day in the profile being today', () => {
    expect(profileCardSvg(stats(), 'week', 'https://tokentracky.com')).toContain('>tokens this week · 3 active days · longest streak 3 days<');
  });
  it('drops trailing facts that do not fit and leaves out a rank the window does not have', () => {
    const svg = profileCardSvg(stats({models: [{model: 'x'.repeat(60), tokens: 9}], periods: {...stats().periods, month: {rank: 0, tokens: 0, builders: 40}}}), 'month', 'https://tokentracky.com');
    expect(svg).toContain('>tokens this month · 3 active days · longest streak 3 days<');
    expect(svg).not.toContain('this month</text><text x="88" y="205"');
    expect(svg).not.toMatch(/#0 /);
  });
  it('escapes what it prints and draws the leaderboard card without a profile', () => {
    expect(profileCardSvg(stats({models: [{model: '<b>&', tokens: 1}]}), 'all', 'https://tokentracky.com')).toContain('favourite &#60;b&#62;&#38;');
    const placeholder = profileCardSvg(null, 'all', 'https://tokentracky.com');
    expect(placeholder).toContain('>The token leaderboard<');
    expect(placeholder).not.toContain('/u/');
  });
  it('renders a 1200×630 PNG with the bundled fonts', () => {
    const png = pngFromSvg(profileCardSvg(stats(), 'all', 'https://tokentracky.com'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });
});

describe('public site', () => {
  it('prefers the host the gateway forwards, then the request host, and keeps loopback on HTTP', () => {
    expect(publicSite({'x-tokentracky-host': 'Tokentracky.com', host: 'api.run.app'})).toBe('https://tokentracky.com');
    expect(publicSite({host: 'localhost:5173'})).toBe('http://localhost:5173');
    expect(publicSite({host: '127.0.0.1:3000'})).toBe('http://127.0.0.1:3000');
  });
  it('ignores anything that is not a plain host name', () => {
    expect(publicSite({'x-tokentracky-host': 'evil.example/"><x', host: 'site.example'})).toBe('https://site.example');
    expect(publicSite({'x-tokentracky-host': ['a.example', 'b.example']})).toBe('https://tokentracky.com');
    expect(publicSite({})).toBe('https://tokentracky.com');
  });
});

describe('wrap preview card', () => {
  const wrap: Wrapped = {alias: 'token-wizard', period: '2026-11', from: '2026-11-01', to: '2026-11-19', tokens: 3_400_000_000, rank: 4, builders: 120, previousTokens: 1,
    activeDays: 16, longestStreak: 6, bestDay: null, daily: Array.from({length: 19}, (_, index) => ({day: `2026-11-${String(index + 1).padStart(2, '0')}`, tokens: index % 7 === 6 ? 0 : 1e8})),
    toolTokens: {codex: 5, claude: 9}, models: [{model: 'claude-fable-5-2', tokens: 9}]};
  it('names the period, the rank among builders active in it, the activity and the top tool and model', () => {
    const svg = wrappedCardSvg(wrap, '2026-11', 'https://tokentracky.com');
    expect(svg).toContain('>Wrapped · November 2026<');
    expect(svg).toContain('>3.4B<');
    expect(svg).toContain('>tokens in November 2026 · #4 of 120 builders<');
    expect(svg).toContain('>16 active days · longest streak 6 days · mostly Claude Code · favourite claude-fable-5-2<');
    expect(svg).toContain('>tokentracky.com/wrapped/token-wizard/2026-11<');
    expect(svg.match(/<rect /g)).toHaveLength(2 + 19);
  });
  it('leaves out the rank without usage and draws the leaderboard card without a wrap', () => {
    expect(wrappedCardSvg({...wrap, rank: 0, tokens: 0, toolTokens: undefined, models: undefined}, '2026', 'https://tokentracky.com')).toContain('>tokens in 2026<');
    expect(wrappedCardSvg(null, '2026', 'https://tokentracky.com')).toContain('>The token leaderboard<');
  });
});

describe('head-to-head card', () => {
  it('puts both names, tokens and ranks in the window side by side, with who leads', () => {
    const svg = compareCardSvg(stats(), stats({alias: 'rival', periods: {...stats().periods, all: {rank: 30, tokens: 500_000_000, builders: 40}}}), 'all', 'https://tokentracky.com');
    expect(svg).toContain('>Head to head · all time<');
    expect(svg).toContain('>token-wizard<');
    expect(svg).toContain('>rival<');
    expect(svg).toContain('>1.3B<');
    expect(svg).toContain('>500M<');
    expect(svg).toContain('>#30 all time<');
    expect(svg).toContain('>token-wizard leads by 150%<');
    expect(svg).toContain('<rect x="88" y="430" width="731" height="14"');
    expect(svg).toContain('>tokentracky.com/vs/token-wizard/rival<');
  });
  it('words a tie and a lead over nothing, and draws the leaderboard card when either profile is missing', () => {
    expect(leadText({alias: 'a', tokens: 5}, {alias: 'b', tokens: 5})).toBe('Dead even');
    expect(leadText({alias: 'a', tokens: 0}, {alias: 'b', tokens: 5})).toBe('b leads');
    expect(compareCardSvg(stats(), null, 'week', 'https://tokentracky.com')).toContain('>The token leaderboard<');
  });
});
