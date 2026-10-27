import { useEffect } from 'react';

/** The local status fields that describe the five-minute refresh cycle (D1). */
export interface RefreshTimes { nextRefreshAt?: string | null; refreshing?: boolean }

/** Changes whenever local totals may have: a scan, a refresh cycle, or a new price table (which can land after the scan). */
export function usageRevision(status: { lastScanAt?: string | null; lastRefreshAt?: string | null; pricingVersion?: string } | null): string {
  return [status?.lastScanAt, status?.lastRefreshAt, status?.pricingVersion].map((value) => value ?? '').join('|');
}

const SETTLE_MS = 5_000;
/** Browsers clamp longer timers; re-arm instead of firing early. */
const MAX_TIMER_MS = 2_147_483_647;

/** Milliseconds until the dashboard should re-fetch, or null when no cycle is scheduled. */
export function reloadDelay(times: RefreshTimes | null, now = Date.now()): number | null {
  if (!times) return null;
  // A running cycle finishes within seconds; check back shortly instead of waiting for the next one.
  if (times.refreshing) return SETTLE_MS;
  const next = times.nextRefreshAt ? Date.parse(times.nextRefreshAt) : NaN;
  if (!Number.isFinite(next)) return null;
  return Math.min(Math.max(next - now, 0) + SETTLE_MS, MAX_TIMER_MS);
}

/** Calls `reload` once the next refresh cycle should have completed. Re-arms whenever new times arrive. */
export function useRefreshReload(times: RefreshTimes | null, reload: () => void): void {
  const nextRefreshAt = times?.nextRefreshAt ?? null;
  const refreshing = times?.refreshing ?? false;
  const scheduled = times !== null;
  useEffect(() => {
    const delay = scheduled ? reloadDelay({nextRefreshAt, refreshing}) : null;
    if (delay === null) return;
    const timer = setTimeout(reload, delay);
    return () => clearTimeout(timer);
  }, [scheduled, nextRefreshAt, refreshing, reload]);
}
