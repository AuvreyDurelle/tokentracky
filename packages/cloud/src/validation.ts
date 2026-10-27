import { ALIAS_PATTERN, isPublicModel, isSafeCount, isUtcDay, TOOL_IDS, type PublicBucket, type PublicHour, type TokenCounts } from '@tokentracky/core';
import { invalid } from './errors.ts';

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) invalid('Unknown request field');
  return record;
}
export function alias(value: unknown): string {
  if (typeof value !== 'string' || !ALIAS_PATTERN.test(value)) invalid('Alias must be 3–30 letters, numbers, underscores or hyphens');
  return value.toLowerCase();
}
/** Sharing is fixed: a publication names its alias and nothing else. */
export interface PublicationInput {alias: string}
export function publicationInput(value: unknown): PublicationInput {
  return {alias: alias(object(value, ['alias']).alias)};
}
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
/** A bucket's tokens by kind: exactly these five counts (never the one-hour cache-write part), the four disjoint ones adding up to `tokens`, reasoning within output. */
function checkBreakdown(value: unknown, tokens: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid token types');
  const k = value as Record<string, unknown>;
  if (Object.keys(k).length !== KINDS.length || !KINDS.every(kind => isSafeCount(k[kind]))) invalid('Invalid token types');
  const {input, output, cacheRead, cacheWrite, reasoning} = k as Required<TokenCounts>;
  if (input + output + cacheRead + cacheWrite !== tokens || reasoning > output) invalid('Invalid token types');
}
const HOUR_MS = 3_600_000;
/**
 * The hours for the leaderboard's 24-hour column: whole UTC hours, one total per tool, all split or all `all`. Up to
 * the host's next hour, so a clock a little ahead still syncs; older hours are allowed (a retried batch) and dropped.
 */
function hourList(value: unknown, now: Date): PublicHour[] {
  if (!Array.isArray(value) || value.length > 1000) invalid('Invalid hours');
  const latest = (Math.floor(now.getTime() / HOUR_MS) + 1) * HOUR_MS;
  const keys = new Set<string>();
  const hours = value.map(raw => {
    const h = object(raw, ['hour', 'tool', 'tokens']);
    const at = typeof h.hour === 'string' ? Date.parse(h.hour) : NaN;
    if (!Number.isFinite(at) || new Date(at).toISOString() !== h.hour || at % HOUR_MS !== 0 || at > latest) invalid('Invalid or future hour');
    if (![...TOOL_IDS, 'all'].includes(h.tool as 'all') || !isSafeCount(h.tokens)) invalid('Invalid aggregate counters');
    const key = `${h.hour}/${h.tool}`;
    if (keys.has(key)) invalid('Duplicate hour key');
    keys.add(key);
    return h as unknown as PublicHour;
  });
  if (new Set(hours.map(h => h.tool === 'all')).size > 1) invalid('Hours cannot combine aggregated and split tools');
  return hours;
}
export function ingestionInput(value: unknown, now: Date): {generation: string; collectorId: string; checkpoint: number; receipt:string; baseReceipt:string|null; buckets: PublicBucket[]; hours: PublicHour[] | undefined} {
  // `hours` is optional: apps from before the 24-hour column, and every chunk after an upload's first, send none.
  const v = object(value, ['generation', 'collectorId', 'checkpoint', 'receipt', 'baseReceipt', 'buckets', 'hours']);
  const uuid = (value:unknown):value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!uuid(v.receipt) || (v.baseReceipt !== null && !uuid(v.baseReceipt)) || v.receipt === v.baseReceipt) invalid('Valid sync receipts are required');
  if (typeof v.collectorId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.collectorId) || !isSafeCount(v.checkpoint)) invalid('Collector identity and checkpoint are required');
  if (typeof v.generation !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.generation) || !Array.isArray(v.buckets) || v.buckets.length > 10000) invalid('Invalid generation or bucket count');
  const keys = new Set<string>();
  const buckets = v.buckets.map(raw => {
    // `breakdown` is optional: apps from before token types upload without it.
    const b = object(raw, ['day', 'tool', 'model', 'tokens', 'costMicrousd', 'revision', 'breakdown']);
    if (b.day !== null && (typeof b.day !== 'string' || !isUtcDay(b.day) || b.day > now.toISOString().slice(0, 10))) invalid('Invalid or future original day');
    if (![...TOOL_IDS, 'all'].includes(b.tool as 'all') || !isSafeCount(b.tokens) || !isSafeCount(b.revision) || (b.costMicrousd !== null && !isSafeCount(b.costMicrousd))) invalid('Invalid aggregate counters');
    if (b.model !== undefined && !isPublicModel(b.model)) invalid('Invalid model id');
    if (b.breakdown !== undefined) checkBreakdown(b.breakdown, b.tokens as number);
    const key = `${b.day ?? 'unknown'}/${b.tool}/${b.model ?? ''}`;
    if (keys.has(key)) invalid('Duplicate bucket key');
    if ((b.revision as number) > (v.checkpoint as number)) invalid('Bucket revision exceeds collector checkpoint');
    keys.add(key);
    return b as unknown as PublicBucket;
  });
  const hours = v.hours === undefined ? undefined : hourList(v.hours, now);
  return {generation: v.generation as string, collectorId: v.collectorId as string, checkpoint: v.checkpoint as number, receipt:v.receipt as string, baseReceipt:v.baseReceipt as string|null, buckets, hours};
}
