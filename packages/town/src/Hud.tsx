import { useEffect, useState, type ReactNode } from 'react';
import { BUILDINGS, RESOURCE_IDS, type BuildingId, type Cost, type ResourceId, type Resources } from '@tokentracky/core';
import { GlyphIcon, ResourceIcon } from './icons.tsx';
import { createArt, isoProjection, SCENE_DEFS } from './art.ts';
import { count } from './format.ts';

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

/** Each store with its fill. A store 80% full warns that the next harvest may spill. */
export function ResourceBar({wallet, caps}: {wallet: Resources; caps: Resources}) {
  return <div className="tt-glass tt-res" role="list" aria-label="Your stores">
    {RESOURCE_IDS.map(id => {
      const fill = caps[id] > 0 ? Math.min(1, wallet[id] / caps[id]) : 0;
      const hot = fill >= 0.8;
      return <div key={id} role="listitem" className={hot ? 'tt-rs hot' : 'tt-rs'} aria-label={`${RESOURCE_NAMES[id]} ${count(wallet[id])} of ${count(caps[id])}`}>
        <ResourceIcon id={id} size={22} />
        <div><b>{count(wallet[id])}</b><s>/ {count(caps[id])}</s><span className="tt-meter"><i style={{width: `${fill * 100}%`, background: hot ? '#ff6b5b' : BAR[id]}} /></span></div>
        {hot && <span className="tt-full">{Math.round(fill * 100)}% full</span>}
      </div>;
    })}
  </div>;
}

/** The streak and the UTC clock the game's days follow. */
export function StreakClock({streak, now, children}: {streak?: number; now: number; children?: ReactNode}) {
  const date = new Date(now);
  const day = date.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'}).replace(',', '');
  const time = date.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', timeZone: 'UTC'});
  return <div className="tt-glass tt-clk">
    {streak !== undefined && <span className="tt-stk"><GlyphIcon id="flame" size={22} /><span><b>{streak}</b>-day streak</span></span>}
    {children}
    <span className="tt-mu">{day} · {time} UTC</span>
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
