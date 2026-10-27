import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatCost, shortDay } from '../format';
import { monotonePath, stack } from './chart';
import './personal.css';

/** The mockup's frame (tokens.html): a 1078×304 view with the plot inset for y labels on the left and x labels below. */
export const FRAME = { width: 1078, height: 304, left: 46, right: 1068, top: 16, bottom: 270 };
const LONG_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// Hours are on this computer's clock.
const HOUR = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY_HOUR = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const HOUR_MS = 3_600_000;

/** `soft` fills a near-white hue lightly, as the mockup does for Codex, so it doesn't outshine the coloured layers. */
export interface ChartSeries { key: string; label: string; color: string; values: number[]; costs?: number[]; soft?: boolean }
type Mode = 'stacked' | 'lines';

/** A scale with a little headroom over `max`, and round gridlines (1, 2 or 5 × 10ⁿ apart, about four of them) under its top. */
export function yScale(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0] };
  const top = max * 1.12;
  const rough = top / 4, magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  return { top, ticks: Array.from({ length: Math.floor(top / step) + 1 }, (_, index) => index * step) };
}

const round = (value: number) => Math.round(value * 10) / 10;
/** Paths stay short: one decimal is far below a pixel. */
const tidy = (path: string) => path.replace(/\d+\.\d{2,}/g, (number) => String(round(Number(number))));

/** Positions and paths in the frame: per series an area (closed along the series below it, or the baseline) and its top line. With `bars`, each point is centred in an equal slot. */
export function chartGeometry(series: number[][], mode: Mode, average?: number, bars = false) {
  const count = series[0]?.length ?? 0;
  const layers = mode === 'stacked' ? stack(series) : series.map((values) => values.map((value) => [0, value] as [number, number]));
  const { top, ticks } = yScale(Math.max(0, average ?? 0, ...layers.flatMap((layer) => layer.map(([, upper]) => upper))));
  const x = (index: number) => bars ? FRAME.left + ((index + 0.5) / count) * (FRAME.right - FRAME.left)
    : count > 1 ? FRAME.left + (index / (count - 1)) * (FRAME.right - FRAME.left) : (FRAME.left + FRAME.right) / 2;
  const y = (value: number) => FRAME.bottom - (value / top) * (FRAME.bottom - FRAME.top);
  const paths = layers.map((layer) => {
    const line = tidy(monotonePath(layer.map(([, upper], index) => [round(x(index)), round(y(upper))])));
    const lower = tidy(monotonePath(layer.map(([lower], index) => [round(x(index)), round(y(lower))] as [number, number]).reverse()));
    return { line, area: `${line} L${lower.slice(1)}Z` };
  });
  return { top, ticks, x, y, layers, paths };
}

/** The day nearest a horizontal position in the frame; with `bars`, the bar whose slot holds it. */
export function dayAt(frameX: number, count: number, bars = false): number {
  const share = (frameX - FRAME.left) / (FRAME.right - FRAME.left);
  return Math.max(0, Math.min(count - 1, bars ? Math.floor(share * count) : Math.round(share * (count - 1))));
}

/** About six evenly spaced indexes up to `last`, one of `steps` apart, always ending on `last`. */
function labelIndexes(last: number, steps: number[]): number[] {
  const step = steps.find((candidate) => last / candidate <= 6) ?? Math.ceil(last / 6);
  const indexes: number[] = [];
  for (let index = 0; index < last; index += step) if (last - index >= step / 2 || index === 0) indexes.push(index);
  indexes.push(last);
  return indexes;
}

/** About six evenly spaced day labels, always ending on the last day ("Today" when it is today). */
export function xLabels(days: string[], today: string): Array<{ index: number; text: string }> {
  const last = days.length - 1;
  if (last < 0) return [];
  return labelIndexes(last, [1, 2, 5, 7, 14, 15, 30, 61]).map((index) => ({ index, text: index === last && days[index] === today ? 'Today' : shortDay(days[index]!) }));
}

/** About six labels for hours (their first instants), a few hours apart on this computer's clock, always ending on the last hour. */
export function hourLabels(hours: string[]): Array<{ index: number; text: string }> {
  const last = hours.length - 1;
  if (last < 0) return [];
  return labelIndexes(last, [1, 2, 3, 4, 6, 12]).map((index) => ({ index, text: HOUR.format(new Date(hours[index]!)) }));
}

const KEYS: Record<string, (from: number, last: number) => number> = { ArrowLeft: (from) => from - 1, ArrowRight: (from) => from + 1, Home: () => 0, End: (_, last) => last };

/** Daily values as stacked areas or overlaid lines, with gridlines, a dashed average and a crosshair that pointer or arrow keys move. A hidden table carries every value.
 * With `hours`, `days` are hours' first instants and each hour is a bar stacked by series, on this computer's clock. */
export function StackedAreaChart({ days, series, mode, average, format, label, hours = false }: { days: string[]; series: ChartSeries[]; mode: Mode; average?: number; format: (value: number) => string; label: string; hours?: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const id = useId().replace(/[^\w-]/g, '');
  const geometry = useMemo(() => chartGeometry(series.map((item) => item.values), hours ? 'stacked' : mode, average, hours), [series, mode, average, hours]);
  if (!days.length || !series.length) return null;
  const { ticks, x, y, layers, paths } = geometry;
  const last = days.length - 1;
  const totals = days.map((_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0));
  const best = totals.indexOf(Math.max(...totals));
  const today = new Date().toISOString().slice(0, 10);
  // The point marking the latest day: the stack's top edge, or the largest line.
  const tops = mode === 'stacked' ? totals : days.map((_, index) => Math.max(...series.map((item) => item.values[index] ?? 0)));
  const point = active === null || active > last ? null : active;
  const labels = (hours ? hourLabels(days) : xLabels(days, today)).filter((item) => point === null || Math.abs(x(item.index) - x(point)) > 44);
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(dayAt(((event.clientX - box.left) / box.width) * FRAME.width, days.length, hours));
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = KEYS[event.key];
    if (!next) return;
    event.preventDefault(); setActive(Math.max(0, Math.min(last, next(point ?? last, last))));
  };
  const band = hours ? (FRAME.right - FRAME.left) / days.length : days.length > 1 ? (FRAME.right - FRAME.left) / last : 40;
  const costs = series.some((item) => item.costs);
  // An hour's name: its weekday and start, to its end.
  const hourName = (index: number) => `${WEEKDAY_HOUR.format(new Date(days[index]!))} – ${HOUR.format(new Date(Date.parse(days[index]!) + HOUR_MS))}`;
  return <div className="tk-chart">
    <div className="tk-plot" tabIndex={0} role="group" aria-label={`${label}. Use arrow keys to read each ${hours ? 'hour' : 'day'}.`} onKeyDown={step}
      onFocus={() => setActive((value) => value ?? last)} onBlur={() => setActive(null)}>
      <svg viewBox={`0 0 ${FRAME.width} ${FRAME.height}`} aria-hidden="true" onPointerMove={move} onPointerLeave={() => setActive(null)}>
        <defs>{series.map((item) => <linearGradient key={item.key} id={`${id}-${item.key}`} x1="0" y1={FRAME.top} x2="0" y2={FRAME.bottom} gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: item.color }} stopOpacity={mode === 'lines' ? 0.14 : item.soft ? 0.17 : 0.62} />
          <stop offset="1" style={{ stopColor: item.color }} stopOpacity={mode === 'lines' ? 0 : item.soft ? 0.035 : 0.14} />
        </linearGradient>)}</defs>
        {ticks.map((tick) => <g key={tick}>
          <line className={tick ? 'tk-grid' : 'tk-base'} x1={FRAME.left} x2={FRAME.right} y1={round(y(tick))} y2={round(y(tick))} />
          <text x={FRAME.left - 10} y={round(y(tick)) + 4} textAnchor="end">{format(tick)}</text>
        </g>)}
        {point !== null && <rect className="tk-xband" x={round(x(point) - Math.min(band, 36) / 2)} y={FRAME.top} width={round(Math.min(band, 36))} height={FRAME.bottom - FRAME.top} rx="4" />}
        {hours ? layers.map((layer, index) => <g key={series[index]!.key} style={{ fill: series[index]!.color }} fillOpacity={series[index]!.soft ? 0.6 : 0.88}>
          {layer.map(([lower, upper], at) => upper > lower && <rect key={at} className="tk-hour" x={round(x(at) - band * 0.34)} y={round(y(upper))} width={round(band * 0.68)} height={round(y(lower) - y(upper))} />)}
        </g>) : <>
          {/* The largest series sits at the bottom of the stack; draw from the top layer down so each edge stays crisp. */}
          {paths.map((path, index) => <path key={series[index]!.key} className="tk-area" d={path.area} fill={`url(#${id}-${series[index]!.key})`} />).reverse()}
          {paths.map((path, index) => <path key={series[index]!.key} className="tk-line" d={path.line} style={{ stroke: series[index]!.color }} />).reverse()}
        </>}
        {average !== undefined && average > 0 && <>
          <line className="tk-avg" x1={FRAME.left} x2={FRAME.right} y1={round(y(average))} y2={round(y(average))} />
          <text className="tk-avg-label" x={FRAME.left + 8} y={round(y(average)) - 7}>Daily avg {format(average)}</text>
        </>}
        {!hours && point === null && tops[last]! > 0 && <>
          <circle className="tk-today-ring" cx={round(x(last))} cy={round(y(tops[last]!))} r="7" style={{ stroke: series[0]!.color }} />
          <circle cx={round(x(last))} cy={round(y(tops[last]!))} r="3" className="tk-today-dot" />
        </>}
        {!hours && point !== null && <>
          <line className="tk-xhair" x1={round(x(point))} x2={round(x(point))} y1={FRAME.top} y2={FRAME.bottom} />
          {layers.map((layer, index) => layer[point]![1] > layer[point]![0] && <circle key={series[index]!.key} cx={round(x(point))} cy={round(y(layer[point]![1]))} r="4" className="tk-mark" style={{ fill: series[index]!.color }} />)}
          {mode === 'stacked' && totals[point]! > 0 && <circle cx={round(x(point))} cy={round(y(totals[point]!))} r="4.5" className="tk-mark-top" />}
        </>}
        {labels.map((item) => <text key={item.index} x={round(x(item.index))} y={FRAME.height - 11} textAnchor={hours ? 'middle' : item.index === 0 ? 'start' : item.index === last ? 'end' : 'middle'}>{item.text}</text>)}
        {point !== null && <>
          <rect className="tk-x-pill" x={round(Math.max(FRAME.left - 4, Math.min(FRAME.right - 52, x(point) - 26)))} y={FRAME.height - 25} width="52" height="20" rx="6" />
          <text className="tk-x-on" x={round(Math.max(FRAME.left + 22, Math.min(FRAME.right - 26, x(point))))} y={FRAME.height - 11} textAnchor="middle">{hours ? HOUR.format(new Date(days[point]!)) : days[point] === today ? 'Today' : shortDay(days[point]!)}</text>
        </>}
      </svg>
      {point !== null && <div className={`m-tip tk-tip${x(point) / FRAME.width > 0.62 ? ' flip' : ''}`} style={{ left: `${(x(point) / FRAME.width) * 100}%` }} role="status">
        <div className="tk-tip-head"><span>{hours ? hourName(point) : LONG_DAY.format(new Date(`${days[point]}T00:00:00Z`))}</span>{point === best && totals[point]! > 0 && <span className="m-badge gold">{hours ? 'Busiest hour' : 'Best day'}</span>}</div>
        <div className="tk-tip-total"><b>{format(totals[point]!)}</b>{costs && <span>{formatCost(series.reduce((sum, item) => sum + (item.costs?.[point] ?? 0), 0))}</span>}</div>
        {series.map((item) => <div key={item.key} className="tk-tip-row"><i style={{ background: item.color }} /><span>{item.label}</span><b>{format(item.values[point] ?? 0)}</b>{costs && <span>{item.costs ? formatCost(item.costs[point] ?? 0) : ''}</span>}</div>)}
      </div>}
    </div>
    <table className="sr-only"><caption>{label}</caption>
      <thead><tr><th scope="col">{hours ? 'Hour' : 'Day'}</th>{series.map((item) => <th key={item.key} scope="col">{item.label}</th>)}<th scope="col">Total</th></tr></thead>
      <tbody>{days.map((day, index) => <tr key={day}><th scope="row">{hours ? hourName(index) : day}</th>{series.map((item) => <td key={item.key}>{format(item.values[index] ?? 0)}</td>)}<td>{format(totals[index]!)}</td></tr>)}</tbody>
    </table>
  </div>;
}

/** A year of daily totals as a quiet area, with the chart's window lit and framed, and month initials below. */
export function OverviewStrip({ days, from }: { days: Array<{ day: string; tokens: number }>; from: string }) {
  const id = useId().replace(/[^\w-]/g, '');
  if (days.length < 2) return null;
  const max = Math.max(1, ...days.map((day) => day.tokens));
  const x = (index: number) => round((index / (days.length - 1)) * FRAME.width);
  const area = `M0,32${days.map((day, index) => `L${x(index)},${round(32 - (day.tokens / max) * 26)}`).join('')}L${FRAME.width},32Z`;
  const start = Math.max(0, days.findIndex((day) => day.day >= from));
  const left = x(start), width = FRAME.width - left;
  const months = days.flatMap((day, index) => day.day.endsWith('-01') ? [{ index, name: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(`${day.day}T00:00:00Z`)) }] : []);
  return <svg className="tk-strip" viewBox={`0 0 ${FRAME.width} 46`} role="img" aria-label={`Last 12 months, with ${shortDay(days[start]!.day)} to ${shortDay(days.at(-1)!.day)} highlighted`}>
    <defs><clipPath id={`${id}-win`}><rect x={left} y="0" width={width} height="32" /></clipPath></defs>
    <path className="tk-strip-base" d={area} />
    <path className="tk-strip-sel" d={area} clipPath={`url(#${id}-win)`} />
    <rect className="tk-strip-win" x={left} y="1" width={Math.max(4, width - 1)} height="31" rx="4" />
    <rect className="tk-strip-handle" x={left - 2} y="9" width="4" height="14" rx="2" />
    {months.map((month) => <text key={month.index} x={x(month.index)} y="44">{month.name}</text>)}
  </svg>;
}
