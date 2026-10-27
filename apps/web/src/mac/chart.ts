/** Cumulative layers for a stacked area: `layers[i][d]` is series i's [lower, upper] on day d. */
export function stack(series: number[][]): Array<Array<[number, number]>> {
  const base = new Array<number>(series[0]?.length ?? 0).fill(0);
  return series.map((values) => values.map((value, day) => {
    // A series longer than the first starts from zero on the extra days.
    const lower = base[day] ?? 0;
    base[day] = lower + value;
    return [lower, base[day]!] as [number, number];
  }));
}

/** A smooth SVG path through the points that never overshoots between them (monotone cubic, Fritsch–Carlson). */
export function monotonePath(points: Array<[number, number]>): string {
  const n = points.length;
  if (n === 0) return '';
  const [x0, y0] = points[0]!;
  if (n === 1) return `M${x0},${y0}`;
  const dx = (i: number) => points[i + 1]![0] - points[i]![0];
  // Two points at one x (a step) leave the curve flat there instead of dividing by zero.
  const slope = (i: number) => dx(i) === 0 ? 0 : (points[i + 1]![1] - points[i]![1]) / dx(i);
  const m = points.map((_, i) => {
    if (i === 0) return slope(0);
    if (i === n - 1) return slope(n - 2);
    const a = slope(i - 1), b = slope(i);
    return a * b <= 0 ? 0 : (3 * (dx(i - 1) + dx(i))) / ((2 * dx(i) + dx(i - 1)) / a + (dx(i) + 2 * dx(i - 1)) / b);
  });
  let d = `M${x0},${y0}`;
  for (let i = 0; i < n - 1; i++) {
    const [ax, ay] = points[i]!, [bx, by] = points[i + 1]!, h = dx(i) / 3;
    d += ` C${ax + h},${ay + m[i]! * h} ${bx - h},${by - m[i + 1]! * h} ${bx},${by}`;
  }
  return d;
}
