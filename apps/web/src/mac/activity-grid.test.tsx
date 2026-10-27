import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { activityStats } from '@tokentracky/core';
import { addDays } from '../ranges';
import { ActivityGrid, nextDay } from './ActivityGrid';

// A year ending on Sunday 2026-10-25, quiet every third day; the last day is the busiest.
const days = Array.from({ length: 365 }, (_, index) => ({ day: addDays('2025-10-26', index), tokens: index % 3 ? (index + 1) * 1_000_000 : 0 }));
const stats = activityStats(days, '2026-10-25');

describe('ActivityGrid', () => {
  const html = renderToStaticMarkup(<ActivityGrid days={days} stats={stats} label="Activity, last 12 months" />);
  const cells = [...html.matchAll(/<rect x="(\d+)" y="(\d+)"[^>]*class="h(\d)"/g)];

  it('draws one Monday-first column per week, with weekday and month labels', () => {
    expect(cells).toHaveLength(365);
    expect(new Set(cells.map((cell) => cell[1])).size).toBe(53);
    // 2025-10-26 is a Sunday: the bottom row of the first column.
    expect(cells[0]!.slice(1, 3)).toEqual(['34', '136']);
    for (const label of ['Mon', 'Wed', 'Fri', 'Nov', 'Oct', 'Less', 'More']) expect(html).toContain(`>${label}<`);
  });
  it('shades quiet days at zero and the busiest day at the top level', () => {
    expect(cells[0]![3]).toBe('0');
    expect(cells.at(-1)![3]).toBe('4');
    expect(new Set(cells.map((cell) => cell[3]))).toEqual(new Set(['0', '1', '2', '3', '4']));
  });
  it('sums the year up in compact tokens', () => {
    for (const label of ['Active days', 'Current streak', 'Longest streak', 'Best day', 'Average per active day']) expect(html).toContain(label);
    expect(html).toContain('<div class="label">Active days</div><div class="stat-value">243</div>');
    expect(html).toMatch(/<div class="label">Best day<\/div><div class="stat-value" title="365,000,000 tokens">365M <small>/);
    expect(html).toContain('<div class="label">Average per active day</div><div class="stat-value" title="183,251,029 tokens">183.3M</div>');
  });
  it('is readable without a pointer', () => {
    // A widget role, so screen readers pass the arrow keys through instead of keeping them for browsing.
    expect(html).toMatch(/<svg [^>]*role="application"[^>]*tabindex="0"[^>]*aria-label="Activity, last 12 months\. Use arrow keys to read each day\."/);
    expect(html).toMatch(/role="status">[\s\S]*<table class="sr-only"><caption>Activity, last 12 months: 243 days with usage/);
  });
});

describe('nextDay', () => {
  it('moves a week sideways and a day up or down, within the year', () => {
    expect([nextDay(10, 'ArrowLeft', 364), nextDay(10, 'ArrowRight', 364), nextDay(10, 'ArrowUp', 364), nextDay(10, 'ArrowDown', 364)]).toEqual([3, 17, 9, 11]);
    expect([nextDay(3, 'ArrowLeft', 364), nextDay(0, 'ArrowUp', 364), nextDay(360, 'ArrowRight', 364), nextDay(364, 'ArrowDown', 364)]).toEqual([0, 0, 364, 364]);
  });
  it('jumps to either end, starts from the last day, and ignores other keys', () => {
    expect([nextDay(100, 'Home', 364), nextDay(100, 'End', 364)]).toEqual([0, 364]);
    expect(nextDay(null, 'ArrowUp', 364)).toBe(363);
    for (const key of ['Enter', 'a', 'Tab', 'constructor']) expect(nextDay(100, key, 364)).toBeNull();
  });
});
