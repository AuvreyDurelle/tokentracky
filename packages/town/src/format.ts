import { RESOURCE_IDS, type Cost, type Resources } from '@tokentracky/core';

export const count = (n: number) => Math.round(n).toLocaleString('en-US');
/** 84.2M, 12.3K. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  const [value, unit] = abs >= 1e9 ? [n / 1e9, 'B'] : abs >= 1e6 ? [n / 1e6, 'M'] : abs >= 1e3 ? [n / 1e3, 'K'] : [n, ''];
  return unit ? `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${unit}` : String(Math.round(n));
}
/** 45s, 12m, 1h 12m, 2d 3h. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
/** What is still missing to pay `cost`, resource by resource. Empty when it is covered. */
export function shortfall(wallet: Resources, cost: Cost): Cost {
  const out: Cost = {};
  for (const id of RESOURCE_IDS) {
    const missing = (cost[id] ?? 0) - wallet[id];
    if (missing > 0) out[id] = missing;
  }
  return out;
}
export const covered = (wallet: Resources, cost: Cost) => Object.keys(shortfall(wallet, cost)).length === 0;
/** Whole days of coding at `perDay` to make up `missing`, or null with no pace yet. */
export function daysToAfford(missing: number, perDay: number): number | null {
  if (missing <= 0) return 0;
  return perDay > 0 ? Math.ceil(missing / perDay) : null;
}
/** "About 6 days of coding", "Today", or nothing to say without a pace. */
export function paceText(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return 'Ready now';
  return days === 1 ? 'About a day of coding' : `About ${days} days of coding`;
}
/** Hours and minutes from one ISO time to another, for "6h of coding". */
export const sinceText = (from: string | null, now: number) => from === null ? 'all your history' : `${duration((now - Date.parse(from)) / 1000)} of coding`;
