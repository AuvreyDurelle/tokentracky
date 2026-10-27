import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatCompact, formatExact, niceTicks, shortDay } from './format';

const W = 1000;
const H = 100;

/** Running totals for stacked layers: `tops[i][d]` is layers 0 to i summed on day d, so the last row is each day's total. */
export function stackTops(layers: number[][]): number[][] {
  const sums: number[] = [];
  return layers.map((values) => values.map((value, day) => { sums[day] = (sums[day] ?? 0) + value; return sums[day]; }));
}

/** One daily series as an area (tokens by default; pass `value`/`tick` for cost), optionally over a dashed previous period aligned day by day. `stacks` splits each day into layers that add up to its value, drawn bottom first. Pointer or arrow keys move a crosshair; a hidden table carries every value. */
export function TrendChart({ points, previous, stacks, label, value = formatExact, tick = formatCompact }: { points: Array<{ day: string; tokens: number }>; previous?: number[]; stacks?: Array<{ label: string; className: string; values: number[] }>; label: string; value?: (n: number) => string; tick?: (n: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  const ticks = niceTicks(Math.max(0, ...points.map((point) => point.tokens), ...(previous ?? [])));
  const top = ticks.at(-1) || 1;
  const x = (index: number) => (points.length > 1 ? (index / (points.length - 1)) * 100 : 50);
  const y = (tokens: number) => 100 - (tokens / top) * 100;
  const at = (index: number, value: number) => `${(x(index) * W) / 100},${(y(value) * H) / 100}`;
  const path = (values: number[]) => values.map((value, index) => `${index ? 'L' : 'M'}${at(index, value)}`).join('');
  const line = path(points.map((point) => point.tokens));
  const tops = stacks && stackTops(stacks.map((layer) => layer.values));
  // A layer runs along its top edge, then back along the layer below it (the baseline for the first).
  const band = (index: number) => `${path(tops![index]!)}${(tops![index - 1] ?? points.map(() => 0)).map((value, day) => `L${at(day, value)}`).reverse().join('')}Z`;
  const last = points.length - 1;
  const clamp = (index: number) => Math.max(0, Math.min(last, index));
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(clamp(Math.round(((event.clientX - box.left) / box.width) * last)));
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = { ArrowLeft: (active ?? last) - 1, ArrowRight: (active ?? last) + 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault(); setActive(clamp(next));
  };
  const point = active === null ? null : points[active];
  // The tooltip sits beside the crosshair, flipping left near the right edge.
  const edge = active !== null && x(active) > 70 ? ' end' : '';
  if (points.length === 0) return null;
  return <figure className="trend" aria-label={label}>
    <div className="trend-plot" tabIndex={0} aria-label={`${label}. Use arrow keys to read each day.`}
      onPointerMove={pick} onPointerLeave={() => setActive(null)} onKeyDown={step} onFocus={() => setActive((value) => value ?? last)} onBlur={() => setActive(null)}>
      {ticks.map((mark) => <div key={mark} className="gridline" style={{ bottom: `${(mark / top) * 100}%` }} aria-hidden="true"><span>{tick(mark)}</span></div>)}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {stacks && tops ? <>
          {stacks.map((layer, index) => <path key={layer.label} className={`trend-layer ${layer.className}`} d={band(index)} />)}
          {tops.slice(0, -1).map((seam, index) => <path key={stacks[index]!.label} className="trend-seam" d={path(seam)} />)}
        </> : <path className="trend-area" d={`${line}L${W},${H}L0,${H}Z`} />}
        {previous && <path className="trend-prev" d={path(previous)} />}
        {!stacks && <path className="trend-line" d={line} />}
      </svg>
      {point && active !== null && <>
        <div className="crosshair" style={{ left: `${x(active)}%` }} aria-hidden="true" />
        <div className="trend-dot" style={{ left: `${x(active)}%`, top: `${y(point.tokens)}%` }} aria-hidden="true" />
        <div className={`tooltip${edge}`} style={{ left: `${x(active)}%` }} role="status"><strong>{value(point.tokens)}</strong>{stacks?.map((layer) => <span key={layer.label}>{layer.label} {value(layer.values[active] ?? 0)}</span>)}<span>{shortDay(point.day)} · UTC</span>{previous && <span>Previous period {value(previous[active] ?? 0)}</span>}</div>
      </>}
    </div>
    <div className="chart-x" aria-hidden="true"><span>{shortDay(points[0]!.day)}</span><span>{shortDay(points[Math.floor(last / 2)]!.day)}</span><span>{points[last]!.day === new Date().toISOString().slice(0, 10) ? 'Today' : shortDay(points[last]!.day)}</span></div>
    <table className="sr-only"><caption>{label}</caption><thead><tr><th>Day</th>{stacks?.map((layer) => <th key={layer.label}>{layer.label}</th>)}<th>{stacks ? 'Total' : 'Value'}</th>{previous && <th>Previous period</th>}</tr></thead>
      <tbody>{points.map((item, index) => <tr key={item.day}><td>{item.day}</td>{stacks?.map((layer) => <td key={layer.label}>{value(layer.values[index] ?? 0)}</td>)}<td>{value(item.tokens)}</td>{previous && <td>{value(previous[index] ?? 0)}</td>}</tr>)}</tbody></table>
  </figure>;
}

/** Daily activity as tiny columns, oldest first, ending on `end`'s UTC day. Quiet days keep a baseline tick. */
export function Sparkline({ values, end, size, mine }: { values: number[]; end: string; size?: 'lg'; mine?: boolean }) {
  const max = Math.max(0, ...values);
  const endDay = Date.parse(`${end.slice(0, 10)}T00:00:00Z`);
  const day = (index: number) => shortDay(new Date(endDay - (values.length - 1 - index) * 86_400_000).toISOString().slice(0, 10));
  const total = values.reduce((sum, value) => sum + value, 0);
  const active = values.filter(Boolean).length;
  return <div className={`spark${size ? ` ${size}` : ''}${mine ? ' mine' : ''}`} role="img"
    aria-label={`Last ${values.length} days: ${formatExact(total)} tokens over ${active} active ${active === 1 ? 'day' : 'days'}`}>
    {values.map((value, index) => <i key={index} className={value ? undefined : 'zero'} title={`${day(index)}: ${formatExact(value)} tokens`}
      style={value ? { height: `${Math.max(8, (value / max) * 100)}%` } : undefined} />)}
  </div>;
}
