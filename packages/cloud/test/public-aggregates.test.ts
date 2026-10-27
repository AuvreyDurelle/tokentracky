import {describe, expect, it} from 'vitest';
import {publicAggregates, sumWide, wide, type WideAggregates} from '../src/public-aggregates.ts';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const empty = (): WideAggregates => ({totalTokens: 0n, totalCostMicrousd: null, toolTotals: {}, trend: []});

describe('exact public aggregates', () => {
  it.each([MAX - 1n, MAX])('preserves the numeric boundary %s without changing the ordinary response shape', value => {
    const result = publicAggregates({...empty(), totalTokens: value, totalCostMicrousd: 0n});
    expect(result).toEqual({totalTokens: Number(value), totalCostMicrousd: 0, toolTotals: {}, trend: []});
  });
  it.each([MAX + 1n, MAX + 2n, 2n ** 80n])('retains every digit above the boundary: %s', value => {
    const result = publicAggregates({...empty(), totalTokens: sumWide([value - 1n, '1'])});
    expect(result.totalTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.exactAggregates?.totalTokens).toBe(value.toString());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('independently handles cost, complete tool maps, trends and kinds, without replacing unknown cost', () => {
    const big = 2n ** 80n;
    const result = publicAggregates({...empty(), totalCostMicrousd: big,
      toolTotals: {claude: big, codex: 9n}, trend: [{day: '2026-10-25', tokens: 1n}, {day: '2026-10-26', tokens: big}],
      breakdown: {input: big, output: 2n, cacheRead: 3n, cacheWrite: 4n, reasoning: 1n}});
    expect(result.exactAggregates).toEqual({totalCostMicrousd: big.toString(), toolTotals: {claude: big.toString(), codex: '9'},
      trend: [{day: '2026-10-25', tokens: '1'}, {day: '2026-10-26', tokens: big.toString()}],
      breakdown: {input: big.toString(), output: '2', cacheRead: '3', cacheWrite: '4', reasoning: '1'}});
    expect(result).toMatchObject({totalTokens: 0, totalCostMicrousd: Number.MAX_SAFE_INTEGER, toolTotals: {claude: Number.MAX_SAFE_INTEGER, codex: 9}});
    expect(publicAggregates({...empty(), breakdown: null})).toMatchObject({totalCostMicrousd: null, breakdown: null});
    expect(() => JSON.stringify(result)).not.toThrow();
  });
  it('carries the months and the median for the community, with exact companions above the boundary', () => {
    const big = 2n ** 80n;
    const result = publicAggregates({...empty(), monthly: [{month: '2026-09', tokens: 5n}, {month: '2026-10', tokens: big}], medianTokens: big});
    expect(result).toMatchObject({monthly: [{month: '2026-09', tokens: 5}, {month: '2026-10', tokens: Number.MAX_SAFE_INTEGER}], medianTokens: Number.MAX_SAFE_INTEGER});
    expect(result.exactAggregates).toEqual({monthly: [{month: '2026-09', tokens: '5'}, {month: '2026-10', tokens: big.toString()}], medianTokens: big.toString()});
    expect(publicAggregates(empty())).not.toHaveProperty('monthly');
    expect(publicAggregates(empty())).not.toHaveProperty('medianTokens');
  });
  it('never rounds PostgreSQL integer text through Number and rejects invalid internal counters', () => {
    expect(wide('9007199254740993')).toBe(9007199254740993n);
    for (const value of [-1n, -1, Infinity, NaN, MAX.toString() + '.1', '1e10', Number.MAX_SAFE_INTEGER + 1]) expect(() => wide(value)).toThrow();
  });
});
