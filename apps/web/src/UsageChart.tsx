import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { niceTicks } from './format';
import { monotonePath } from './mac/chart';

export interface ChartPoint { at: string; value: number }

// The frame in pixels: y labels left of the plot, x labels under it.
const H = 236, TOP = 22, BASE = 200, LEFT = 46, PAD = 14;
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * A smooth pink line over evenly spaced points with a soft fill and a hairline grid, drawn at the width it is given so
 * its labels keep their size. Optional extras: shaded points (weekends), a dashed average, the best point marked, and the
 * last point dotted while it is still under way. Pointer or arrow keys move a crosshair and `tip` says what the point
 * holds; a hidden table carries every value.
 */
export function UsageChart({ points, label, value, tick, axis, tip, average, best, partial = false, shade }: {
  points: ChartPoint[]; label: string; value: (n: number) => string; tick: (n: number) => string; axis: (index: number) => string | null;
  tip: (index: number) => ReactNode; average?: number; best?: { index: number; text: string } | null; partial?: boolean; shade?: (index: number) => boolean;
}) {
  const id = useId().replace(/:/g, '');
  const [box, width] = useWidth(720);
  const [active, setActive] = useState<number | null>(null);
  if (points.length === 0) return null;
  const last = points.length - 1;
  const RIGHT = width - PAD;
  const ticks = niceTicks(Math.max(0, ...points.map((point) => point.value), average ?? 0));
  const top = ticks.at(-1) || 1;
  const x = (index: number) => round(points.length > 1 ? LEFT + (index / last) * (RIGHT - LEFT) : (LEFT + RIGHT) / 2);
  const y = (n: number) => round(BASE - (n / top) * (BASE - TOP));
  const xy = points.map((point, index) => [x(index), y(point.value)] as [number, number]);
  // While the last point is under way, the line stops at the one before and a dotted piece reaches it.
  const settled = partial && points.length > 2 ? xy.slice(0, -1) : xy;
  const line = monotonePath(settled);
  const step = points.length > 1 ? (RIGHT - LEFT) / last : RIGHT - LEFT;
  const clamp = (index: number) => Math.max(0, Math.min(last, index));
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    setActive(clamp(Math.round(((px - LEFT) / (RIGHT - LEFT)) * last)));
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = { ArrowLeft: (active ?? last) - 1, ArrowRight: (active ?? last) + 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault(); setActive(clamp(next));
  };
  // A touch ends by leaving, so its reading stays until another tap or blur; a mouse or pen clears it on the way out.
  const leave = (event: PointerEvent<HTMLDivElement>) => { if (event.pointerType !== 'touch') setActive(null); };
  // A touch reading outlives a switch to fewer points (daily to weekly); past the end it shows nothing.
  const at = active !== null && active <= last ? active : null;
  const ax = at === null ? 0 : x(at);
  // An x label (about 6px a character) that would come within 8px of the one before it is dropped; the last always
  // shows, so a label it would crowd goes instead.
  const labels: Array<{ index: number; text: string; right: number }> = [];
  points.forEach((_, index) => {
    const text = axis(index);
    if (!text) return;
    const w = text.length * 6;
    const left = index === 0 ? x(index) : index === last ? x(index) - w : x(index) - w / 2;
    const crowds = () => labels.length > 0 && labels.at(-1)!.right + 8 > left;
    if (index < last && crowds()) return;
    while (index === last && crowds()) labels.pop();
    labels.push({ index, text, right: left + w });
  });
  return <figure className="uc" aria-label={label}>
    <div className="uc-plot" ref={box} tabIndex={0} aria-label={`${label}. Use arrow keys to read each point.`}
      onPointerDown={pick} onPointerMove={pick} onPointerLeave={leave} onKeyDown={key} onFocus={() => setActive((current) => current ?? last)} onBlur={() => setActive(null)}>
      <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} aria-hidden="true">
        <defs>
          <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ec4899" stopOpacity=".3" /><stop offset=".55" stopColor="#ec4899" stopOpacity=".09" /><stop offset="1" stopColor="#ec4899" stopOpacity="0" /></linearGradient>
          <linearGradient id={`${id}s`} gradientUnits="userSpaceOnUse" x1={LEFT} y1="0" x2={RIGHT} y2="0"><stop offset="0" stopColor="#c03f80" /><stop offset=".45" stopColor="#f472b6" /><stop offset="1" stopColor="#f9a8d4" /></linearGradient>
        </defs>
        {shade && points.map((_, index) => shade(index) && <rect key={index} x={round(Math.max(LEFT, x(index) - step / 2))} y={TOP} width={round(Math.min(step, x(index) + step / 2 - Math.max(LEFT, x(index) - step / 2)))} height={BASE - TOP} className="uc-band" />)}
        {ticks.map((mark) => <g key={mark}><line x1={LEFT} x2={RIGHT} y1={y(mark)} y2={y(mark)} className={mark ? 'uc-grid' : 'uc-base'} /><text x={LEFT - 10} y={y(mark) + 3.5} textAnchor="end" className="uc-ax">{tick(mark)}</text></g>)}
        <path d={`${line} L${settled.at(-1)![0]},${BASE} L${xy[0]![0]},${BASE} Z`} fill={`url(#${id}f)`} />
        {average !== undefined && average > 0 && <line x1={LEFT} x2={RIGHT} y1={y(average)} y2={y(average)} className="uc-avg" />}
        <path d={line} fill="none" stroke={`url(#${id}s)`} className="uc-line" />
        {partial && points.length > 2 && <path d={monotonePath(xy.slice(-2))} className="uc-partial" />}
        {partial && <circle cx={xy[last]![0]} cy={xy[last]![1]} r="3" className="uc-now" />}
        {best && points[best.index] && <Best x={x(best.index)} y={y(points[best.index]!.value)} text={best.text} min={LEFT} max={RIGHT} />}
        {labels.map(({ index, text }) => <text key={index} x={x(index)} y={H - 10} textAnchor={index === 0 ? 'start' : index === last ? 'end' : 'middle'} className={`uc-ax${index === active ? ' on' : ''}`}>{text}</text>)}
        {at !== null && <>
          <line x1={ax} x2={ax} y1={TOP} y2={BASE} className="uc-cross" />
          <circle cx={ax} cy={y(points[at]!.value)} r="9" className="uc-halo" />
          <circle cx={ax} cy={y(points[at]!.value)} r="3.5" className="uc-dot" />
        </>}
      </svg>
      {at !== null && <div className={`uc-tip${ax > width * 0.62 ? ' end' : ''}`} style={{ left: ax }} role="status">{tip(at)}</div>}
    </div>
    <table className="sr-only"><caption>{label}</caption><tbody>{points.map((point) => <tr key={point.at}><th scope="row">{point.at}</th><td>{value(point.value)}</td></tr>)}</tbody></table>
  </figure>;
}

/** The best point: a ring on the line and a pill above it, kept inside the plot. */
function Best({ x, y, text, min, max }: { x: number; y: number; text: string; min: number; max: number }) {
  const w = text.length * 6.2 + 26;
  const left = Math.max(min, Math.min(max - w, x - w / 2));
  const top = Math.max(2, y - 30);
  return <g className="uc-best">
    <circle cx={x} cy={y} r="3" />
    <rect x={round(left)} y={top} width={round(w)} height="18" rx="9" />
    <text x={round(left + w / 2)} y={top + 12.5} textAnchor="middle">{text}</text>
  </g>;
}

/** An element's width in CSS pixels, kept current as the window resizes; `initial` until it is first measured. */
function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry!.contentRect.width))));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
