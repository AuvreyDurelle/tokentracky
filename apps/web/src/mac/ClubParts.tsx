/** The clubs pages' game pieces: the week's clock, places, the rope two clubs pull on, and their icons. */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { clubWeek, type ChallengeKind } from '@tokentracky/core';
import { clubHue } from '../ClubMark';
import { formatCompact, formatExact } from '../format';
import { timeLeft, weekProgress } from './clubs-model';

/** The time now, read again every `every` ms while mounted. */
export function useNow(every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}

/** A club's colour as the `--h` its styles read. */
export const hue = (slug: string) => ({ '--h': clubHue(slug) }) as CSSProperties;
/** Gold, silver and bronze for the top three places. */
export const place = (rank: number | null | undefined) => rank && rank <= 3 ? ` p${rank}` : '';

const pad = (value: number) => String(value).padStart(2, '0');
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The week's clock: the time to Monday 00:00 UTC, ticking each second, red on the last day, over the days gone. */
export function WeekClock({ label = 'Week ends in' }: { label?: string }) {
  const now = useNow();
  const left = timeLeft(Date.parse(clubWeek(new Date(now)).end), now);
  const { done, day } = weekProgress(new Date(now));
  const units: Array<[number, string]> = left.days ? [[left.days, 'd'], [left.hours, 'h'], [left.minutes, 'm']] : [[left.hours, 'h'], [left.minutes, 'm'], [left.seconds, 's']];
  const text = units.map(([value, unit]) => `${value}${unit}`).join(' ');
  return <div className={`mc-clock${left.days ? '' : ' final'}`} role="timer" aria-label={`${label} ${text}`}>
    <div className="mc-clock-k">{left.days ? label : <><span className="mc-ping" />Final day · ends in</>}</div>
    <div className="mc-clock-v" aria-hidden="true">{units.map(([value, unit]) => <span key={unit}><b>{pad(value)}</b><i>{unit}</i></span>)}</div>
    <div className="mc-days" aria-hidden="true"><span className="mc-days-fill" style={{ width: `${Math.min(1, done) * 100}%` }} />{DAYS.map((name, index) => <i key={name} className={index < day ? 'past' : index === day ? 'today' : undefined}>{name[0]}</i>)}</div>
  </div>;
}

/** Ahead, behind or level, as a pill. */
export function Verdict({ us, them }: { us: number; them: number }) {
  const kind = us > them ? 'lead' : us < them ? 'trail' : 'level';
  return <span className={`mc-verdict ${kind}`}>{kind === 'lead' ? 'Leading' : kind === 'trail' ? 'Trailing' : 'Level'}</span>;
}

/** Two clubs' tokens per active member as a rope: each side in its colour, the knot where they meet. */
export function Rope({ a, b, aValue, bValue, label }: { a: string; b: string; aValue: number; bValue: number; label: string }) {
  const at = aValue + bValue > 0 ? aValue / (aValue + bValue) : 0.5;
  return <div className="mc-rope" role="img" aria-label={label} style={{ '--ha': clubHue(a), '--hb': clubHue(b), '--at': `${(at * 100).toFixed(1)}%` } as CSSProperties}><i className="a" /><i className="b" /><b /></div>;
}

/** Days a club led its matchup, as pips. */
export function DayPips({ led, days }: { led: number; days: number }) {
  return <span className="mc-pips" title={`Led after ${formatExact(led)} of ${formatExact(days)} ${days === 1 ? 'day' : 'days'}`}>{Array.from({ length: days }, (_, index) => <i key={index} className={index < led ? 'on' : undefined} />)}</span>;
}

/** Small bars for a run of days, the last one lit in the club's colour. */
export function Bars({ values, label }: { values: readonly number[]; label: string }) {
  const max = Math.max(1, ...values);
  return <span className="mc-bars" role="img" aria-label={label}>{values.map((value, index) => <i key={index} style={{ height: `${Math.max(6, (value / max) * 100)}%` }} title={formatCompact(value)} />)}</span>;
}

/** A share of a whole as a thin meter. */
export function Meter({ value, of, tone }: { value: number; of: number; tone?: 'gold' | 'hue' }) {
  return <span className={`mc-meter${tone ? ` ${tone}` : ''}`} aria-hidden="true"><i style={{ width: `${of > 0 ? Math.min(100, (value / of) * 100) : 0}%` }} /></span>;
}

const icon = (body: ReactNode, fill = false) => <svg className="mc-ic" viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{body}</svg>;
export const TROPHY = icon(<><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 4M17 6h2.5a2.5 2.5 0 0 1-2.6 4" /></>);
export const CROWN = icon(<path d="M3 8.5 7.5 12 12 5l4.5 7L21 8.5 19 18H5z" />, true);
export const SWORDS = icon(<><path d="M14.5 17.5 3 6V3h3l11.5 11.5" /><path d="m13 19 6-6M16 16l4 4M19 21l2-2M14.5 6.5 18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2" /></>);
export const FLAME = icon(<path d="M12 2c.6 3.2-1.4 5-2.9 6.6C7.6 10.2 6 12 6 14.6A6 6 0 0 0 12 21a6 6 0 0 0 6-6.2c0-2.6-1.4-4.3-2.5-5.6-.3 1.5-1 2.5-2.1 3 .4-3.3-.3-6.5-1.4-9.2Z" />, true);
export const BOLT = icon(<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z" />, true);
export const TARGET = icon(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>);
export const STACK = icon(<><path d="m12 3 9 4.5-9 4.5-9-4.5z" /><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" /></>);
/** Each challenge's emblem and colour. */
export const CHALLENGE_ICON: Record<ChallengeKind, ReactNode> = { tokens: STACK, streak: FLAME, 'big-day': BOLT, cache: TARGET };

export interface PodiumPlace { key: string; name: string; value: string; title?: string; sub?: ReactNode; face: ReactNode; you?: boolean; onOpen?: () => void }
/** The top three on steps, first in the middle with the crown; read in rank order, drawn second, first, third. */
export function Podium({ places, label }: { places: readonly PodiumPlace[]; label: string }) {
  return <ol className="mc-podium" aria-label={label}>{places.slice(0, 3).map((entry, index) => {
    const body = <>
      <span className="mc-step-face">{index === 0 && <span className="mc-crown">{CROWN}</span>}{entry.face}</span>
      <span className="mc-step-name"><span>{entry.name}</span>{entry.you && <span className="m-badge accent">You</span>}</span>
      <b className="mc-step-val" title={entry.title}>{entry.value}</b>
      {entry.sub && <span className="mc-step-sub">{entry.sub}</span>}
      <span className="mc-step-block" aria-hidden="true">{index + 1}</span>
    </>;
    return <li key={entry.key} className={`mc-step s${index + 1}${entry.you ? ' you' : ''}`}>{entry.onOpen ? <button type="button" onClick={entry.onOpen}>{body}</button> : <div>{body}</div>}</li>;
  })}</ol>;
}
