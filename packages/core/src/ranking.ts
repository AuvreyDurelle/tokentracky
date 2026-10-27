import type { Period } from './index.ts';

export function rankingWindow(period: Period, now = new Date()): string | null {
  if (period === 'all') return null;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'month') start.setUTCDate(1);
  else start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start.toISOString();
}

/** Reject date rollover and timestamps invented from import time. */
export function isUtcDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}

export function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function checkedSum(values: Iterable<number>): number {
  let sum = 0;
  for (const value of values) {
    if (!isSafeCount(value) || !Number.isSafeInteger(sum + value)) throw new RangeError('Counter exceeds safe integer range');
    sum += value;
  }
  return sum;
}
