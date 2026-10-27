import { describe, expect, it, vi } from 'vitest';
import { parseRoute, routePath, takeLinkTag } from './route';
import { toolColumns, TOOL_COLUMNS } from './columns';
import { TOOL_IDS, TOOL_NAMES, type ToolId, type ProfileStats } from '@tokentracky/core';
import { badgeMarkdown, fitFacts, ProfileView, ProfileTypes, windowActivity, xShareUrl } from './Profile';
import { runningTotals } from './ProfileUsage';
import { TOOLS, toolLabel, topPercent } from './format';
import { renderToStaticMarkup } from 'react-dom/server';
import { Join } from './Join';

describe('shareable addresses', () => {
  it('parses home, leaderboard, join, you and profile paths', () => {
    expect(parseRoute('/')).toEqual({ page: 'home' });
    expect(parseRoute('/leaderboard/')).toEqual({ page: 'leaderboard' });
    expect(parseRoute('/join')).toEqual({ page: 'join' });
    expect(routePath({ page: 'join' })).toBe('/join');
    expect(parseRoute('/you')).toEqual({ page: 'you' });
    expect(parseRoute('/u/Token-Wizard')).toEqual({ page: 'profile', alias: 'token-wizard' });
    for (const path of ['/u/x', '/u/a/b', '/u/-bad', '/nope']) expect(parseRoute(path), path).toEqual({ page: 'missing' });
    expect(routePath({ page: 'profile', alias: 'token-wizard' })).toBe('/u/token-wizard');
    expect(routePath({ page: 'home' })).toBe('/');
  });
});

describe('leaderboard columns', () => {
  it('gives the four largest shared tools a column, largest first', () => {
    const ids = TOOLS.slice(0, 6).map((tool) => tool.id);
    // Community totals grow down the list, so the last four are the largest.
    const totals = Object.fromEntries(ids.map((id, index) => [id, (index + 1) * 1_000])) as Partial<Record<ToolId, number>>;
    expect(TOOL_COLUMNS).toBe(4);
    expect(toolColumns(totals, 'all')).toEqual(ids.slice(2).reverse());
  });
  it('keeps a column for the tool being ranked by, still four in all', () => {
    const ids = TOOLS.slice(0, 6).map((tool) => tool.id);
    const totals = Object.fromEntries(ids.map((id, index) => [id, 100 - index])) as Partial<Record<ToolId, number>>;
    expect(toolColumns(totals, ids[5]!)).toEqual([ids[0], ids[1], ids[2], ids[5]]);
    expect(toolColumns(totals, ids[1]!)).toEqual(ids.slice(0, 4));
  });
  it('shows Claude Code and Codex until someone shares a tool', () => {
    expect(toolColumns({}, 'all')).toEqual(['claude', 'codex']);
    expect(toolColumns({ gemini: 5, codex: 9 }, 'all')).toEqual(['codex', 'gemini']);
  });
});

describe('profile sharing', () => {
  it('links a README badge to the profile page', () => {
    expect(badgeMarkdown('https://tokentracky.vercel.app', 'token-wizard')).toBe('[![Tokentracky](https://tokentracky.vercel.app/badge/token-wizard.svg)](https://tokentracky.vercel.app/u/token-wizard?ref=readme)');
  });
  it('splits all-time tokens by type with shares, reasoning inside output and never added', () => {
    const html = renderToStaticMarkup(<ProfileTypes breakdown={{ input: 100, output: 50, cacheRead: 800, cacheWrite: 50, reasoning: 30 }} />);
    expect(html).toContain('share of 1,000 tokens');
    for (const [label, share] of [['Input', '10%'], ['Output', '5.0%'], ['Cache read', '80%'], ['Cache write', '5.0%']]) expect(html).toMatch(new RegExp(`${label}</dt><dd[^>]*>[^<]+</dd><small>${share.replace('.', '\\.')} of tokens`));
    expect(html).toContain('Of which reasoning 30');
    expect(html).not.toContain('Reasoning</dt>');
  });
  it('lists every tool the collector reads, and not Cursor', () => {
    expect(TOOLS.map((tool) => tool.id)).toEqual(TOOL_IDS.filter((id) => id !== 'cursor'));
    expect(TOOLS).toHaveLength(29);
    expect(TOOLS.map((tool) => tool.label)).toEqual(TOOLS.map((tool) => TOOL_NAMES[tool.id]));
    expect(toolLabel('opencode')).toBe('OpenCode');
  });
});

describe('sharing links', () => {
  it('counts a share or README arrival once and always clears the tag', () => {
    const replaced: string[] = [];
    const history = { replaceState: (_: unknown, __: string, url: string) => { replaced.push(url); } };
    expect(takeLinkTag({ href: 'https://tokentracky.test/u/marenh?ref=share' }, history)).toBe('share');
    expect(takeLinkTag({ href: 'https://tokentracky.test/u/marenh?ref=readme&x=1#top' }, history)).toBe('readme');
    expect(takeLinkTag({ href: 'https://tokentracky.test/u/marenh?ref=twitter' }, history)).toBeNull();
    expect(replaced).toEqual(['/u/marenh', '/u/marenh?x=1#top', '/u/marenh']);
    expect(takeLinkTag({ href: 'https://tokentracky.test/u/marenh' }, history)).toBeNull();
    expect(replaced).toHaveLength(3);
  });
});

describe('top N%', () => {
  it('rounds up and shows only in the top half', () => {
    expect(topPercent(1, 200)).toBe('Top 1%');
    expect(topPercent(3, 300)).toBe('Top 1%');
    expect(topPercent(4, 300)).toBe('Top 2%');
    expect(topPercent(42, 2100)).toBe('Top 2%');
    expect(topPercent(1, 1)).toBeNull();
    expect(topPercent(1, 2)).toBe('Top 50%');
    expect(topPercent(51, 100)).toBeNull();
    expect(topPercent(1, 0)).toBeNull();
    expect(topPercent(5, 0)).toBeNull();
    expect(topPercent(150, 300)).toBe('Top 50%');
    expect(topPercent(151, 300)).toBeNull();
  });
});

describe('public profile', () => {
  const stats: ProfileStats = {
    alias: 'marenh', likes: 0, memberSince: '2026-01-01', badges: [], periods: { week: { rank: 3, tokens: 2_000, builders: 40 }, month: { rank: 2, tokens: 9_000, builders: 60 }, all: { rank: 1, tokens: 1_100_000, builders: 200 } },
    daily: [{ day: '2026-10-24', tokens: 400 }, { day: '2026-10-25', tokens: 600 }],
    activity: { activeDays: 2, currentStreak: 2, longestStreak: 2, bestDay: { day: '2026-10-25', tokens: 600 }, averagePerActiveDay: 500 },
    toolTokens: { claude: 800_000, codex: 300_000 }, costMicrousd: 12_340_000, models: [{ model: 'claude-opus-5-5', tokens: 900_000, costMicrousd: 10_000_000 }, { model: 'gpt-6.1', tokens: 200_000, costMicrousd: 2_340_000 }],
  };
  const join = { label: 'Join the board', onClick: () => {} };
  const view = (me: string | null) => renderToStaticMarkup(<ProfileView stats={stats} me={me} origin="https://tokentracky.test" join={me ? null : join} onLeaderboard={() => {}} />);
  it('shows identity, stats, highlights, tool mix and top models, and the share card with the badge', () => {
    const html = view(null);
    expect(html).toContain('#1 All time');
    expect(html).toContain('Top 1%');
    expect(html).toContain('Current streak');
    expect(html).toContain('best ever');
    expect(html).toContain('Favourite · 2 models used');
    expect(html).toContain('claude-opus-5-5');
    expect(html).toContain('Share this profile');
    expect(html).toContain(badgeMarkdown('https://tokentracky.test', 'marenh').replaceAll('&', '&amp;'));
  });
  it('posts to X with the chosen window and the tagged profile link', () => {
    const url = new URL(xShareUrl(stats, 'https://tokentracky.test', 'week'));
    expect(url.origin + url.pathname).toBe('https://x.com/intent/post');
    expect(url.searchParams.get('text')).toBe('marenh is #3 on the Tokentracky leaderboard this week, with 2K tokens.');
    expect(url.searchParams.get('url')).toBe('https://tokentracky.test/u/marenh?ref=share');
  });
  it('offers the join card to a viewer who has not joined, and hides it from a joined one', () => {
    expect(view(null)).toContain('Think you can catch marenh?');
    const joined = view('someone');
    expect(joined).not.toContain('Think you can catch');
    expect(joined).toContain('Share this profile');
  });
  it('shows member since, the GitHub login, likes and every badge with its tier, but no real name or last active', () => {
    const html = renderToStaticMarkup(<ProfileView stats={{ ...stats, likes: 14, githubLogin: 'maren-h', badges: [{ id: 'token-titan', tier: 2, value: 1_100_000, next: 10_000_000 }, { id: 'podium', tier: 0, value: 0, next: 10 }] }}
      me={null} origin={null} join={null} onLeaderboard={() => {}} />);
    expect(html).toContain('Member since');
    expect(html).toContain('href="https://github.com/maren-h"');
    expect(html).toContain('>14</b>');
    expect(html).toContain('1 of 2 earned');
    expect(html).toContain('Token Titan');
    expect(html).toContain('Silver');
    expect(html).not.toMatch(/Active \d/);
  });
  it('offers a like button only when the viewer can like, with its state', () => {
    const likeable = renderToStaticMarkup(<ProfileView stats={stats} me={null} origin={null} join={null} onLeaderboard={() => {}} likes={3} like={{ liked: true, pending: false }} />);
    expect(likeable).toMatch(/<button[^>]*aria-pressed="true"[^>]*>.*Like marenh/);
    expect(view(null)).not.toContain('Like marenh');
  });
  it('lists six models until Show all', () => {
    const models = Array.from({ length: 8 }, (_, index) => ({ model: `model-${index}`, tokens: 1_000 - index }));
    const html = renderToStaticMarkup(<ProfileView stats={{ ...stats, models }} me={null} origin={null} join={null} onLeaderboard={() => {}} />);
    expect(html).toContain('model-5');
    expect(html).not.toContain('model-6');
    expect(html).toContain('Show all 8 models');
    expect(view(null)).not.toContain('Show all');
  });
  it('counts the share card window’s own active days and longest run, not the year’s', () => {
    const daily = [{ day: '2026-10-19', tokens: 5 }, { day: '2026-10-20', tokens: 0 }, { day: '2026-10-21', tokens: 3 }, { day: '2026-10-22', tokens: 4 }, { day: '2026-10-23', tokens: 0 }, { day: '2026-10-24', tokens: 1 }];
    expect(windowActivity(daily, '2026-10-21')).toEqual({ activeDays: 3, longestStreak: 2 });
    expect(windowActivity(daily, '2026-10-01')).toEqual({ activeDays: 4, longestStreak: 2 });
    expect(windowActivity(daily, '2026-10-25')).toEqual({ activeDays: 0, longestStreak: 0 });
  });
  it('turns daily tokens into a running total for the cumulative chart', () => {
    expect(runningTotals([{ day: '2026-10-24', tokens: 400 }, { day: '2026-10-25', tokens: 0 }, { day: '2026-10-26', tokens: 600 }]))
      .toEqual([{ day: '2026-10-24', tokens: 400 }, { day: '2026-10-25', tokens: 400 }, { day: '2026-10-26', tokens: 1_000 }]);
    expect(runningTotals([])).toEqual([]);
  });
  it('drops the share card’s trailing facts until the line fits, keeping at least the first', () => {
    const facts = ['tokens this month', '3 active days', 'favourite claude-opus-5-5'];
    expect(fitFacts(facts, (text) => text.length <= 80)).toBe('tokens this month · 3 active days · favourite claude-opus-5-5');
    expect(fitFacts(facts, (text) => text.length <= 40)).toBe('tokens this month · 3 active days');
    expect(fitFacts(facts, () => false)).toBe('tokens this month');
  });
});

describe('join page', () => {
  it('lists every tool the collector reads, marks Cursor as not yet, and says what becomes public', () => {
    const html = renderToStaticMarkup(<Join onLeaderboard={() => {}} />);
    for (const tool of TOOLS) expect(html).toContain(tool.label);
    expect(html).toMatch(/Cursor <span class="badge plain">Not yet<\/span>/);
    expect(html).toContain('Public once you connect');
    expect(html).toContain('Delete your account');
  });

  it('carries the plain notice of what connecting publishes, with nothing to tick', () => {
    const html = renderToStaticMarkup(<Join onLeaderboard={() => {}} />);
    expect(html).toContain('Connecting puts your daily token totals, tool split, model mix and estimated cost on the public leaderboard. Delete your account to remove them.');
    expect(html).not.toMatch(/type="checkbox"|role="switch"/);
  });

  it('counts the tools and says the Mac app is coming soon while there is no download or npm launcher', () => {
    const html = renderToStaticMarkup(<Join onLeaderboard={() => {}} />);
    expect(html).not.toContain('npx tokentracky login');
    expect(html).toContain(`Works with ${TOOLS.length} AI coding tools`);
    // Without a download there is no button and no first-launch note.
    expect(html).toContain('Mac app coming soon');
    expect(html).not.toContain('Download for Mac');
    expect(html).not.toContain('class="first-launch"');
  });

  it('puts the Open Anyway step in the install card after the download button', async () => {
    vi.resetModules();
    vi.doMock('./download-config', async (original) => ({ ...await original<typeof import('./download-config')>(), MAC_DOWNLOAD: 'https://example.test/Tokentracky.dmg' }));
    try {
      const { Join: WithDownload } = await import('./Join');
      const html = renderToStaticMarkup(<WithDownload onLeaderboard={() => {}} />);
      expect(html).toContain('href="https://example.test/Tokentracky.dmg"');
      expect(html).toMatch(/Download for Mac<\/a>.*<small class="first-launch">.*Privacy &amp; Security.*Open Anyway/);
      expect(html).not.toContain('Mac app coming soon');
      // Without the npm launcher there is no command to copy and no "or".
      expect(html).not.toContain('npx tokentracky login');
      expect(html).not.toContain('or install in one command');
    } finally {
      vi.doUnmock('./download-config');
      vi.resetModules();
    }
  });

  it('offers the npx command after the download once the npm launcher is on', async () => {
    vi.resetModules();
    vi.doMock('./download-config', async (original) => ({ ...await original<typeof import('./download-config')>(), MAC_DOWNLOAD: 'https://example.test/Tokentracky.dmg', INSTALL_COMMAND: 'npx tokentracky login' }));
    try {
      const { Join: WithBoth } = await import('./Join');
      const html = renderToStaticMarkup(<WithBoth onLeaderboard={() => {}} />);
      expect(html).toMatch(/Download for Mac<\/a>.*or install in one command.*npx tokentracky login.*<small class="first-launch">/);
    } finally {
      vi.doUnmock('./download-config');
      vi.resetModules();
    }
  });
});
