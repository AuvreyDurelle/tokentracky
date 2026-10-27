import type {CommunityStats, ExactTokenCounts, LeaderboardResponse, TokenCounts, ToolId} from '@tokentracky/core';

type Shared = Pick<LeaderboardResponse, 'totalTokens' | 'totalCostMicrousd' | 'toolTotals' | 'trend' | 'exactAggregates'> & Partial<Pick<CommunityStats, 'breakdown' | 'monthly' | 'medianTokens'>>;
export type PublicKinds = Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning', bigint>;

/** Decimal companions are authoritative. The numeric fallback always comes from the safe legacy contract. */
export function exactCount(value: number, exact?: string): bigint {
  if (exact !== undefined) {
    if (!/^\d+$/.test(exact)) throw new Error('Invalid exact public counter');
    return BigInt(exact);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid public counter');
  return BigInt(value);
}

export function publicKinds(value: TokenCounts, exact?: ExactTokenCounts): PublicKinds {
  return {input: exactCount(value.input, exact?.input), output: exactCount(value.output, exact?.output),
    cacheRead: exactCount(value.cacheRead, exact?.cacheRead), cacheWrite: exactCount(value.cacheWrite, exact?.cacheWrite),
    reasoning: exactCount(value.reasoning ?? 0, exact?.reasoning)};
}

export function sharedCounts(value: Shared) {
  const exact = value.exactAggregates;
  return {
    totalTokens: exactCount(value.totalTokens, exact?.totalTokens),
    totalCostMicrousd: value.totalCostMicrousd === null ? null : exactCount(value.totalCostMicrousd, exact?.totalCostMicrousd),
    toolTotals: Object.fromEntries(Object.entries(value.toolTotals).map(([tool, count]) => [tool, exactCount(count!, exact?.toolTotals?.[tool as ToolId])])) as Partial<Record<ToolId, bigint>>,
    trend: value.trend.map((point, index) => ({day: point.day, tokens: exactCount(point.tokens, exact?.trend?.[index]?.tokens)})),
    breakdown: value.breakdown ? publicKinds(value.breakdown, exact?.breakdown) : null,
    monthly: value.monthly?.map((point, index) => ({month: point.month, tokens: exactCount(point.tokens, exact?.monthly?.[index]?.tokens)})) ?? null,
    medianTokens: value.medianTokens === undefined ? null : exactCount(value.medianTokens, exact?.medianTokens),
  };
}

/** The running community total at the start of the first month and the end of each, the last being now: the total, less what each later month added. */
export function cumulativeMonths(total: bigint, monthly: Array<{month: string; tokens: bigint}>): bigint[] {
  const points = [total];
  for (let index = monthly.length - 1; index >= 0; index--) points.unshift(points[0]! - monthly[index]!.tokens);
  return points.map(point => point < 0n ? 0n : point);
}

export const sumCounts = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const value of values) total += value;
  return total;
};

/** Geometry alone uses a floating-point ratio, bounded to [0, 1] before conversion. */
export function countRatio(part: bigint, whole: bigint): number {
  if (part <= 0n || whole <= 0n) return 0;
  if (part >= whole) return 1;
  return Number(part * 1_000_000n / whole) / 1_000_000;
}

/** A share or growth percentage, with exact integer rounding even for values beyond 64 bits. */
export function countShare(part: bigint, whole: bigint): string {
  if (part <= 0n || whole <= 0n) return '0%';
  if (part * 1000n < whole) return '<0.1%';
  if (part * 10n >= whole) return `${(part * 100n + whole / 2n) / whole}%`;
  const tenths = (part * 1000n + whole / 2n) / whole;
  return `${tenths / 10n}.${tenths % 10n}%`;
}

export function averageCount(total: bigint, members: number): bigint {
  if (members <= 0) return 0n;
  const divisor = BigInt(members);
  return (total + divisor / 2n) / divisor;
}
