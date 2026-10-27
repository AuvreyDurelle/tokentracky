import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BADGE_IDS, badgeProgress, type AchievementRarity, type BadgeId } from '@tokentracky/core';
import { AchievementsBody } from './AchievementsView';

const markup = (element: ReactElement) => renderToStaticMarkup(element).replaceAll('<!-- -->', '');
const VALUES = { 'token-titan': 18.4e9, 'big-day': 412e6, marathoner: 214, streak: 34, 'weekend-warrior': 41, momentum: 520, veteran: 301, podium: 42, multitool: 5, polyglot: 14, trendsetter: 1 } as Record<BadgeId, number>;
const badges = BADGE_IDS.map((id) => badgeProgress(id, VALUES[id]));
const rarity: AchievementRarity = { builders: 1000, holders: Object.fromEntries(BADGE_IDS.map((id) => [id, [420, 120, 42, 3]])) };

describe('AchievementsBody', () => {
  it('sums up the badges earned and the tiers they sit at', () => {
    const html = markup(<AchievementsBody badges={badges} rarity={rarity} joined />);
    expect(html).toContain('<b class="num">10</b><span>of 11</span>');
    expect(html).toMatch(/Gold<\/span><div class="cat-bar"><span style="width:36\.\d+%"><\/span><\/div><span class="cat-num num">4/);
    expect(html).not.toContain('Just unlocked');
  });
  it('puts the three badges closest to their next tier up next', () => {
    const html = markup(<AchievementsBody badges={badges} rarity={rarity} joined />);
    const next = html.slice(html.indexOf('Up next'), html.indexOf('<h2>Volume'));
    expect([...next.matchAll(/<div class="next-name">([^<]+)/g)].map((match) => match[1])).toEqual(['Polyglot ', 'Momentum ', 'Multitool ']);
    expect(next).toContain('14 of 15 models');
    expect(next).toContain('93%');
  });
  it('shows every badge in its group with an emblem, its tiers, progress and rarity', () => {
    const html = markup(<AchievementsBody badges={badges} rarity={rarity} joined />);
    for (const title of ['Volume', 'Consistency', 'Growth', 'Range', 'Leaderboard']) expect(html).toContain(`<h2>${title}</h2>`);
    expect(html.match(/class="ach-card /g)).toHaveLength(11);
    expect(html).toContain('Token Titan');
    expect(html).toContain('18.4B · 81.6B to go');
    expect(html).toContain('title="Diamond: 100B"');
    // Gold token titan: 4.2% hold gold or better. Trendsetter has none, so it shows bronze's 42%.
    expect(html).toContain('4.2% of builders');
    expect(html).toContain('42% of builders');
  });
  it('says before joining that the badges are worked out on this Mac, and which need the board', () => {
    const html = markup(<AchievementsBody badges={badges.map((badge) => badge.id === 'podium' || badge.id === 'trendsetter' ? badgeProgress(badge.id, 0) : badge)} rarity={null} joined={false} />);
    expect(html).toContain('Worked out on this Mac');
    expect(html).toContain('only count once you join the leaderboard');
    expect(html.match(/Join the leaderboard to earn/g)).toHaveLength(2);
    expect(html).not.toContain('of builders');
  });
});
