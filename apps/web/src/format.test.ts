import { describe, expect, it } from 'vitest';
import { formatCompact, formatCostCompact } from './format';

describe('compact numbers', () => {
  it('uses K, M, B and T whatever the system locale', () => {
    expect([1_234, 18_400_000, 412_900_000_000, 37_800_000_000_000].map(formatCompact)).toEqual(['1.2K', '18.4M', '412.9B', '37.8T']);
    expect(formatCostCompact(653_400_000_000)).toBe('$653.4K');
  });
});
