import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api';
import { JUMP_KEYS } from '../ui';
import { MacShell, Sidebar, todayOf } from './Shell';

// The current-page button is Tokens itself: one icon, then the label.
const NONE = { breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costParts: null };
const CURRENT_TOKENS = /<button [^>]*aria-current="page"[^>]*><svg(?:(?!<\/svg>)[\s\S])*<\/svg>Tokens<\/button>/;

describe('Sidebar', () => {
  it('marks the current page and shows today compactly', () => {
    const html = renderToStaticMarkup(<Sidebar page="tokens" go={() => {}} today={{ tokens: 186_400_000, costMicrousd: 64_800_000, spark: [1, 2, 3] }} tracking="collecting" syncedAt={null} me="example-builder" rank={42} />);
    expect(html).toMatch(CURRENT_TOKENS);
    expect(html.match(/aria-current/g)).toHaveLength(1);
    for (const label of ['Leaderboard', 'Tokens', 'Achievements', 'Settings']) expect(html).toContain(label);
    expect(html).toContain('186.4M');
    expect(html).toContain('$64.80');
    expect(html).toContain('#42 all time');
    expect(html).toContain('Collecting');
  });
  it('says when tracking is off or paused, and when you have not joined', () => {
    const off = renderToStaticMarkup(<Sidebar page="you" go={() => {}} today={null} tracking="off" syncedAt={null} me={null} rank={null} />);
    expect(off).toMatch(CURRENT_TOKENS);
    expect(off).toContain('Not tracking');
    expect(off).toContain('Not on the leaderboard');
    const paused = renderToStaticMarkup(<Sidebar page="leaderboard" go={() => {}} today={null} tracking="paused" syncedAt={null} me="example-builder" rank={null} />);
    expect(paused).toContain('Paused');
    expect(paused).not.toContain('all time');
  });
  it('keeps Leaderboard current while a profile is open over it', () => {
    const html = renderToStaticMarkup(<Sidebar page="profile" go={() => {}} today={null} tracking="off" syncedAt={null} me={null} rank={null} />);
    expect(html).toMatch(/<button [^>]*aria-current="page"[^>]*><svg(?:(?!<\/svg>)[\s\S])*<\/svg>Leaderboard<\/button>/);
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });
  it('keeps Settings in a navigation landmark of its own', () => {
    const html = renderToStaticMarkup(<Sidebar page="settings" go={() => {}} today={null} tracking="off" syncedAt={null} me={null} rank={null} />);
    expect(html).toMatch(/<nav [^>]*aria-label="Preferences"[^>]*><button [^>]*aria-current="page"[^>]*><svg(?:(?!<\/svg>)[\s\S])*<\/svg>Settings<\/button>/);
  });
});

describe('MacShell', () => {
  // Effects do not run in a static render, so the client is never called.
  const shell = (page: 'join' | 'missing' | 'profile') => renderToStaticMarkup(<MacShell api={{} as ApiClient} status={null} me={null} page={page} path={`/${page}`} go={() => {}} onPalette={() => {}}><p>page</p></MacShell>);
  it('titles every page it can show, with the jump shortcut beside it', () => {
    expect(shell('join')).toContain('<span class="toolbar-title">How it works</span>');
    expect(shell('missing')).toContain('<span class="toolbar-title">Page not found</span>');
    expect(shell('join')).toContain(`<span class="kbd">${JUMP_KEYS}</span>`);
    // A profile opens over the leaderboard.
    expect(shell('profile')).toContain('<span class="toolbar-title">Leaderboard</span>');
  });
});

describe('todayOf', () => {
  it("reads today's UTC day and the last 14 days, quiet days as zero", () => {
    const now = new Date('2026-10-25T09:00:00Z');
    const today = todayOf([{ day: '2026-10-11', tokens: 9, costMicrousd: 1, ...NONE }, { day: '2026-10-12', tokens: 5, costMicrousd: 1, ...NONE }, { day: '2026-10-25', tokens: 7, costMicrousd: 3, ...NONE }], now);
    expect(today).toEqual({ tokens: 7, costMicrousd: 3, spark: [5, ...new Array<number>(12).fill(0), 7] });
    expect(todayOf([{ day: '2026-10-24', tokens: 4, costMicrousd: null, ...NONE }], now)).toMatchObject({ tokens: 0, costMicrousd: 0 });
  });
});
