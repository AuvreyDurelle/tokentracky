import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { formatExact, shortDay } from './format';

const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const LEVELS = 4;

/** 0 for no usage, else 1–4 by quartile of the active days, so one huge day doesn't flatten the rest. */
export function heatLevels(values: number[]): number[] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  const cut = (share: number) => active[Math.max(0, Math.ceil(active.length * share) - 1)]!;
  const bounds = active.length ? [cut(0.25), cut(0.5), cut(0.75)] : [];
  return values.map((value) => value <= 0 ? 0 : 1 + bounds.filter((bound) => value > bound).length);
}

/** Calendar of daily tokens, Monday-first UTC weeks as columns. Hover, focus and arrow keys read each day; a hidden table carries every value. */
export function Heatmap({ days, label }: { days: Array<{ day: string; tokens: number }>; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Narrow screens scroll the calendar: start at the latest week, not a year ago.
  useEffect(() => { if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth; }, [days.length]);
  if (days.length === 0) return null;
  const levels = heatLevels(days.map((day) => day.tokens));
  // Pad the first column so each row is one weekday.
  const lead = (new Date(`${days[0]!.day}T00:00:00Z`).getUTCDay() + 6) % 7;
  const weeks = Math.ceil((lead + days.length) / 7);
  const months = days.flatMap((day, index) => day.day.endsWith('-01') || index === 0
    ? [{ column: Math.floor((lead + index) / 7), name: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(`${day.day}T00:00:00Z`)) }] : [])
    // A partial first month too narrow for its name is left unlabelled.
    .filter((month, index, all) => index + 1 >= all.length || all[index + 1]!.column - month.column >= 3);
  const last = days.length - 1;
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? last;
    const next = { ArrowLeft: from - 7, ArrowRight: from + 7, ArrowUp: from - 1, ArrowDown: from + 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault(); setActive(Math.max(0, Math.min(last, next)));
  };
  const point = active === null ? null : days[active]!;
  const activeDays = days.filter((day) => day.tokens > 0);
  return <figure className="heatmap" aria-label={label}>
    <div className="heat-scroll" ref={scroller}>
      <div className="heat-body" style={{ ['--weeks' as string]: weeks }}>
        <div className="heat-months" aria-hidden="true">{months.map((month) => <span key={`${month.column}${month.name}`} style={{ gridColumn: month.column + 1 }}>{month.name}</span>)}</div>
        <div className="heat-weekdays" aria-hidden="true">{WEEKDAYS.map((day, index) => <span key={index}>{day}</span>)}</div>
        <div className="heat-grid" tabIndex={0} aria-label={`${label}. Use arrow keys to read each day.`} onKeyDown={step}
          onFocus={() => setActive((value) => value ?? last)} onBlur={() => setActive(null)} onPointerLeave={(event) => { if (event.pointerType !== 'touch') setActive(null); }}>
          {Array.from({ length: lead }, (_, index) => <i key={`pad${index}`} className="pad" aria-hidden="true" />)}
          {days.map((day, index) => <i key={day.day} className={`l${levels[index]}${active === index ? ' on' : ''}`} aria-hidden="true" onPointerEnter={() => setActive(index)} />)}
        </div>
      </div>
    </div>
    <figcaption className="heat-foot">
      {/* A readout instead of a floating tooltip: the scrolling grid would clip one. */}
      <span className="heat-readout" role="status">{point ? <><strong>{point.tokens ? `${formatExact(point.tokens)} tokens` : 'No usage'}</strong> · {shortDay(point.day)}, UTC</> : 'Hover, tap or focus a day to read it'}</span>
      <span className="heat-legend" aria-hidden="true">Less{Array.from({ length: LEVELS + 1 }, (_, level) => <i key={level} className={`l${level}`} />)}More</span>
    </figcaption>
    <table className="sr-only"><caption>{label}: {activeDays.length} days with usage</caption><thead><tr><th>Day</th><th>Tokens</th></tr></thead>
      <tbody>{activeDays.map((day) => <tr key={day.day}><td>{day.day}</td><td>{day.tokens}</td></tr>)}</tbody></table>
  </figure>;
}
