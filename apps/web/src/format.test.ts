import { describe, expect, it } from 'vitest';
import { formatCompact, formatCostCompact, shortDay, utcHourSpan } from './format';

describe('compact numbers', () => {
  it('uses K, M, B and T whatever the system locale', () => {
    expect([1_234, 18_400_000, 412_900_000_000, 37_800_000_000_000].map(formatCompact)).toEqual(['1.2K', '18.4M', '412.9B', '37.8T']);
    expect(formatCostCompact(653_400_000_000)).toBe('$653.4K');
  });
});

describe('UTC hours', () => {
  it('names an hour by its UTC day, start and end, across midnight too', () => {
    expect(utcHourSpan('2026-10-27T14:00:00.000Z')).toBe(`${shortDay('2026-10-27')}, 14:00–15:00`);
    expect(utcHourSpan('2026-10-27T23:00:00.000Z')).toBe(`${shortDay('2026-10-27')}, 23:00–00:00`);
  });
});
