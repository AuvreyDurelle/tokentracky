import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CommunityStats} from '@tokentracky/core';
import {averageCount, countRatio, countShare, cumulativeMonths, publicKinds, sharedCounts, sumCounts} from './public-counts';
import {formatCompact, formatCost, formatCostCompact, formatExact} from './format';
import {CommunityHero} from './mac/LeaderboardView';
import {IntegrityNotice} from './Account';
import {toolColumns} from './columns';

const MAX = Number.MAX_SAFE_INTEGER;
const large = 2n ** 80n + 12345n;
const stats: CommunityStats = {
  builders: 3, newBuilders: 1, totalTokens: MAX, totalCostMicrousd: MAX, toolTotals: {claude: MAX, codex: MAX},
  trend: Array.from({length: 30}, (_, i) => ({day: new Date(Date.UTC(2026, 9, i + 1)).toISOString().slice(0, 10), tokens: MAX})),
  breakdown: {input: MAX, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1}, updatedAt: '2026-10-30T12:00:00Z',
  exactAggregates: {totalTokens: (large * 2n).toString(), totalCostMicrousd: large.toString(),
    toolTotals: {claude: large.toString(), codex: (large + 1n).toString()},
    trend: Array.from({length: 30}, (_, i) => ({day: new Date(Date.UTC(2026, 9, i + 1)).toISOString().slice(0, 10), tokens: large.toString()})),
    breakdown: {input: large.toString(), output: '2', cacheRead: '3', cacheWrite: '4', reasoning: '1'}},
};

describe('exact public counter rendering', () => {
  it('prefers authoritative decimal values, retaining exact sums of safe component values too', () => {
    const counts = sharedCounts(stats);
    expect(counts.totalTokens).toBe(large * 2n);
    expect(counts.trend[0]!.tokens).toBe(large);
    expect(counts.breakdown!.input).toBe(large);
    const safeKinds = publicKinds({input: MAX, output: MAX, cacheRead: 0, cacheWrite: 0, reasoning: MAX});
    expect(sumCounts([safeKinds.input, safeKinds.output, safeKinds.cacheRead, safeKinds.cacheWrite])).toBe(BigInt(MAX) * 2n);
    expect(averageCount(BigInt(MAX) * 2n + 1n, 2)).toBe(BigInt(MAX) + 1n);
  });
  it('formats arbitrary integer counts and micro-USD without an unsafe conversion', () => {
    expect(formatExact(9007199254740993n)).toBe('9,007,199,254,740,993');
    expect(formatCost(18446744073709551615n)).toBe('$18,446,744,073,709.55');
    expect(formatCost(1004999n)).toBe('$1.00');
    expect(formatCost(1005000n)).toBe('$1.01');
    expect(formatCompact(large)).toBe('1.2E24');
    expect(formatCompact(999_999_999_999_999_999n)).toBe('1,000,000T');
    expect(formatCompact(1_000_000_000_000_000_000n)).toBe('1E18');
    expect(formatCostCompact(large)).not.toMatch(/NaN|Infinity/);
  });
  it('keeps chart ratios bounded and shares accurate across enormous values', () => {
    expect(countRatio(large, large * 2n)).toBe(0.5);
    expect(countRatio(large * 3n, large)).toBe(1);
    expect(countRatio(1n, 0n)).toBe(0);
    expect(countShare(large, large * 2n)).toBe('50%');
    expect(countShare(1n, large)).toBe('<0.1%');
    expect(countShare(15n, 200n)).toBe('7.5%');
    expect(toolColumns(sharedCounts(stats).toolTotals, 'all')).toEqual(['codex', 'claude']);
  });
  it('renders the Mac community hero with exact titles, normalized geometry and correct weekly sums', () => {
    const html = renderToStaticMarkup(<CommunityHero stats={stats} />);
    expect(html).toContain(`title="${formatExact(large * 2n)} tokens"`);
    expect(html).toContain(`title="${formatExact(large * 7n)} tokens"`);
    expect(html).toContain('Claude Code <b>50%</b>');
    expect(html).toContain('↑ 0% vs last week');
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
  });
  it('renders an actionable integrity notice', () => {
    const notice = renderToStaticMarkup(<IntegrityNotice />);
    expect(notice).toContain('save your listing');
    expect(notice).toContain('not a ban');
  });
});

describe('cumulativeMonths', () => {
  it('runs from the total before the first month to the total now, never below zero', () => {
    const months = [{month: '2026-08', tokens: 10n}, {month: '2026-09', tokens: 0n}, {month: '2026-10', tokens: 5n}];
    expect(cumulativeMonths(100n, months)).toEqual([85n, 95n, 95n, 100n]);
    expect(cumulativeMonths(3n, months)).toEqual([0n, 0n, 0n, 3n]);
  });
});
