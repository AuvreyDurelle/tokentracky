import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CommunityStats, PublicProfile } from '@tokentracky/core';
import { Board, CommunityHero, JoinStrip, YouStrip } from './LeaderboardView';

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
  it('shows compact totals, tool columns, Other and cost', () => {
    const html = render();
    for (const text of ['1.1T', '912.4B', '168.9B', '14.6B', '486.2B', '$653.4K']) expect(html).toContain(`>${text}<`);
    // Roo Code is outside the main columns, so it is Other.
    expect(html).toContain('title="2,000,000,000 tokens">2B<');
    expect(html).toContain('title="1,100,000,000,000 tokens">1.1T<');
  });
  it('writes a faint dash for zero, and says when a split or cost is not shared', () => {
    const html = render();
    expect(html).toContain('<span class="zero">—</span>');
    expect(html).toContain('<span class="zero" title="Not shared">—</span>');
    expect(html).toContain('<span class="zero" title="Pricing unknown">—</span>');
  });
  it('highlights your row and shows the builders around you after a gap', () => {
    const neighbours = [profile('yuki', 41, 19.7e9), profile('example-builder', 42, 18.4e9), profile('lena', 43, 18e9)];
    const html = render({ me: 'example-builder', neighbours });
    expect(html.match(/<tr class="you"/g)).toHaveLength(1);
    expect(html).toContain('>18.4B<');
    expect(html).toContain('36 more builders between #4 and #41');
    expect(render({ me: 'kenji', neighbours })).not.toContain('more builders');
  });
  it('shows the top badges as emblems and links each builder to their profile', () => {
    const html = render();
    expect(html).toContain('aria-label="Token Titan"');
    expect(html).toContain('aria-label="Podium"');
    expect(html).toContain('href="/u/maren"');
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
    for (const text of ['37.8T', '3,003', '+1.2T', '+146', '$21.4M', '12.6B']) expect(html).toContain(`>${text}<`);
    expect(html).toContain('↑ 14% vs last week');
    expect(html).toContain('Claude Code <b>61%</b>');
    expect(html).toContain('Other <b>1.8%</b>');
    expect(html).toMatch(/<path d="M4,[^"]+ L512 158 L4 158 Z"/);
    expect(html).toContain('Community tokens per day');
  });
  it('draws the last 12 months as a running total, with the median builder, where the server sends them', () => {
    const monthly = Array.from({ length: 12 }, (_, index) => ({ month: new Date(Date.UTC(2025, 10 + index, 1)).toISOString().slice(0, 7), tokens: 2e12 }));
    const html = markup(<CommunityHero stats={{ ...stats, monthly, medianTokens: 1.9e9 }} />);
    expect(html).toContain('Community tokens, cumulative');
    expect(html).toContain('Last 12 months');
    expect(html).toContain('median 1.9B');
    expect([...html.matchAll(/<text class="axis" x="[\d.]+" y="180"[^>]*>([^<]+)<\/text>/g)].map((match) => match[1])).toEqual(['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
  });
});

describe('your position', () => {
  it('shows your rank, the gap to the next and your week and month ranks', () => {
    const mine = profile('example-builder', 42, 18.4e9, { costMicrousd: 6_412e6 });
    const html = markup(<YouStrip mine={mine} gap={{ ahead: profile('yuki', 41, 19.7e9), tokens: 1.3e9 }} builders={3003} onProfile={() => {}}
      periods={{ week: { rank: 17, tokens: 1, builders: 1 }, month: { rank: 29, tokens: 1, builders: 1 }, all: { rank: 42, tokens: 1, builders: 1 } }} />);
    for (const text of ['#42', 'example-builder · Top 2%', '>18.4B<', '>$6.4K<', '<b>1.3B</b> behind #41 yuki', '>93%<', 'Week <b>#17</b>', 'Month <b>#29</b>']) expect(html).toContain(text);
  });
  it('invites you to join before you are on the board', () => {
    expect(markup(<JoinStrip onJoin={() => {}} />)).toContain('Join the leaderboard');
  });
});
