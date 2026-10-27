import { afterEach, describe, expect, it } from 'vitest';
import { hourList, last24Hours, previousWindow } from './ranges';

const zone = process.env.TZ;
afterEach(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
const iso = (ms: number) => new Date(ms).toISOString();

describe('last24Hours', () => {
  it('ends at the start of the hour under way, so at 11:30 the last hour is 10:00 to 11:00', () => {
    process.env.TZ = 'Asia/Tokyo';
    // 11:30 in Tokyo is 02:30 UTC.
    const window = last24Hours(new Date('2026-10-26T02:30:00.000Z'));
    expect([iso(window.since), iso(window.until)]).toEqual(['2026-10-25T02:00:00.000Z', '2026-10-26T02:00:00.000Z']);
    expect(last24Hours(new Date('2026-10-26T02:00:00.000Z'))).toEqual(window);
    expect(last24Hours(new Date('2026-10-26T01:59:59.999Z')).until).toBe(window.until - 3_600_000);
  });
  it('keeps the minutes of a zone off the hour', () => {
    process.env.TZ = 'Asia/Kolkata';
    // 11:30 in India is 06:00 UTC; its hour began at 05:30 UTC.
    expect(iso(last24Hours(new Date('2026-10-26T06:00:00.000Z')).until)).toBe('2026-10-26T05:30:00.000Z');
  });
});

describe('previousWindow', () => {
  it('is the same length, ending where the window starts', () => {
    expect(previousWindow({ since: 100, until: 160 })).toEqual({ since: 40, until: 100 });
  });
});

describe('hourList', () => {
  it("lists each hour's first instant as the API writes it", () => {
    const hours = hourList({ since: Date.parse('2026-10-25T02:00:00.000Z'), until: Date.parse('2026-10-26T02:00:00.000Z') });
    expect(hours).toHaveLength(24);
    expect([hours[0], hours[23]]).toEqual(['2026-10-25T02:00:00.000Z', '2026-10-26T01:00:00.000Z']);
  });
});
