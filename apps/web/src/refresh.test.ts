import { describe, expect, it } from 'vitest';
import { reloadDelay, usageRevision } from './refresh';

const now = Date.parse('2026-10-23T12:00:00.000Z');
describe('dashboard refresh timing', () => {
  it('re-fetches shortly after the next cycle is due', () => {
    expect(reloadDelay({nextRefreshAt: '2026-10-23T13:00:00.000Z', refreshing: false}, now)).toBe(3_600_000 + 5_000);
    expect(reloadDelay({nextRefreshAt: '2026-10-23T11:00:00.000Z', refreshing: false}, now)).toBe(5_000);
  });
  it('checks back within seconds while a cycle runs', () => {
    expect(reloadDelay({nextRefreshAt: '2026-10-23T13:00:00.000Z', refreshing: true}, now)).toBe(5_000);
  });
  it('does nothing without a scheduled cycle', () => {
    expect(reloadDelay(null, now)).toBeNull();
    expect(reloadDelay({nextRefreshAt: null}, now)).toBeNull();
    expect(reloadDelay({nextRefreshAt: 'not a date'}, now)).toBeNull();
  });
});

describe('dashboard usage revision', () => {
  it('changes after a scan, a refresh cycle or a new price table, and not otherwise', () => {
    const status = { lastScanAt: '2026-10-23T12:00:00.000Z', lastRefreshAt: '2026-10-23T12:00:01.000Z', pricingVersion: 'litellm:2026-10-22', refreshing: true };
    const revision = usageRevision(status);
    const settled = { ...status, refreshing: false };
    expect(usageRevision(settled)).toBe(revision);
    expect(usageRevision({ ...status, pricingVersion: 'litellm:2026-10-23' })).not.toBe(revision);
    expect(usageRevision({ ...status, lastScanAt: '2026-10-23T13:00:00.000Z' })).not.toBe(revision);
    expect(usageRevision(null)).toBe('||');
  });
});
