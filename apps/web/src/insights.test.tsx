import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TokenCounts, UsageBreakdownRow } from '@tokentracky/core';
import { dayRange, fillRange, previousLabel, previousRange, rangeLabel, rangeLength } from './ranges';
import { Heatmap, heatLevels } from './Heatmap';
import { costGroups } from './Insights';
import { TrendChart, stackTops } from './TrendChart';
import { kindStacks } from './You';
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
  // Reasoning (30) is inside output (50); counting it again would make 1,030.
  const counts: TokenCounts = { input: 100, output: 50, cacheRead: 800, cacheWrite: 50, reasoning: 30 };

  it('stacks each day by kind so the layers add up to the day, leaving reasoning out', () => {
    const day = (date: string, breakdown: TokenCounts) => ({ day: date, tokens: total(breakdown), breakdown, costMicrousd: null, costParts: null });
    const daily = [day('2026-10-21', counts), day('2026-10-23', { input: 7, output: 3, cacheRead: 0, cacheWrite: 1, reasoning: 3 })];
    const range = { from: '2026-10-21', to: '2026-10-23' };
    const stacks = kindStacks(daily, range);
    expect(stacks.map((layer) => layer.label)).toEqual(['Input', 'Output', 'Cache read', 'Cache write']);
    expect(stacks.map((layer) => layer.values)).toEqual([[100, 0, 7], [50, 0, 3], [800, 0, 0], [50, 0, 1]]);
    const tops = stackTops(stacks.map((layer) => layer.values));
    expect(tops.at(-1)).toEqual(fillRange(daily, range).map((point) => point.tokens));
    expect(tops.at(-1)).toEqual([1_000, 0, 11]);
    const points = fillRange(daily, range);
    const stacked = renderToStaticMarkup(<TrendChart points={points} stacks={stacks} label="Tokens by type" />);
    expect(stacked.match(/class="trend-layer /g)).toHaveLength(4);
    expect(stacked).not.toContain('trend-line');
    expect(stacked).toContain('<th>Day</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th>');
    expect(stacked).toContain('<td>2026-10-21</td><td>100</td><td>50</td><td>800</td><td>50</td><td>1,000</td>');
  });
  it('keeps the total chart as it was when no stacks are given', () => {
    const html = renderToStaticMarkup(<TrendChart points={[{ day: '2026-10-22', tokens: 4 }, { day: '2026-10-23', tokens: 6 }]} label="Tokens" />);
    expect(html).toContain('trend-area');
    expect(html).toContain('trend-line');
    expect(html).not.toContain('trend-layer');
    expect(html).toContain('<th>Day</th><th>Value</th></tr>');
  });
});
