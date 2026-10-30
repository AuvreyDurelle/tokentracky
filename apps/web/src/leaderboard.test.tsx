import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicProfile } from '@tokentracky/core';
import { CommunityTypes, PodiumCard, ghostSlot, mergeRows, resetText, weekOverWeek } from './Leaderboard';
import { utcHourSpan } from './format';

const builder = (rank: number, daily = Array<number>(14).fill(0)): PublicProfile => ({ alias: `builder-${rank}`, rank, tokens: 1000 - rank, previousRank: rank, daily });
// Wednesday: three days of this week so far.
const wednesday = new Date('2026-10-21T12:00:00Z');

describe('week over week', () => {
  it('compares this week so far with the same weekdays last week', () => {
    const daily = [0, 0, 0, 0, 10, 10, 20, 0, 0, 0, 0, 15, 15, 30];
    expect(weekOverWeek(daily, wednesday)).toBe(0.5);
  });
  it('has nothing to compare when last week was empty or the series is short', () => {
    expect(weekOverWeek([...Array<number>(11).fill(0), 5, 5, 5], wednesday)).toBeNull();
    expect(weekOverWeek([1, 2, 3], wednesday)).toBeNull();
  });
  it('appears on the podium only for the week', () => {
    const item = builder(1, [0, 0, 0, 0, 10, 10, 20, 0, 0, 0, 0, 15, 15, 30]);
    const card = (period: 'week' | 'month' | 'all') => renderToStaticMarkup(<PodiumCard item={item} above={null} next={builder(2)} period={period} rankBy="all" mine={false} end="2026-10-21T12:00:00Z" onProfile={() => {}} now={wednesday} />);
    expect(card('week')).toContain('vs same days last week');
    expect(card('month')).not.toContain('last week');
    expect(card('all')).not.toContain('last week');
  });
});

describe('the last 24 hours', () => {
  it('moves on at the next whole hour, while the week resets on Monday', () => {
    expect(resetText('24h', '2026-10-22T12:00:00.000Z', Date.parse('2026-10-23T12:28:00Z'))).toEqual({ window: 'Last 24 hours', verb: 'updates', left: '32m' });
    expect(resetText('week', '2026-10-19T00:00:00.000Z', Date.parse('2026-10-24T20:00:00Z'))).toMatchObject({ verb: 'resets', left: '1d 4h' });
    expect(resetText('all', null)).toBeNull();
  });
  it('shows the podium hour by hour, with the lifetime in place of a cost', () => {
    const item = { ...builder(1), previousRank: null, costMicrousd: null, lifetimeTokens: 14_800_000_000, hourly: [5, ...Array<number>(22).fill(0), 9] };
    const card = renderToStaticMarkup(<PodiumCard item={item} above={null} next={builder(2)} period="24h" rankBy="all" mine={false} end="2026-10-23T12:28:00Z" onProfile={() => {}} />);
    expect(card).toContain('tokens in the last 24 hours');
    expect(card).toContain('14.8B lifetime');
    expect(card).toContain('Last 24 hours: 14 tokens over 2 active hours');
    expect(card).toContain(`title="${utcHourSpan('2026-10-22T12:00:00.000Z')}: 5 tokens"`);
    expect(card).toContain(`title="${utcHourSpan('2026-10-23T11:00:00.000Z')}: 9 tokens"`);
    expect(card).not.toContain(' est.');
  });
});

describe('ghost row', () => {
  const rows = [4, 5, 6, 7, 8, 9, 10, 11].map((rank) => builder(rank));
  it('sits after rank 9 for a visitor, or at the end of a shorter page', () => {
    expect(ghostSlot(rows, null)).toBe(6);
    expect(ghostSlot(rows.slice(0, 3), null)).toBe(3);
  });
  it('is hidden for members', () => {
    expect(ghostSlot(rows, 'token-wizard')).toBeNull();
  });
});

describe('loading more builders', () => {
  it('appends later pages in order', () => {
    expect(mergeRows([builder(1), builder(2)], [[builder(3)], [builder(4)]]).map((item) => item.rank)).toEqual([1, 2, 3, 4]);
  });
  it('skips a builder already listed when rankings moved between loads', () => {
    expect(mergeRows([builder(1), builder(2)], [[builder(2), builder(3)]]).map((item) => item.alias)).toEqual(['builder-1', 'builder-2', 'builder-3']);
  });
});

describe('community token types', () => {
  it('shows every type, with reasoning inside output', () => {
    const html = renderToStaticMarkup(<CommunityTypes breakdown={{ input: 1_000, output: 400, cacheRead: 8_000, cacheWrite: 600, reasoning: 150 }} />);
    expect(html.replace(/<[^>]+>/g, '')).toBe('1K input · 400 output (150 reasoning) · 8K cache read · 600 cache write');
    expect(html).toContain('title="8,000 tokens · 80%"');
  });
});
