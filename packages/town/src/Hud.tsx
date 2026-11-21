import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BUILDINGS, RESOURCE_IDS, type BuildingId, type Cost, type ResourceId, type Resources } from '@tokentracky/core';
import { GlyphIcon, ResourceIcon } from './icons.tsx';
import { createArt, isoProjection, SCENE_DEFS } from './art.ts';
import { compact, count, duration, tweenAt, untilDayEnds } from './format.ts';

export const RESOURCE_NAMES: Record<ResourceId, string> = {power: 'Power', bricks: 'Bricks', water: 'Water', crystals: 'Crystals'};
const BAR: Record<ResourceId, string> = {power: '#ffd23f', bricks: '#e0784a', water: '#4cc3f0', crystals: '#b18cff'};

/** The town's name plate: an initial, the name and its level. */
export function Crest({alias, level, plots, children}: {alias: string; level: number; plots: number; children?: ReactNode}) {
  return <div className="tt-glass tt-who">
    <div className="tt-crest" aria-hidden="true">{alias.slice(0, 1).toUpperCase()}</div>
    <div><b>{alias}'s Town</b><span className="tt-lv"><em>Lv {level}</em>{plots} {plots === 1 ? 'plot' : 'plots'}</span></div>
    {children}
  </div>;
}

/** A number that counts to each new value over `ms` instead of jumping, unless motion is reduced. */
export function useTween(value: number, ms = 700): number {
  const [shown, setShown] = useState(value);
  const current = useRef(shown);
  current.current = shown;
  useEffect(() => {
    const from = current.current;
    if (from === value) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); return; }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = (now - start) / ms;
      setShown(tweenAt(from, value, t));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return shown;
}

/** Each store with its fill. A store 80% full warns, in amber, that the next harvest may spill; a full one turns red. */
export function ResourceBar({wallet, caps}: {wallet: Resources; caps: Resources}) {
  return <div className="tt-glass tt-res" role="list" aria-label="Your stores">
    {RESOURCE_IDS.map(id => <Store key={id} id={id} have={wallet[id]} cap={caps[id]} />)}
  </div>;
}
/** One store. It counts up to what it now holds, and harvest bubbles fly to it (`data-store`). */
function Store({id, have, cap}: {id: ResourceId; have: number; cap: number}) {
  const shown = useTween(have);
  const fill = cap > 0 ? Math.min(1, shown / cap) : 0;
  const level = fill >= 1 ? 'full' : fill >= 0.8 ? 'warm' : null;
  // A store of six figures or more reads better short, both numbers alike; the whole numbers show on hover.
  const short = (n: number) => cap >= 100_000 ? compact(n) : count(n);
  return <div role="listitem" data-store={id} className={level ? `tt-rs ${level}` : 'tt-rs'} title={`${RESOURCE_NAMES[id]}: ${count(have)} of ${count(cap)}`} aria-label={`${RESOURCE_NAMES[id]} ${count(have)} of ${count(cap)}`}>
    <ResourceIcon id={id} size={22} />
    <div><b>{short(shown)}</b><s>/ {short(cap)}</s><span className="tt-meter"><i style={{width: `${fill * 100}%`, background: level === 'full' ? '#ff6b5b' : level === 'warm' ? '#ffb648' : BAR[id]}} /></span></div>
    {level && <span className="tt-full">{level === 'full' ? 'Full' : `${Math.round(fill * 100)}% full`}</span>}
  </div>;
}

/** The streak, and how long is left of the game's day, which ends at midnight UTC. */
export function StreakClock({streak, now, children}: {streak?: number; now: number; children?: ReactNode}) {
  const date = new Date(now);
  const time = date.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', timeZone: 'UTC'});
  // Minutes are enough; the clock refreshes every 30 seconds.
  const left = duration(Math.max(60, Math.floor(untilDayEnds(now) / 60) * 60));
  return <div className="tt-glass tt-clk">
    {streak !== undefined && <span className="tt-stk"><GlyphIcon id="flame" size={22} /><span><b>{streak}</b>-day streak</span></span>}
    {children}
    <span className="tt-mu" title={`It's ${time} UTC. Each day in Token Town runs midnight to midnight UTC.`}>Day ends in {left}</span>
  </div>;
}

/** A price as chips, each ticked when the stores cover it. */
export function CostChips({cost, have}: {cost: Cost; have?: Resources}) {
  const parts = RESOURCE_IDS.filter(id => (cost[id] ?? 0) > 0);
  if (!parts.length) return <span className="tt-cost"><span>Free</span></span>;
  return <span className="tt-cost">
    {parts.map(id => <span key={id} aria-label={`${count(cost[id]!)} ${RESOURCE_NAMES[id]}`}><ResourceIcon id={id} size={15} />{count(cost[id]!)}
      {have && (have[id] >= cost[id]! ? <b className="tt-ok" aria-label="enough">✓</b> : <b className="tt-no" aria-label="not enough">✗</b>)}</span>)}
  </span>;
}

/** A small drawing of one building, for cards. */
export function BuildingThumb({kind, level = 1, size = 64}: {kind: BuildingId; level?: number; size?: number}) {
  const art = createArt(isoProjection(64, 150), `th-${kind}-`);
  const body = art.building(kind, 0, 0, level);
  return <svg className="tt-thumb" width={size} height={size} viewBox={kind === 'token-tower' ? '0 -60 128 230' : '0 30 128 150'} aria-hidden="true"
    dangerouslySetInnerHTML={{__html: `<defs>${SCENE_DEFS}${art.defs}</defs>${art.poly(art.sq(0, 0, 2, 2), '#2b3d4a')}${body}`}} />;
}
export const buildingName = (kind: BuildingId) => BUILDINGS[kind].name;

/** Shows a message for a few seconds. */
export function useToast(): [ReactNode, (message: string, tone?: 'error' | 'ok') => void] {
  const [toast, setToast] = useState<{message: string; tone: 'error' | 'ok'; at: number} | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const node = toast && <div key={toast.at} className={`tt-glass tt-toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>{toast.message}</div>;
  return [node, (message, tone = 'error') => setToast({message, tone, at: Date.now()})];
}

/** The time, refreshed every 30 seconds for the streak clock and "6h of coding". */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
