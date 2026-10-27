import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatCompact } from '../format';
import { FRAME, StackedAreaChart, chartGeometry, dayAt, hourLabels, xLabels, yScale } from './StackedAreaChart';

/** Every x,y pair of a path. */
const points = (path: string) => [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])] as const);

describe('yScale', () => {
  it('leaves headroom above the largest value and keeps round gridlines under it', () => {
    const { top, ticks } = yScale(612);
    expect(top).toBeGreaterThan(612);
    expect(ticks).toEqual([0, 200, 400, 600]);
  });
  it('has a unit scale and a lone baseline without data', () => {
    expect(yScale(0)).toEqual({ top: 1, ticks: [0] });
  });
});

describe('chartGeometry', () => {
  const series = [[1, 2, 3], [3, 4, 3]];
  it('stacks each layer on the one below, from the baseline to the daily total', () => {
    const { paths, y } = chartGeometry(series, 'stacked');
    expect(paths).toHaveLength(2);
    const [first, second] = paths.map((path) => points(path.line));
    expect(first![0]).toEqual([FRAME.left, Number(y(1).toFixed(1))]);
    expect(second!.at(-1)).toEqual([FRAME.right, Number(y(6).toFixed(1))]);
    // The bottom layer closes along the baseline; the next closes along the bottom layer's top edge.
    expect(points(paths[0]!.area).filter(([, py]) => py === FRAME.bottom)).not.toHaveLength(0);
    expect(points(paths[1]!.area)).toContainEqual([FRAME.right, Number(y(3).toFixed(1))]);
    expect(paths.every((path) => path.area.endsWith('Z'))).toBe(true);
  });
  it('scales lines to the largest single value, each from the baseline', () => {
    const stacked = chartGeometry(series, 'stacked'), lines = chartGeometry(series, 'lines');
    expect(lines.top).toBeLessThan(stacked.top);
    expect(points(lines.paths[1]!.line).at(-1)).toEqual([FRAME.right, Number(lines.y(3).toFixed(1))]);
  });
  it('keeps the average on the scale and spreads the days edge to edge', () => {
    const { top, x } = chartGeometry([[1, 1]], 'stacked', 50);
    expect(top).toBeGreaterThan(50);
    expect([x(0), x(1)]).toEqual([FRAME.left, FRAME.right]);
    expect(chartGeometry([[5]], 'stacked').x(0)).toBe((FRAME.left + FRAME.right) / 2);
  });
  it('centres bars in equal slots across the frame', () => {
    const slot = (FRAME.right - FRAME.left) / 4;
    const { x } = chartGeometry([[1, 1, 1, 1]], 'stacked', undefined, true);
    expect([x(0), x(3)]).toEqual([FRAME.left + slot / 2, FRAME.right - slot / 2]);
  });
});

describe('dayAt', () => {
  it('reads the nearest day under a point of the frame, clamped to the ends', () => {
    expect(dayAt(FRAME.left, 30)).toBe(0);
    expect(dayAt(FRAME.right, 30)).toBe(29);
    expect(dayAt(FRAME.left + (FRAME.right - FRAME.left) * 0.51, 3)).toBe(1);
    expect(dayAt(-50, 30)).toBe(0);
    expect(dayAt(5000, 30)).toBe(29);
  });
  it('reads the bar whose slot holds the point', () => {
    const slot = (FRAME.right - FRAME.left) / 24;
    expect(dayAt(FRAME.left + slot * 0.9, 24, true)).toBe(0);
    expect(dayAt(FRAME.left + slot * 1.1, 24, true)).toBe(1);
    expect(dayAt(FRAME.right, 24, true)).toBe(23);
    expect(dayAt(-50, 24, true)).toBe(0);
  });
});

/** 24 hours from 11:00 UTC on the 25th, as the API writes them. */
const hours = Array.from({ length: 24 }, (_, index) => new Date(Date.UTC(2026, 9, 25, 11 + index)).toISOString());

describe('hourLabels', () => {
  it('labels every fourth hour on the clock and ends on the last', () => {
    const labels = hourLabels(hours);
    expect(labels.map((label) => label.index)).toEqual([0, 4, 8, 12, 16, 20, 23]);
    expect(labels.every((label) => /\d:\d\d/.test(label.text))).toBe(true);
    expect(new Set(labels.map((label) => label.text)).size).toBe(7);
  });
});

describe('xLabels', () => {
  const days = (count: number) => Array.from({ length: count }, (_, index) => new Date(Date.UTC(2026, 8, 26 + index)).toISOString().slice(0, 10));
  it('labels about six evenly spaced days and ends on Today', () => {
    const labels = xLabels(days(30), '2026-10-25');
    expect(labels.map((label) => label.index)).toEqual([0, 5, 10, 15, 20, 25, 29]);
    expect(labels.at(-1)!.text).toBe('Today');
  });
  it('labels every day of a week and names the last day when it is not today', () => {
    const labels = xLabels(days(7), '2026-12-01');
    expect(labels).toHaveLength(7);
    expect(labels.at(-1)!.text).not.toBe('Today');
  });
});

describe('StackedAreaChart', () => {
  const props = {
    days: ['2026-10-23', '2026-10-24', '2026-10-25'],
    series: [
      { key: 'claude', label: 'Claude Code', color: 'var(--tool-claude)', values: [100, 200, 300], costs: [1_000_000, 2_000_000, 3_000_000] },
      { key: 'codex', label: 'Codex', color: 'var(--tool-codex)', values: [50, 0, 25] },
    ],
    format: formatCompact,
    label: 'Daily tokens by tool',
  };
  it('draws a filled area and a top line per series, with the average', () => {
    const html = renderToStaticMarkup(<StackedAreaChart {...props} mode="stacked" average={225} />);
    expect(html.match(/class="tk-area"/g)).toHaveLength(2);
    expect(html.match(/class="tk-line"/g)).toHaveLength(2);
    expect(html).toContain('stroke:var(--tool-claude)');
    expect(html).toContain('Daily avg 225');
  });
  it('carries every value in a hidden table', () => {
    const html = renderToStaticMarkup(<StackedAreaChart {...props} mode="lines" />);
    const table = /<table class="sr-only">([\s\S]*)<\/table>/.exec(html)?.[1] ?? '';
    expect(table).toContain('<caption>Daily tokens by tool</caption>');
    expect(table).toContain('<th scope="col">Claude Code</th><th scope="col">Codex</th><th scope="col">Total</th>');
    expect(table).toContain('<th scope="row">2026-10-25</th><td>300</td><td>25</td><td>325</td>');
    expect(table.match(/<tr>/g)).toHaveLength(4);
  });
  it('stacks a bar per hour, a block for each series with tokens in it, and names the hours in its table', () => {
    const values = (every: number) => hours.map((_, index) => index % every === 0 ? 10 : 0);
    const html = renderToStaticMarkup(<StackedAreaChart {...props} days={hours} mode="lines" hours
      series={[{ ...props.series[0]!, values: values(1), costs: undefined }, { ...props.series[1]!, values: values(2) }]} />);
    expect(html).not.toContain('tk-area');
    expect(html.match(/class="tk-hour"/g)).toHaveLength(24 + 12);
    const table = /<table class="sr-only">([\s\S]*)<\/table>/.exec(html)?.[1] ?? '';
    expect(table).toContain('<th scope="col">Hour</th>');
    expect(table.match(/<tr>/g)).toHaveLength(25);
    expect(table).not.toContain(hours[0]);
  });
});
