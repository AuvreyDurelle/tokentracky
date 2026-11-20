import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { BUILDINGS, RESOURCE_IDS, type BuildingGroup, type BuildingId, type Resources, type TownBuilding, type TownMapResponse, type TownSelf } from '@tokentracky/core';
import type { TownApi } from './api.ts';
import { BUILDING_HEIGHT } from './art.ts';
import { BuildingThumb, CostChips, Crest, RESOURCE_NAMES, ResourceBar, StreakClock, usePoint, useNow, useToast } from './Hud.tsx';
import { ResourceIcon } from './icons.tsx';
import { BuildIcon, CloseIcon, FlagIcon, MapIcon, MoveIcon, SparkIcon } from './icons.tsx';
import { compact, count, covered, daysToAfford, paceText, shortfall, sinceText } from './format.ts';
import { plotKey, plotKind, plotTile, sceneLayout } from './layout.ts';
import { Sky, TownScene, type Selection } from './Scene.tsx';
import { spunProjection } from './view.ts';

type Tab = 'land' | 'harvest';
const MAX_LEVEL = 15;
const HALL_TEXT = "The heart of your town. No building can rise above the Town Hall's level, and each level adds room to every store.";
const add = (a: Resources, b: Resources): Resources => ({power: a.power + b.power, bricks: a.bricks + b.bricks, water: a.water + b.water, crystals: a.crystals + b.crystals});

/** The signed-in member's own town: the scene, the stores, the drawer, the dock and everything you can do there. */
export function TownPage({api, onMap}: {api: TownApi; onMap: () => void}) {
  const [town, setTown] = useState<TownSelf | null>(null);
  const [map, setMap] = useState<TownMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [tab, setTab] = useState<Tab | null>(() => typeof window !== 'undefined' && window.innerWidth >= 1100 ? 'land' : null);
  const [claiming, setClaiming] = useState(false);
  const [angle, setAngle] = useState(0);
  // The build menu, for a plot, or with none free to browse what there is.
  const [menu, setMenu] = useState<{x: number; y: number} | 'browse' | null>(null);
  const [toast, say] = useToast();
  const stage = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const now = useNow();

  const layout = useMemo(() => town ? sceneLayout(town.plots) : null, [town?.plots]);
  const loadMap = useCallback(async (next: TownSelf) => {
    const area = sceneLayout(next.plots);
    try { setMap(await api.map({x0: area.x0, y0: area.y0, x1: area.x0 + area.cols - 1, y1: area.y0 + area.rows - 1})); } catch { /* Neighbours are decoration; the town still works. */ }
  }, [api]);
  const load = useCallback(async () => {
    try {
      const next = await api.me();
      setTown(next); setError(null);
      return next;
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return null; }
  }, [api]);
  useEffect(() => { void load().then(next => { if (next) void loadMap(next); }); }, [load, loadMap]);
  // Refresh every minute for new uploads.
  useEffect(() => {
    if (!town) return;
    const timer = window.setTimeout(() => void load(), 60_000);
    return () => window.clearTimeout(timer);
  }, [town, load]);

  const run = async (action: () => Promise<TownSelf>, done?: string, landChanged = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await action();
      setTown(next);
      if (done) say(done, 'ok');
      if (landChanged) void loadMap(next);
    } catch (failure) { say(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };

  if (error && !town) return <div className="tt tt-stage tt-center"><Sky /><div className="tt-glass tt-card"><b>Your town could not load</b><p>{error}</p>
    <button type="button" className="tt-btn" onClick={() => void load()}>Try again</button></div></div>;
  if (!town || !layout) return <div className="tt tt-stage tt-center" aria-busy="true"><Sky /><div className="tt-glass tt-card">Lighting the lamps…</div></div>;

  const own = new Set(town.plots.map(p => plotKey(p.x, p.y)));
  const others = new Map((map?.plots ?? []).filter(([x, y]) => !own.has(plotKey(x, y))).map(([x, y, i]) => [plotKey(x, y), i]));
  const reach = add(town.wallet, town.harvest.resources);
  const spill = Object.fromEntries(RESOURCE_IDS.map(id => [id, Math.max(0, town.wallet[id] + town.harvest.resources[id] - town.caps[id])])) as Resources;
  const pending = RESOURCE_IDS.some(id => town.harvest.resources[id] > 0);
  const building = selected?.type === 'building' ? town.buildings.find(b => b.id === selected.id) ?? null : null;
  const plot = selected?.type === 'plot' ? selected : null;
  const plotState = plot ? plotKind(plot.x, plot.y, own, others).kind : null;
  const anchorPlot = building ?? plot;
  const P = spunProjection(layout, angle);
  const anchor = anchorPlot ? (() => { const [tx, ty] = plotTile(layout, anchorPlot.x, anchorPlot.y); return P(tx + 1, ty + 1, building ? BUILDING_HEIGHT[building.kind] * 0.6 : 10); })() : null;

  const select = (next: Selection | null) => {
    if (next?.type === 'plot' && claiming && plotKind(next.x, next.y, own, others).kind === 'claimable') {
      setClaiming(false);
      void run(() => api.claim(next.x, next.y), `Plot #${town.nextPlot.number} is yours`, true);
      return;
    }
    setClaiming(false);
    setSelected(next && selected && JSON.stringify(next) === JSON.stringify(selected) ? null : next);
  };
  const empties = town.plots.filter(p => !town.buildings.some(b => b.x === p.x && b.y === p.y));
  const openBuild = (target?: {x: number; y: number}) => { setSelected(null); setMenu(target ?? empties[0] ?? 'browse'); };
  const claimable = (() => {
    const free = new Set<string>();
    for (const p of town.plots) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (plotKind(p.x + dx, p.y + dy, own, others).kind === 'claimable') free.add(plotKey(p.x + dx, p.y + dy));
    return free.size;
  })();
  const fresh = town.catalogue.some(entry => !entry.locked && entry.owned === 0);

  return <div ref={stage} className="tt tt-stage">
    <Sky />
    <TownScene svgRef={svg} layout={layout} plots={town.plots} buildings={town.buildings} map={map} selected={selected} claimMode={claiming}
      harvest={pending ? {resources: town.harvest.resources, spill} : null} onSelect={select} onCollect={() => void run(() => api.collect(), 'Harvest collected')}
      label={`${town.alias}'s town`} angle={angle} onSpin={setAngle} />
    <div className="tt-top">
      <Crest alias={town.alias} level={town.level} plots={town.plots.length} />
      <ResourceBar wallet={town.wallet} caps={town.caps} />
      <StreakClock streak={town.harvest.streak} now={now} />
    </div>
    {town.paused && <div className="tt-glass tt-banner" role="status">{town.paused}</div>}
    {claiming && <div className="tt-glass tt-banner" role="status">Pick a glowing plot next to your land. <button type="button" className="tt-link" onClick={() => setClaiming(false)}>Cancel</button></div>}

    <Drawer tab={tab} onTab={setTab} badges={{land: claimable ? String(claimable) : null, harvest: pending ? '' : null}}>
      {tab === 'land' && <LandPane town={town} reach={reach} claimable={claimable} busy={busy} onClaim={() => { setSelected(null); setClaiming(true); }}
        onMove={() => void run(() => api.move(), 'Your town moved to the frontier', true)} />}
      {tab === 'harvest' && <HarvestPane town={town} spill={spill} busy={busy} now={now} onCollect={() => void run(() => api.collect(), 'Harvest collected')}
        onTrade={bricks => void run(() => api.trade(bricks), 'Traded')} />}
    </Drawer>

    {building && <Popover svg={svg} stage={stage} point={anchor} reserve={tab ? 340 : 80} onClose={() => setSelected(null)}>
      <BuildingPanel town={town} building={building} reach={reach} busy={busy} onUpgrade={() => void run(() => api.upgrade(building.id), `Upgraded to Lv ${building.level + 1}`)} />
    </Popover>}
    {plot && plotState === 'own' && <Popover svg={svg} stage={stage} point={anchor} reserve={tab ? 340 : 80} onClose={() => setSelected(null)}>
      <EmptyPlotPanel onBuild={() => openBuild(plot)} />
    </Popover>}
    {plot && plotState === 'claimable' && <Popover svg={svg} stage={stage} point={anchor} reserve={tab ? 340 : 80} onClose={() => setSelected(null)}>
      <ClaimPanel town={town} reach={reach} busy={busy} onClaim={() => { setSelected(null); void run(() => api.claim(plot.x, plot.y), `Plot #${town.nextPlot.number} is yours`, true); }} />
    </Popover>}

    {menu && <BuildMenu town={town} reach={reach} busy={busy} full={menu === 'browse'} onClose={() => setMenu(null)}
      onBuild={kind => { if (menu === 'browse') return; const at = menu; setMenu(null); void run(() => api.build(kind, at.x, at.y), `Built a ${BUILDINGS[kind].name}`); }} />}

    <div className="tt-glass tt-dock">
      <button type="button" className="tt-db" onClick={onMap}><MapIcon />Map</button>
      <button type="button" className="tt-cta" disabled={!pending || busy || !!town.paused} onClick={() => void run(() => api.collect(), 'Harvest collected')}>
        <span className="tt-ci"><SparkIcon size={24} /></span>
        <span><b>{pending ? 'Collect harvest' : 'Nothing to collect yet'}</b>
          <small>{pending ? `${sinceText(town.harvest.since, now)} · ${compact(town.harvest.tokens)} tokens${town.harvest.multiplier > 1 ? ` · ×${town.harvest.multiplier.toFixed(1)} streak` : ''}` : 'New tokens arrive with each upload'}</small></span>
      </button>
      <button type="button" className="tt-db" onClick={() => openBuild()}><BuildIcon />Build{fresh && <i className="tt-bd n">New</i>}</button>
    </div>
    {toast}
  </div>;
}

function Drawer({tab, onTab, badges, children}: {tab: Tab | null; onTab: (tab: Tab | null) => void; badges: Record<Tab, string | null>; children: ReactNode}) {
  const tabs: Array<[Tab, string, ReactNode]> = [['land', 'Land', <FlagIcon key="l" />], ['harvest', 'Harvest', <SparkIcon key="h" />]];
  return <div className={tab ? 'tt-glass tt-dr open' : 'tt-glass tt-dr'}>
    <div className="tt-tabs" role="tablist" aria-label="Town details">
      {tabs.map(([id, label, icon]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'tt-tb on' : 'tt-tb'} onClick={() => onTab(tab === id ? null : id)}>
        {icon}{label}{badges[id] !== null && <i className={badges[id] ? 'tt-bd n' : 'tt-bd d'}>{badges[id]}</i>}
      </button>)}
    </div>
    {tab && <div className="tt-pane" role="tabpanel">{children}</div>}
  </div>;
}

function Progress({have, need}: {have: number; need: number}) {
  return <div className="tt-pb" role="progressbar" aria-valuemin={0} aria-valuemax={need} aria-valuenow={Math.min(have, need)}><i style={{width: `${Math.min(100, need ? have / need * 100 : 100)}%`}} /></div>;
}

function LandPane({town, reach, claimable, busy, onClaim, onMove}: {town: TownSelf; reach: Resources; claimable: number; busy: boolean; onClaim: () => void; onMove: () => void}) {
  const [confirm, setConfirm] = useState(false);
  const price = town.nextPlot.cost.bricks ?? 0;
  const short = Math.max(0, price - town.wallet.bricks);
  const pace = paceText(daysToAfford(price - reach.bricks, town.bricksPerDay));
  const move = town.move.cost.bricks ?? 0;
  return <>
    <div className="tt-ph"><b>Your land</b><span className="tt-mu">{town.plots.length} {town.plots.length === 1 ? 'plot' : 'plots'} · {town.buildings.length} built</span></div>
    <div className="tt-kv"><span>Next plot #{town.nextPlot.number}</span><b><CostChips cost={town.nextPlot.cost} /></b></div>
    <Progress have={town.wallet.bricks} need={price} />
    <div className="tt-kv tt-mu"><span>You have {count(town.wallet.bricks)}</span>{short > 0 ? <span className="tt-sh">{count(short)} short</span> : <span className="tt-ok">Ready</span>}</div>
    {short > 0 && pace && <div className="tt-mu tt-note">{reach.bricks >= price ? 'Your uncollected harvest covers it' : pace}</div>}
    <button type="button" className="tt-btn" disabled={busy || reach.bricks < price || !claimable || !!town.paused} onClick={onClaim}>Claim plot #{town.nextPlot.number}</button>
    <div className="tt-fr"><i aria-hidden="true">+</i><span>{claimable ? `${claimable} free ${claimable === 1 ? 'plot touches' : 'plots touch'} your land` : 'No free plots touch your land. Move to the frontier.'}</span></div>
    <div className="tt-sep" />
    <div className="tt-kv"><span>Boxed in? Move town</span><b><CostChips cost={town.move.cost} /></b></div>
    <div className="tt-mu tt-note">Half what your land cost. Every building comes with you to the frontier.</div>
    {confirm
      ? <div className="tt-two"><button type="button" className="tt-btn go" disabled={busy || reach.bricks < move} onClick={() => { setConfirm(false); onMove(); }}>Move for {count(move)} Bricks</button>
        <button type="button" className="tt-btn" onClick={() => setConfirm(false)}>Keep</button></div>
      : <button type="button" className="tt-btn" disabled={busy || reach.bricks < move || !!town.paused} onClick={() => setConfirm(true)}><MoveIcon size={16} /> Move town</button>}
  </>;
}

function HarvestPane({town, spill, busy, now, onCollect, onTrade}: {town: TownSelf; spill: Resources; busy: boolean; now: number; onCollect: () => void; onTrade: (bricks: number) => void}) {
  const [bricks, setBricks] = useState('');
  const pending = RESOURCE_IDS.some(id => town.harvest.resources[id] > 0);
  return <>
    <div className="tt-ph"><b>Harvest</b><span className="tt-mu">{pending ? sinceText(town.harvest.since, now) : 'Collected'}</span></div>
    {RESOURCE_IDS.map(id => <div key={id} className="tt-kv tt-row"><span className="tt-with"><ResourceIcon id={id} size={16} />{RESOURCE_NAMES[id]}</span>
      <span><b>+{count(town.harvest.resources[id])}</b>{town.bonuses[id] > 0 && <i className="tt-mu"> +{town.bonuses[id]}%</i>}{spill[id] > 0 && <i className="tt-sh"> {compact(spill[id])} spills</i>}</span></div>)}
    <div className="tt-mu tt-note">{compact(town.harvest.tokens)} new tokens · {town.harvest.streak}-day streak ×{town.harvest.multiplier.toFixed(2)}</div>
    <button type="button" className="tt-btn go" disabled={!pending || busy || !!town.paused} onClick={onCollect}>Collect harvest</button>
    <div className="tt-sep" />
    <div className="tt-mu tt-note">1 Brick per 1M tokens of any kind. 1 Power per 10K output tokens, 1 Water per 50K input and cache-write tokens, 1 Crystal per 100K reasoning tokens.</div>
    {town.trade && <>
      <div className="tt-sep" />
      <div className="tt-kv"><span>Market</span><span className="tt-mu">{town.trade.rate} Bricks per Water</span></div>
      <form className="tt-two" onSubmit={event => { event.preventDefault(); const n = Number(bricks); if (Number.isInteger(n) && n > 0) { onTrade(n); setBricks(''); } }}>
        <input className="tt-input" inputMode="numeric" aria-label="Bricks to trade" placeholder={`Bricks, up to ${count(town.wallet.bricks)}`} value={bricks} onChange={event => setBricks(event.target.value.replace(/\D/g, ''))} />
        <button type="submit" className="tt-btn" disabled={busy || !bricks}>Trade</button>
      </form>
    </>}
  </>;
}

/** A glass card next to a point in the scene, with a short line pointing at it. On narrow screens it becomes a bottom sheet. */
function Popover({svg, stage, point, reserve, onClose, children}: {svg: RefObject<SVGSVGElement | null>; stage: RefObject<HTMLDivElement | null>; point: [number, number] | null; reserve: number; onClose: () => void; children: ReactNode}) {
  const at = usePoint(svg, stage, point);
  // Opens to the right of the point unless that would run into the drawer (`reserve` pixels at the right edge).
  const width = (stage.current?.clientWidth ?? 0) - reserve;
  const left = at ? at.left + 26 + 290 > width ? Math.max(8, at.left - 26 - 290) : at.left + 26 : 20;
  const top = at ? Math.min(Math.max(70, at.top - 120), (stage.current?.clientHeight ?? 600) - 360) : 74;
  const side = at && left < at.left ? 'right' : 'left';
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return <>
    {at && <svg className="tt-leader" aria-hidden="true"><line x1={at.left} y1={at.top} x2={side === 'left' ? left : left + 290} y2={Math.max(top + 30, Math.min(top + 200, at.top))} /><circle cx={at.left} cy={at.top} r={4} /></svg>}
    <div className="tt-glass tt-pop" style={{left, top}} role="dialog" aria-modal="false">
      <button type="button" className="tt-x" aria-label="Close" onClick={onClose}><CloseIcon size={16} /></button>
      {children}
    </div>
  </>;
}

function Pips({level}: {level: number}) {
  return <div className="tt-pips" aria-label={`Level ${level} of ${MAX_LEVEL}`}>{Array.from({length: MAX_LEVEL}, (_, i) => <i key={i} className={i < level ? 'f' : i === level ? 'n' : ''} />)}</div>;
}
const effectValue = (value: number, unit: 'percent' | 'count') => unit === 'percent' ? `+${value}%` : count(value);

function BuildingPanel({town, building, reach, busy, onUpgrade}: {town: TownSelf; building: TownBuilding; reach: Resources; busy: boolean; onUpgrade: () => void}) {
  const info = BUILDINGS[building.kind];
  const next = building.next;
  const description = building.kind === 'town-hall' ? HALL_TEXT : town.catalogue.find(c => c.kind === building.kind)?.description;
  const missing = next ? shortfall(reach, next.cost) : {};
  const short = RESOURCE_IDS.filter(id => missing[id]).map(id => `${count(missing[id]!)} ${RESOURCE_NAMES[id]}`).join(' · ');
  return <>
    <div className="tt-p-h"><BuildingThumb kind={building.kind} level={building.level} size={46} /><div><b>{info.name}</b><span className="tt-mu">Lv {building.level} · <span className={`tt-rar ${info.rarity}`}>{info.rarity}</span></span></div></div>
    <Pips level={building.level} />
    {description && <p className="tt-desc">{description}</p>}
    {next && next.effects.map(effect => <div key={effect.label} className="tt-st"><span>{effect.label}</span><span><i>{effectValue(effect.from, effect.unit)} →</i> <b>{effectValue(effect.to, effect.unit)}</b></span></div>)}
    {next ? <>
        <div className="tt-two"><CostChips cost={next.cost} have={reach} /></div>
        {next.blocked ? <div className="tt-blocked">{next.blocked}</div> : <>
          <button type="button" className="tt-go" disabled={busy || !!short} onClick={onUpgrade}>Upgrade to Lv {building.level + 1}</button>
          {short && <div className="tt-mu tt-note">{short} short</div>}
        </>}
      </> : <div className="tt-mu tt-note">At the top level.</div>}
  </>;
}

function EmptyPlotPanel({onBuild}: {onBuild: () => void}) {
  return <>
    <div className="tt-p-h"><div className="tt-tn" aria-hidden="true"><BuildIcon /></div><div><b>Empty plot</b><span className="tt-mu">Yours to build on</span></div></div>
    <button type="button" className="tt-go" onClick={onBuild}>Build here</button>
  </>;
}

function ClaimPanel({town, reach, busy, onClaim}: {town: TownSelf; reach: Resources; busy: boolean; onClaim: () => void}) {
  const cost = town.nextPlot.cost;
  const missing = shortfall(reach, cost).bricks ?? 0;
  const pace = paceText(daysToAfford(missing, town.bricksPerDay));
  return <>
    <div className="tt-p-h"><div className="tt-tn" aria-hidden="true"><FlagIcon /></div><div><b>Plot #{town.nextPlot.number}</b><span className="tt-mu">Free land next to yours</span></div></div>
    <CostChips cost={cost} have={reach} />
    <p className="tt-desc">Each plot costs 1.43 times the last.</p>
    {missing > 0 ? <div className="tt-blocked">{count(missing)} Bricks short{pace ? `. ${pace}.` : '.'}</div>
      : <button type="button" className="tt-go" disabled={busy || !!town.paused} onClick={onClaim}>Claim plot #{town.nextPlot.number}</button>}
  </>;
}

const GROUPS: Array<[BuildingGroup | 'all', string]> = [['all', 'All'], ['make', 'Make'], ['store', 'Store'], ['special', 'Special'], ['decor', 'Decor'], ['wonder', 'Wonder']];
function BuildMenu({town, reach, busy, full, onClose, onBuild}: {town: TownSelf; reach: Resources; busy: boolean; full: boolean; onClose: () => void; onBuild: (kind: BuildingId) => void}) {
  const [group, setGroup] = useState<BuildingGroup | 'all'>('all');
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const entries = town.catalogue.filter(entry => group === 'all' || BUILDINGS[entry.kind].group === group);
  return <div className="tt-glass tt-menu" role="dialog" aria-label="Build">
    <div className="tt-menu-h"><b>Build</b><span className="tt-mu">Each building you own makes the next 1.3× dearer</span>
      <div className="tt-chips" role="tablist">{GROUPS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={group === id} className={group === id ? 'on' : ''} onClick={() => setGroup(id)}>{label}</button>)}</div>
      <button type="button" className="tt-x" aria-label="Close" onClick={onClose}><CloseIcon size={16} /></button></div>
    {full && <div className="tt-menu-note">Every plot has a building. Claim more land to build another.</div>}
    <div className="tt-cards">
      {entries.map(entry => {
        const info = BUILDINGS[entry.kind];
        const ready = covered(reach, entry.cost);
        return <button key={entry.kind} type="button" className={`tt-card ${info.rarity}`} disabled={busy || full || !ready || !!entry.locked || !!town.paused} onClick={() => onBuild(entry.kind)}>
          <BuildingThumb kind={entry.kind} size={72} />
          <span className="tt-card-b"><b>{info.name}</b><span className={`tt-rar ${info.rarity}`}>{info.rarity}</span>
            <span className="tt-desc">{entry.description}</span>
            {entry.locked ? <span className="tt-lock">{entry.locked}</span> : <><CostChips cost={entry.cost} have={reach} />
              <span className="tt-mu">{entry.limit !== null ? `${entry.owned} of ${entry.limit}` : entry.owned ? `You have ${entry.owned}` : 'New'}{ready ? '' : ' · not enough yet'}</span></>}
          </span>
        </button>;
      })}
    </div>
  </div>;
}
