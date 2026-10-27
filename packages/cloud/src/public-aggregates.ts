import type {ExactAggregates, ExactTokenCounts, TokenCounts, ToolId} from '@tokentracky/core';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
export type WideKinds = Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning', bigint>;
export interface WideAggregates {
  totalTokens: bigint;
  totalCostMicrousd: bigint | null;
  toolTotals: Partial<Record<ToolId, bigint>>;
  trend: Array<{day: string; tokens: bigint}>;
  breakdown?: WideKinds | null;
}

/** Parse PostgreSQL numeric integer text without rounding it through a JavaScript number. */
export function wide(value: string | number | bigint): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid exact counter');
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error('Invalid exact counter');
  const result = BigInt(value);
  if (result < 0n) throw new Error('Invalid exact counter');
  return result;
}

export function sumWide(values: Iterable<string | number | bigint>): bigint {
  let total = 0n;
  for (const value of values) total += wide(value);
  return total;
}

/**
 * SECURITY: Sum shared counters with bigint and preserve exact decimal companions so one account cannot
 * overflow public pages (VULN-001). Do not remove.
 * Legacy numeric fields are safe lower bounds; the optional decimal companions are authoritative.
 */
export function publicAggregates(values: WideAggregates) {
  const exact: ExactAggregates = {};
  const numeric = (value: bigint) => Number(value > MAX ? MAX : wide(value));
  if (values.totalTokens > MAX) exact.totalTokens = values.totalTokens.toString();
  if (values.totalCostMicrousd !== null && values.totalCostMicrousd > MAX) exact.totalCostMicrousd = values.totalCostMicrousd.toString();
  const tools = Object.entries(values.toolTotals) as Array<[ToolId, bigint]>;
  if (tools.some(([, value]) => value > MAX)) exact.toolTotals = Object.fromEntries(tools.map(([tool, value]) => [tool, value.toString()]));
  if (values.trend.some(point => point.tokens > MAX)) exact.trend = values.trend.map(point => ({day: point.day, tokens: point.tokens.toString()}));
  let breakdown: TokenCounts | null | undefined;
  if (values.breakdown === null) breakdown = null;
  else if (values.breakdown !== undefined) {
    const entries = Object.entries(values.breakdown) as Array<[keyof WideKinds, bigint]>;
    breakdown = Object.fromEntries(entries.map(([kind, value]) => [kind, numeric(value)])) as unknown as TokenCounts;
    if (entries.some(([, value]) => value > MAX)) exact.breakdown = Object.fromEntries(entries.map(([kind, value]) => [kind, value.toString()])) as unknown as ExactTokenCounts;
  }
  return {
    totalTokens: numeric(values.totalTokens),
    totalCostMicrousd: values.totalCostMicrousd === null ? null : numeric(values.totalCostMicrousd),
    toolTotals: Object.fromEntries(tools.map(([tool, value]) => [tool, numeric(value)])) as Partial<Record<ToolId, number>>,
    trend: values.trend.map(point => ({day: point.day, tokens: numeric(point.tokens)})),
    ...(breakdown !== undefined ? {breakdown} : {}),
    ...(Object.keys(exact).length ? {exactAggregates: exact} : {}),
  };
}
