import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClubPage, PublicProfile } from '@tokentracky/core';
import { ClubBoard } from './ClubsView';

/** Markup without the comments React puts between adjacent text. */
const markup = (element: ReactElement) => renderToStaticMarkup(element).replaceAll('<!-- -->', '');

const daily = Array.from({ length: 14 }, (_, index) => index * 10);
const profile = (alias: string, rank: number, tokens: number): PublicProfile => ({ alias, rank, tokens, previousRank: rank, daily });
const page = (items: PublicProfile[], number: number): ClubPage => ({
  club: { slug: 'night-owls', name: 'Night Owls', mark: 'bolt', visibility: 'public', members: 30, description: '', category: null, createdAt: '2026-11-01T00:00:00Z', owner: 'maren', league: true },
  membership: { role: 'member', hidden: false, onProfile: true },
  standing: null,
  week: { tokens: 9e9, previousTokens: 8e9, active: 20, perMember: 4.5e8, costMicrousd: null, last24hTokens: 1e9, toolTokens: {}, daily, activeToday: 12, median: 3e8, busiestHour: 14 },
  board: { items, total: 30, builders: 30, page: number, pageSize: 12, period: 'week', windowStart: null, updatedAt: '2026-11-22T12:00:00Z', totalTokens: 9e9, toolTotals: {}, totalCostMicrousd: null, trend: [] },
  invite: null,
  invited: false,
  challenge: { kind: 'tokens' },
});
const board = (items: PublicProfile[], number: number) => markup(<ClubBoard page={page(items, number)} me="orbitfox" period="week" number={number} loading={false} site={null} onPage={() => {}} onProfile={() => {}} />);

describe('ClubBoard', () => {
  it('claims no lead when the builder above you is on the page before', () => {
    // Rank 13 heads page 2 of 12 a page: rank 12 is not in these rows.
    const html = board([profile('orbitfox', 13, 3e9), profile('pallas', 14, 2e9)], 2);
    expect(html).not.toContain('You lead this board');
  });
  it('races the builder above you when they are on the page, and says when you lead', () => {
    expect(board([profile('pallas', 13, 4e9), profile('orbitfox', 14, 3e9)], 2)).toContain('Rival · the builder directly above you');
    expect(board([profile('orbitfox', 1, 4e9), profile('pallas', 2, 3e9)], 1)).toContain('You lead this board');
  });
});
