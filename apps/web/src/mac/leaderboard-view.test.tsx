import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CommunityStats, PublicProfile } from '@tokentracky/core';
import { Board, CommunityHero, JoinStrip, RivalStrip, otherRanks } from './LeaderboardView';

/** Markup without the comments React puts between adjacent text. */
const markup = (element: ReactElement) => renderToStaticMarkup(element).replaceAll('<!-- -->', '');

const daily = Array.from({ length: 14 }, (_, index) => index * 10);
const profile = (alias: string, rank: number, tokens: number, extra: Partial<PublicProfile> = {}): PublicProfile => ({ alias, rank, tokens, previousRank: rank, daily, ...extra });
const rows = [
  profile('maren', 1, 1.1e12, { costMicrousd: 653_400e6, toolTokens: { claude: 912.4e9, codex: 168.9e9, gemini: 2.1e9, opencode: 14.6e9, roo: 2e9 }, topBadges: ['token-titan', 'podium'] }),
  profile('tobias', 2, 486.2e9, { costMicrousd: 301_900e6, toolTokens: { claude: 402.7e9, codex: 81.3e9, opencode: 2.2e9 } }),
  profile('ines', 3, 412.9e9, { costMicrousd: null }),
  profile('kenji', 4, 371.5e9),
];
const render = (props: Partial<Parameters<typeof Board>[0]> = {}) => markup(<Board rows={rows} neighbours={[]} me={null} total={3003} page={1} pageSize={12} loading={false} onPage={() => {}} onProfile={() => {}} {...props} />);

describe('Board', () => {
  it('gives the top three medals and only them', () => {
    const html = render();
    for (const rank of [1, 2, 3]) expect(html).toContain(`class="rank medal g${rank}"`);
    expect(html).toContain('class="rank">4<');
    expect(html.match(/medal/g)).toHaveLength(3);
  });
  it('shows compact totals and cost, and each builder’s three biggest tools as icons', () => {
    const html = render();
    for (const text of ['1.1T', '486.2B', '$653.4K']) expect(html).toContain(`>${text}<`);
    expect(html).toContain('title="1,100,000,000,000 tokens">1.1T<');
    expect(html).toContain('title="Claude Code, Codex, OpenCode"');
    expect(html).toContain('class="tool-ic ic-claude"');
  });
  it('writes a faint dash when cost is not shared or not priced, or the app sends no hours', () => {
    const html = render();
    expect(html).toContain('<span class="zero" title="Not shared">—</span>');
    expect(html).toContain('<span class="zero" title="Pricing unknown">—</span>');
    expect(html).toContain('title="Not sent by this builder’s app yet"');
  });
  it('highlights your row and shows the builders around you after a gap', () => {
    const neighbours = [profile('yuki', 41, 19.7e9), profile('example-builder', 42, 18.4e9), profile('lena', 43, 18e9)];
    const html = render({ me: 'example-builder', neighbours });
    expect(html.match(/<tr class="you"/g)).toHaveLength(1);
    expect(html).toContain('>18.4B<');
    expect(html).toContain('36 more builders between #4 and #41');
    expect(render({ me: 'kenji', neighbours })).not.toContain('more builders');
  });
  it('shows each move since yesterday, streaks, your rival and a link to each profile', () => {
    const moved = [{ ...rows[0]!, previousRank: 2, streak: 142 }, { ...rows[1]!, previousRank: 1 }, { ...rows[2]!, previousRank: null }, rows[3]!];
    const html = render({ rows: moved, me: 'kenji', rival: 'ines' });
    expect(html).toContain('>▲1<');
    expect(html).toContain('>▼1<');
    expect(html).toContain('>New<');
    expect(html).toContain('title="142-day streak"');
    expect(html).toContain('<tr class="rival"');
    expect(html).toContain('>Rival<');
    expect(html).toContain('href="/u/maren"');
  });
  it('says when the window resets, and drops cost and the 24-hour column from the 24-hour board', () => {
    const week = render({ period: 'week', windowStart: '2026-11-16T00:00:00.000Z' });
    expect(week).toMatch(/Week of [^<]+ · resets in <b>/);
    expect(week).toContain('>Est. cost<');
    const day = render({ period: '24h', windowStart: '2026-11-18T14:00:00.000Z' });
    expect(day).toContain('Last 24 hours · updates in');
    expect(day).not.toContain('Est. cost');
    expect(day).not.toContain('>▲');
    expect(render()).not.toContain('resets in');
  });
  it('counts the shown rows and pages through the board', () => {
    const html = render();
    expect(html).toContain('Showing 1–4 of 3,003 builders');
    expect(html).toContain('aria-current="page">1<');
    expect(html).toContain('>251<');
    expect(render({ total: 4 })).not.toContain('aria-label="Pages"');
  });
});

describe('CommunityHero', () => {
  const stats: CommunityStats = {
    builders: 3003, newBuilders: 146, breakdown: null, totalTokens: 37.8e12, totalCostMicrousd: 21.4e12, toolTotals: { claude: 614, codex: 298, gemini: 39, opencode: 31, cline: 18 },
    trend: Array.from({ length: 30 }, (_, index) => ({ day: new Date(Date.UTC(2026, 8, 26 + index)).toISOString().slice(0, 10), tokens: index < 23 ? 150e9 : 171e9 })),
    updatedAt: '2026-10-25T09:58:00Z',
  };
  it('shows the community totals compactly with the week’s growth and the tool split', () => {
    const html = markup(<CommunityHero stats={stats} />);
    for (const text of ['37.8T', '3,003', '+1.2T', '+146', '$21.4M']) expect(html).toContain(`>${text}<`);
    expect(html).toContain('↑ 14% vs last week');
    expect(html).toContain('Claude Code <b>61%</b>');
    expect(html).toContain('Other <b>1.8%</b>');
    expect(html).toMatch(/<path d="M4,[^"]+ L512 158 L4 158 Z"/);
    expect(html).toContain('Community tokens per day');
  });
  it('compares the last 24 hours with yesterday once the server sends them, and links to the community page', () => {
    const html = markup(<CommunityHero stats={{ ...stats, last24hTokens: 487.3e9, yesterdayTokens: 459.7e9 }} site="https://tokentracky.example" />);
    expect(html).toContain('>487.3B<');
    expect(html).toContain('↑ 6.0% vs yesterday');
    expect(html).toContain('href="https://tokentracky.example/community"');
    const older = markup(<CommunityHero stats={stats} />);
    expect(older).toMatch(/Last 24 hours<\/div><div class="m-stat-value">—</);
    expect(older).not.toContain('/community');
  });
  it('draws the last 12 months as a running total where the server sends them', () => {
    const monthly = Array.from({ length: 12 }, (_, index) => ({ month: new Date(Date.UTC(2025, 10 + index, 1)).toISOString().slice(0, 7), tokens: 2e12 }));
    const html = markup(<CommunityHero stats={{ ...stats, monthly, medianTokens: 1.9e9 }} />);
    expect(html).toContain('Community tokens, cumulative');
    expect(html).toContain('Last 12 months');
    expect([...html.matchAll(/<text class="axis" x="[\d.]+" y="180"[^>]*>([^<]+)<\/text>/g)].map((match) => match[1])).toEqual(['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
  });
});

describe('your position', () => {
  const pace = (perDay: number) => [...Array(7).fill(0), ...Array(7).fill(perDay)];
  const strip = (mine: PublicProfile, rows: PublicProfile[], extra: Partial<Parameters<typeof RivalStrip>[0]> = {}) => markup(<RivalStrip period="week" mine={mine} rows={rows} builders={4812} site="https://tokentracky.example"
    ranks={otherRanks('week', { week: { rank: 38, tokens: 1, builders: 1 }, month: { rank: 44, tokens: 1, builders: 1 }, all: { rank: 212, tokens: 1, builders: 1 } }, 31)} onProfile={() => {}} {...extra} />);
  it('races your rival, always the builder directly above you, with the one below chasing', () => {
    const mine = profile('orbitfox', 38, 3.06e9, { previousRank: 41, daily: pace(190e6) });
    const html = strip(mine, [profile('pallas', 37, 3.224e9, { daily: pace(100e6) }), mine, profile('brightwire', 39, 2.978e9)]);
    for (const text of ['#38', '▲3', 'of 4,812 · top 1%', 'Rival · the builder directly above you', '82M ahead', '164M to pass', '<b>164M to pass pallas</b>', 'about 2 days at your pace', 'You · #38'])
      expect(html).toContain(text);
    expect(html).toContain('href="https://tokentracky.example/vs/orbitfox/pallas"');
  });
  it('shows your rank in the other windows, the 24 hours included', () => {
    const html = strip(profile('orbitfox', 38, 3.06e9), [profile('orbitfox', 38, 3.06e9)]);
    for (const text of ['24h <b>#31</b>', 'Month <b>#44</b>', 'All time <b>#212</b>']) expect(html).toContain(text);
    expect(html).not.toContain('Week <b>');
    expect(otherRanks('all', null, null)).toEqual([{ period: '24h', rank: null }, { period: 'week', rank: null }, { period: 'month', rank: null }]);
  });
  it('says when you lead, with no pace when you are not gaining or within the last 24 hours', () => {
    const lead = strip(profile('kestrel', 1, 21.6e9), [profile('kestrel', 1, 21.6e9), profile('sunforge', 2, 17.9e9)]);
    expect(lead).toContain('You lead this board');
    expect(lead).toContain('<b>3.7B ahead of sunforge</b>');
    expect(lead).not.toContain('/vs/');
    const mine = profile('orbitfox', 38, 3.06e9, { daily: pace(100e6) });
    const slow = strip(mine, [profile('pallas', 37, 3.224e9, { daily: pace(100e6) }), mine]);
    expect(slow).not.toContain('at your pace');
    expect(strip(mine, [profile('pallas', 37, 3.224e9), mine], { period: '24h' })).not.toContain('at your pace');
  });
  it('invites you to join before you are on the board', () => {
    expect(markup(<JoinStrip onJoin={() => {}} />)).toContain('Join the leaderboard');
  });
});
