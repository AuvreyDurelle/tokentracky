import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ActivityStats } from '@tokentracky/core';
import { formatCompact, formatExact, shortDay } from '../format';
import { heatLevels } from '../Heatmap';

// The mockup's geometry: 15px cells on a 19px pitch, after the weekday labels and below the month labels.
const CELL = 15, PITCH = 19, LEFT = 34, TOP = 22;
const WEEKDAYS = [['Mon', 0], ['Wed', 2], ['Fri', 4]] as const;
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
/** Where day `index` sits, after `lead` blank days pad the first column so each row is one weekday. */
const place = (lead: number, index: number) => ({ column: Math.floor((lead + index) / 7), x: LEFT + Math.floor((lead + index) / 7) * PITCH, y: TOP + ((lead + index) % 7) * PITCH });
const dayCount = (count: number) => <>{count} <small>{count === 1 ? 'day' : 'days'}</small></>;
const MOVES: Record<string, (from: number, last: number) => number> = {
  ArrowLeft: (from) => from - 7, ArrowRight: (from) => from + 7, ArrowUp: (from) => from - 1, ArrowDown: (from) => from + 1, Home: () => 0, End: (_, last) => last,
};

/** The day a key moves the readout to: a week sideways, a day up or down, or either end, starting from the last day. Null for other keys. */
export function nextDay(from: number | null, key: string, last: number): number | null {
  if (!Object.hasOwn(MOVES, key)) return null;
  return Math.max(0, Math.min(last, MOVES[key]!(from ?? last, last)));
}

/** A year of daily tokens in Monday-first UTC week columns, with its streaks. Hover, focus and arrow keys read each day; a hidden table carries every value. */
export function ActivityGrid({ days, stats, label }: { days: Array<{ day: string; tokens: number }>; stats: ActivityStats; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const lead = days.length ? (utc(days[0]!.day).getUTCDay() + 6) % 7 : 0;
  // A year of cells, redrawn when the data changes rather than for every day the pointer crosses.
  const cells = useMemo(() => {
    const levels = heatLevels(days.map((day) => day.tokens));
    return days.map((day, index) => { const { x, y } = place(lead, index); return <rect key={day.day} x={x} y={y} width={CELL} height={CELL} rx="3" className={`h${levels[index]}`} onPointerEnter={() => setActive(index)} />; });
  }, [days, lead]);
  if (days.length === 0) return null;
  const weeks = Math.ceil((lead + days.length) / 7);
  const width = LEFT + weeks * PITCH - (PITCH - CELL), height = TOP + 7 * PITCH - (PITCH - CELL);
  const months = days.flatMap((day, index) => day.day.endsWith('-01') || index === 0
    ? [{ column: place(lead, index).column, name: MONTH.format(utc(day.day)) }] : [])
    // A partial first month too narrow for its name is left unlabelled.
    .filter((month, index, all) => index + 1 >= all.length || all[index + 1]!.column - month.column >= 3);
  const last = days.length - 1;
  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    const next = nextDay(active, event.key, last);
    if (next === null) return;
    event.preventDefault(); setActive(next);
  };
  // A shorter year can arrive while a day is held: read nothing rather than past the end.
  const point = active === null || active > last ? null : { ...days[active]!, ...place(lead, active) };
  // The tip sits beside the day, on whichever side has room.
  const flip = point !== null && point.column < weeks / 2;
  const readout = point && <><b>{point.tokens ? `${formatCompact(point.tokens)} tokens` : 'No usage'}</b> · {LONG_DAY.format(utc(point.day))}</>;
  const activeDays = days.filter((day) => day.tokens > 0);
  return <section className="card activity">
    <div className="card-head"><span className="card-title">{label}</span><span className="right">UTC</span></div>
    <div className="heat-body">
      <div className="heat-box">
        <svg className="heat" viewBox={`0 0 ${width} ${height}`} role="application" tabIndex={0} aria-label={`${label}. Use arrow keys to read each day.`} onKeyDown={step}
          onFocus={() => setActive((value) => value ?? last)} onBlur={() => setActive(null)} onPointerLeave={() => setActive(null)}>
          {months.map((month) => <text key={`${month.column}${month.name}`} x={LEFT + month.column * PITCH} y="12">{month.name}</text>)}
          {WEEKDAYS.map(([name, row]) => <text key={name} x="0" y={TOP + row * PITCH + 12}>{name}</text>)}
          {cells}
          {point && <rect className="hov" x={point.x - 2} y={point.y - 2} width={CELL + 4} height={CELL + 4} rx="4.5" />}
        </svg>
        {point && <div className={`tip heat-tip${flip ? ' flip' : ''}`} aria-hidden="true"
          style={{ left: `${((flip ? point.x + CELL + 2 : point.x - 2) / width) * 100}%`, top: `${((point.y + CELL / 2) / height) * 100}%` }}>{readout}</div>}
        <span className="sr-only" role="status">{readout}</span>
      </div>
      <div className="heat-foot">
        <span>Hover or focus a day to read it</span>
        <div className="heat-legend" aria-hidden="true"><span>Less</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} style={{ background: `var(--heat-${level})` }} />)}<span>More</span></div>
      </div>
    </div>
    <div className="stat-strip">
      <Stat label="Active days">{formatExact(stats.activeDays)}</Stat>
      <Stat label="Current streak">{dayCount(stats.currentStreak)}</Stat>
      <Stat label="Longest streak">{dayCount(stats.longestStreak)}</Stat>
      <Stat label="Best day" title={stats.bestDay ? `${formatExact(stats.bestDay.tokens)} tokens` : undefined}>{stats.bestDay ? <>{formatCompact(stats.bestDay.tokens)} <small>{shortDay(stats.bestDay.day)}</small></> : '—'}</Stat>
      <Stat label="Average per active day" title={stats.activeDays ? `${formatExact(stats.averagePerActiveDay)} tokens` : undefined}>{stats.activeDays ? formatCompact(stats.averagePerActiveDay) : '—'}</Stat>
    </div>
    <table className="sr-only"><caption>{label}: {activeDays.length} days with usage</caption><thead><tr><th>Day</th><th>Tokens</th></tr></thead>
      <tbody>{activeDays.map((day) => <tr key={day.day}><td>{day.day}</td><td>{day.tokens}</td></tr>)}</tbody></table>
  </section>;
}

function Stat({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return <div><div className="label">{label}</div><div className="stat-value" title={title}>{children}</div></div>;
}
