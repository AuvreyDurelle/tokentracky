import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CostParts, TokenCounts, UsageBreakdownRow, UsageSummary } from '@tokentracky/core';
import { dayRange, fillRange, previousLabel, previousRange, rangeLabel, rangeLength } from './ranges';
import { Heatmap, heatLevels } from './Heatmap';
import { costGroups } from './Insights';
import { TrendChart } from './TrendChart';
import { TokenTypes } from './You';
import { formatCostCompact, timeUntil } from './format';

const now = new Date('2026-10-23T15:00:00.000Z');

describe('dashboard ranges', () => {
  it('turns presets into inclusive UTC days ending today', () => {
    expect(dayRange({ preset: 'today' }, now)).toEqual({ from: '2026-10-23', to: '2026-10-23' });
    expect(dayRange({ preset: 7 }, now)).toEqual({ from: '2026-10-17', to: '2026-10-23' });
    expect(dayRange({ preset: 365 }, now)).toEqual({ from: '2025-10-24', to: '2026-10-23' });
    expect(dayRange({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' }, now)).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect([rangeLabel({ preset: 'today' }), rangeLabel({ preset: 30 }), rangeLabel({ preset: 365 })]).toEqual(['today', 'last 30 days', 'last 12 months']);
  });
  it('compares each period with the equally long span just before it', () => {
    expect(previousRange(dayRange({ preset: 'today' }, now))).toEqual({ from: '2026-10-22', to: '2026-10-22' });
    expect(previousRange(dayRange({ preset: 7 }, now))).toEqual({ from: '2026-10-10', to: '2026-10-16' });
    expect(previousRange({ from: '2024-03-01', to: '2024-03-31' })).toEqual({ from: '2024-01-30', to: '2024-02-29' });
    expect(rangeLength(dayRange({ preset: 365 }, now))).toBe(365);
    expect([previousLabel({ preset: 'today' }, dayRange({ preset: 'today' }, now)), previousLabel({ preset: 30 }, dayRange({ preset: 30 }, now)), previousLabel({ preset: 365 }, dayRange({ preset: 365 }, now))])
      .toEqual(['vs yesterday', 'vs previous 30 days', 'vs previous 12 months']);
    expect(previousLabel({ preset: 'custom', from: '2026-10-01', to: '2026-10-01' }, { from: '2026-10-01', to: '2026-10-01' })).toBe('vs previous day');
  });
  it('fills every day in the span, including across a leap day', () => {
    expect(fillRange([{ day: '2024-02-29', tokens: 5 }], { from: '2024-02-28', to: '2024-03-01' })).toEqual([{ day: '2024-02-28', tokens: 0 }, { day: '2024-02-29', tokens: 5 }, { day: '2024-03-01', tokens: 0 }]);
  });
});

describe('activity heatmap', () => {
  it('bins active days by quartile and keeps empty days at zero', () => {
    expect(heatLevels([0, 1, 2, 3, 4, 0])).toEqual([0, 1, 2, 3, 4, 0]);
    expect(heatLevels([0, 0])).toEqual([0, 0]);
    expect(heatLevels([7, 7, 7])).toEqual([1, 1, 1]);
    // One huge day takes the top bin without flattening the rest.
    expect(heatLevels([10, 20, 30, 1_000_000])).toEqual([1, 2, 3, 4]);
  });
  it('lays out Monday-first weeks and lists every active day in the table view', () => {
    // 2026-10-21 is a Wednesday: two padding cells precede it.
    const html = renderToStaticMarkup(<Heatmap days={[{ day: '2026-10-21', tokens: 0 }, { day: '2026-10-22', tokens: 40 }, { day: '2026-10-23', tokens: 10 }]} label="Tokens" />);
    expect(html.match(/class="pad"/g)).toHaveLength(2);
    expect(html).toContain('2 days with usage');
    expect(html).toContain('<td>2026-10-22</td><td>40</td>');
    expect(html).not.toContain('<td>2026-10-21</td>');
  });
});

describe('cost analysis', () => {
  const row = (day: string, tool: UsageBreakdownRow['tool'], model: string, tokens: number, costMicrousd: number | null): UsageBreakdownRow => ({ day, tool, model, tokens, breakdown: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costMicrousd });
  it('sums known cost, keeps unpriced tokens apart and orders by cost', () => {
    const rows = [row('2026-10-22', 'claude', 'claude-sonnet-4-6', 1_000, 3_000), row('2026-10-23', 'claude', 'claude-sonnet-4-6', 500, 1_500), row('2026-10-23', 'codex', 'gpt-5-codex', 2_000, 4_000), row('2026-10-23', 'codex', 'mystery', 900, null)];
    expect(costGroups(rows, (item) => item.model)).toEqual([
      { key: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', tokens: 1_500, cost: 4_500, unpriced: 0 },
      { key: 'gpt-5-codex', label: 'gpt-5-codex', tokens: 2_000, cost: 4_000, unpriced: 0 },
      { key: 'mystery', label: 'mystery', tokens: 900, cost: 0, unpriced: 900 },
    ]);
    expect(costGroups(rows, (item) => item.tool).map((group) => [group.key, group.cost, group.unpriced])).toEqual([['codex', 4_000, 900], ['claude', 4_500, 0]].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(costGroups(rows, (item) => item.day).map((group) => [group.key, group.cost])).toEqual([['2026-10-23', 5_500], ['2026-10-22', 3_000]]);
  });
  it('formats compact cost and refresh countdowns', () => {
    expect([formatCostCompact(420_000), formatCostCompact(4_200_000), formatCostCompact(1_234_000_000)]).toEqual(['$0.42', '$4.2', '$1.2K']);
    expect(timeUntil('2026-10-23T15:20:00.000Z', now.getTime())).toBe('in 20m');
    expect(timeUntil(null)).toBe('not scheduled');
  });
});

describe('token types', () => {
  const total = (counts: TokenCounts) => counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
  const summary = (breakdown: TokenCounts, costParts: CostParts | null, daily: UsageSummary['daily'] = []): UsageSummary => ({
    tokens: total(breakdown), breakdown, costMicrousd: costParts && costParts.input + costParts.output + costParts.cacheRead + costParts.cacheWrite, costParts, sessions: 1, cacheRate: 0,
    activity: { activeDays: 0, currentStreak: 0, longestStreak: 0, bestDay: null, averagePerActiveDay: 0 }, byTool: [], byModel: [], daily,
  });
  // Reasoning (30) is inside output (50); counting it again would make 1,030.
  const counts: TokenCounts = { input: 100, output: 50, cacheRead: 800, cacheWrite: 50, reasoning: 30 };
  const parts: CostParts = { input: 300_000, output: 750_000, cacheRead: 240_000, cacheWrite: 187_500, cacheSavings: 2_160_000 };
  const card = (value: UsageSummary, compare: UsageSummary | null = null) => renderToStaticMarkup(<TokenTypes summary={value} compare={compare} versus="vs previous 7 days" />);

  it('gives each kind a share of the total, and the shares add up', () => {
    const html = card(summary(counts, parts));
    const shares = [...html.matchAll(/<small>([\d.]+)% of tokens<\/small>/g)].map((match) => Number(match[1]));
    expect(shares).toEqual([10, 5, 80, 5]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
    const widths = [...html.matchAll(/width:([\d.]+)%/g)].map((match) => Number(match[1]));
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100);
    expect(html).toContain('aria-label="Input 10%, Output 5.0%, Cache read 80%, Cache write 5.0%"');
  });
  it('shows reasoning inside output and never adds it to the total', () => {
    const html = card(summary(counts, parts));
    expect(html).toContain('Share of 1,000 tokens');
    expect(html).not.toContain('1,030');
    const output = html.slice(html.indexOf('Output</dt>'), html.indexOf('Cache read</dt>'));
    expect(output).toContain('<dd title="50 tokens">50</dd>');
    expect(output).toContain('Of which reasoning 30');
    expect(html.match(/Of which reasoning/g)).toHaveLength(1);
    // Absent reasoning reads as none, not as a missing kind.
    expect(card(summary({ ...counts, reasoning: undefined }, parts))).toContain('Of which reasoning 0');
  });
  it('compares each kind with the previous period', () => {
    const html = card(summary(counts, parts), summary({ input: 50, output: 50, cacheRead: 0, cacheWrite: 100 }, parts));
    expect(html).toContain('<span class="delta">↑ 100%</span> vs previous 7 days');
    expect(html).toContain('<span class="delta">± 0.0%</span> vs previous 7 days');
    expect(html).toContain('<span class="delta">New</span> vs previous 7 days');
    expect(html).toContain('<span class="delta">↓ 50%</span> vs previous 7 days');
    expect(card(summary(counts, parts))).not.toContain('vs previous');
  });
  it('estimates cost by kind and the cache savings, or says the cost is unknown', () => {
    const known = card(summary(counts, parts));
    expect([...known.matchAll(/<small>Est\. ([^<]+)<\/small>/g)].map((match) => match[1])).toEqual(['$0.30', '$0.75', '$0.24', '$0.19']);
    expect(known).toContain('Cache reads saved $2.16');
    const unknown = card(summary(counts, null));
    expect(unknown).toContain('Cost by type is unknown');
    expect(unknown).not.toContain('$');
    expect(unknown).not.toContain('Est.');
  });
  it('keeps the total chart as it was when no stacks are given', () => {
    const html = renderToStaticMarkup(<TrendChart points={[{ day: '2026-10-22', tokens: 4 }, { day: '2026-10-23', tokens: 6 }]} label="Tokens" />);
    expect(html).toContain('trend-area');
    expect(html).toContain('trend-line');
    expect(html).not.toContain('trend-layer');
    expect(html).toContain('<th>Day</th><th>Value</th></tr>');
  });
});
