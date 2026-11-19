import { describe, expect, it } from 'vitest';
import { parseRoute, routePath } from './route';
import { fitFacts, TOOL_IDS, TOOL_NAMES, windowActivity } from '@tokentracky/core';
import { badgeMarkdown } from './mac/ShareMenu';
import { runningTotals } from './ProfileUsage';
import { TOOLS, toolLabel, topPercent } from './format';

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
    expect(parseRoute('/wrapped/Token-Wizard/2026-11')).toEqual({ page: 'wrapped', alias: 'token-wizard', period: '2026-11' });
    expect(parseRoute('/wrapped/token-wizard/2026')).toEqual({ page: 'wrapped', alias: 'token-wizard', period: '2026' });
    for (const path of ['/wrapped/token-wizard', '/wrapped/token-wizard/2026-13', '/wrapped/token-wizard/26', '/wrapped/x/2026']) expect(parseRoute(path), path).toEqual({ page: 'missing' });
    expect(routePath({ page: 'wrapped', alias: 'token-wizard', period: '2026-11' })).toBe('/wrapped/token-wizard/2026-11');
    expect(parseRoute('/vs/Alice/bob')).toEqual({ page: 'vs', a: 'alice', b: 'bob' });
    for (const path of ['/vs/alice', '/vs/alice/b', '/vs/alice/bob/c']) expect(parseRoute(path), path).toEqual({ page: 'missing' });
    expect(routePath({ page: 'vs', a: 'alice', b: 'bob' })).toBe('/vs/alice/bob');
  });
});

describe('profile sharing', () => {
  it('links a README badge to the profile page', () => {
    expect(badgeMarkdown('https://tokentracky.vercel.app', 'token-wizard')).toBe('[![Tokentracky](https://tokentracky.vercel.app/badge/token-wizard.svg)](https://tokentracky.vercel.app/u/token-wizard?ref=readme)');
  });
  it('lists every tool the collector reads, and not Cursor', () => {
    expect(TOOLS.map((tool) => tool.id)).toEqual(TOOL_IDS.filter((id) => id !== 'cursor'));
    expect(TOOLS).toHaveLength(29);
    expect(TOOLS.map((tool) => tool.label)).toEqual(TOOLS.map((tool) => TOOL_NAMES[tool.id]));
    expect(toolLabel('opencode')).toBe('OpenCode');
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

describe('profile helpers', () => {
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
