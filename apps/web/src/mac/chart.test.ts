import { describe, expect, it } from 'vitest';
import { monotonePath, stack } from './chart';

/** Every x,y pair of a path: the start, then each curve's two control points and its end. */
const points = (path: string) => [...path.matchAll(/(-?[\d.e-]+|NaN),(-?[\d.e-]+|NaN)/g)].map((match) => [Number(match[1]), Number(match[2])] as const);

describe('chart', () => {
  it('stacks series day by day', () => {
    expect(stack([[1, 2], [3, 4]])).toEqual([[[0, 1], [0, 2]], [[1, 4], [2, 6]]]);
  });
  it('stacks a series longer than the first from zero', () => {
    expect(stack([[1], [3, 4]])).toEqual([[[0, 1]], [[1, 4], [0, 4]]]);
  });
  it('passes through every point', () => {
    const path = monotonePath([[0, 0], [10, 5], [20, 5]]);
    expect(path.startsWith('M0,0')).toBe(true);
    expect(path).toContain(' 10,5');
    expect(path.endsWith(' 20,5')).toBe(true);
  });
  it('never overshoots a flat run', () => {
    const ys = [...monotonePath([[0, 5], [10, 5], [20, 5]]).matchAll(/,(-?[\d.]+)/g)].map((match) => Number(match[1]));
    expect(ys.every((y) => y === 5)).toBe(true);
  });
  it('stays within the data around a flat run in the middle', () => {
    const path = points(monotonePath([[0, 0], [10, 10], [20, 10], [30, 10], [40, 0]]));
    expect(path).toHaveLength(13);
    expect(path.every(([, y]) => y >= 0 && y <= 10)).toBe(true);
    // Along the plateau the curve is the flat line itself.
    const plateau = path.filter(([x]) => x >= 10 && x <= 30);
    expect(plateau).toHaveLength(7);
    for (const [x, y] of plateau) expect(y, `at x ${x}`).toBeCloseTo(10);
  });
  it('draws a step where two points share an x', () => {
    for (const series of [[[0, 0], [0, 5], [10, 5]], [[0, 0], [10, 5], [10, 5], [20, 8]], [[0, 0], [10, 0], [10, 8], [20, 8]]] as Array<Array<[number, number]>>) {
      const path = points(monotonePath(series));
      expect(path.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), JSON.stringify(series)).toBe(true);
      expect(path.at(-1)).toEqual(series.at(-1));
    }
  });
});
