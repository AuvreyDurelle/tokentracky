import { TOOL_IDS, TOOL_NAMES, type ToolId } from '@tokentracky/core';

/** Tools the collector can read, in a fixed order. Cursor stays out of the UI until it is supported. */
export const TOOLS: Array<{ id: ToolId; label: string }> = TOOL_IDS.filter((id) => id !== 'cursor').map((id) => ({ id, label: TOOL_NAMES[id] }));
export const toolLabel = (id: ToolId) => TOOL_NAMES[id] ?? id;
/** The four token kinds that add up to every total, in a fixed order. Reasoning is part of output and is never a kind of its own. */
export const KINDS = [{ key: 'input', label: 'Input' }, { key: 'output', label: 'Output' }, { key: 'cacheRead', label: 'Cache read' }, { key: 'cacheWrite', label: 'Cache write' }] as const;

/** K, M, B and T in English; scientific notation keeps unbounded shared totals within compact surfaces. */
export function formatCompact(value: number | bigint) {
  const notation = value >= 1_000_000_000_000_000_000n ? 'scientific' : 'compact';
  return new Intl.NumberFormat('en-US', { notation, maximumFractionDigits: 1 }).format(value);
}
export function formatExact(value: number | bigint) { return new Intl.NumberFormat().format(value); }
export function formatShare(part: number, whole: number) {
  if (!whole || !part) return '0%';
  const percent = (part / whole) * 100;
  return percent < 0.1 ? '<0.1%' : `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}
/** Null means pricing is unknown; never show a substitute amount. */
export function formatCost(value: number | bigint | null | undefined) {
  if (value === null || value === undefined) return '—';
  const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' });
  if (typeof value === 'number') return formatter.format(value / 1_000_000);
  const cents = (value + 5_000n) / 10_000n;
  const fraction = new Intl.NumberFormat(undefined, {minimumIntegerDigits: 2, useGrouping: false}).format(cents % 100n);
  return formatter.formatToParts(cents / 100n).map(part => part.type === 'fraction' ? fraction : part.value).join('');
}
export function timeAgo(value: string | null | undefined, now = Date.now()) {
  if (!value) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
/** Compact dollars for axes and small surfaces: $0.42, $12, $1.2K. */
export function formatCostCompact(microusd: number | bigint): string {
  if (typeof microusd === 'bigint') return microusd < 10_000_000n ? formatCostCompact(Number(microusd)) : `$${formatCompact(microusd / 1_000_000n)}`;
  const dollars = microusd / 1_000_000;
  return dollars < 10 && dollars > 0 ? `$${dollars.toFixed(dollars < 1 ? 2 : 1)}` : `$${formatCompact(dollars)}`;
}
export function timeUntil(value: string | null | undefined, now = Date.now()) {
  if (!value) return 'not scheduled';
  const seconds = Math.round((Date.parse(value) - now) / 1000);
  if (seconds < 45) return 'any moment';
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  return `in ${Math.round(seconds / 3600)}h`;
}
export function shortDay(day: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}
/** "Top N%" for a rank among `builders`, shown only in the top half: N = ceil(rank ÷ builders × 100). */
export function topPercent(rank: number, builders: number): string | null {
  if (builders <= 0 || rank < 1 || rank * 2 > builders) return null;
  return `Top ${Math.ceil(rank * 100 / builders)}%`;
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

/** Clean axis ticks: 0 plus up to three round steps (1/2/5 × 10^n) covering the maximum. */
export function niceTicks(maximum: number): number[] {
  if (maximum <= 0) return [0];
  const rough = maximum / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  return Array.from({ length: Math.ceil(maximum / step) + 1 }, (_, index) => index * step);
}
