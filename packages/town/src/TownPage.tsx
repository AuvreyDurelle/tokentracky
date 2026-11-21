import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BUILDINGS, RESOURCE_IDS, type BuildingGroup, type BuildingId, type Cost, type Resources, type TownBuilding, type TownMapResponse, type TownSelf } from '@tokentracky/core';
import type { TownApi } from './api.ts';
import { BUILDING_HEIGHT } from './art.ts';
import { BuildingThumb, CostChips, Crest, RESOURCE_NAMES, ResourceBar, StreakClock, useNow, useToast } from './Hud.tsx';
import { ResourceIcon } from './icons.tsx';
import { BuildIcon, CloseIcon, FlagIcon, MapIcon, MoveIcon, SparkIcon } from './icons.tsx';
import { afterCollect, collected, compact, count, daysToAfford, paceText, shortfall, sinceText, tooBig } from './format.ts';
import { plotKey, plotKind, plotTile, sceneLayout } from './layout.ts';
import { Sky, TownScene, preloadWorld, type Place, type Selection, type StageSize } from './Scene.tsx';
import type { Moment } from './view.ts';

type Tab = 'land' | 'harvest';
/** The action waiting on the server, so its button can say so. */
type Pending = 'collect' | 'claim' | 'build' | 'upgrade' | 'move' | 'trade';
const MAX_LEVEL = 15;
const HALL_TEXT = "The heart of your town. No building can rise above the Town Hall's level, and each level adds room to every store.";
/** What is still missing to pay `cost`, as "120 Water · 40 Power", or '' once it is covered. */
const shortText = (reach: Resources, cost: Cost) => {
  const missing = shortfall(reach, cost);
  return RESOURCE_IDS.filter(id => missing[id]).map(id => `${count(missing[id]!)} ${RESOURCE_NAMES[id]}`).join(' · ');
};
/** The hosted rules' "Your Bricks store holds 17,000. Upgrade a store first." when no store can ever hold `cost`, or null. */
const storeText = (caps: Resources, cost: Cost) => {
  const id = tooBig(cost, caps);
  return id ? `Your ${RESOURCE_NAMES[id]} store holds ${count(caps[id])}. Upgrade a store first.` : null;
};

/** The signed-in member's own town: the scene, the stores, the drawer, the dock and everything you can do there. */
export function TownPage({api, onMap}: {api: TownApi; onMap: () => void}) {
  const [town, setTown] = useState<TownSelf | null>(null);
  const [map, setMap] = useState<TownMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const busy = pending !== null;
  const [selected, setSelected] = useState<Selection | null>(null);
  const [tab, setTab] = useState<Tab | null>(() => typeof window !== 'undefined' && window.innerWidth >= 1100 ? 'land' : null);
  const [claiming, setClaiming] = useState(false);
  // Picking which empty plot to build on, from the dock's Build button.
  const [placing, setPlacing] = useState(false);
  // The build menu, for a plot, or with none free to browse what there is.
  const [menu, setMenu] = useState<{x: number; y: number} | 'browse' | null>(null);
  const [toast, say] = useToast();
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
  // The 3D town's code loads alongside the town's data.
  useEffect(() => { void preloadWorld().catch(() => {}); }, []);
  useEffect(() => { void load().then(next => { if (next) void loadMap(next); }); }, [load, loadMap]);
  // Refresh every minute for new uploads, counting attempts so a failed one schedules the next too.
  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => {
    if (!town) return;
    const timer = window.setTimeout(() => void load().finally(() => setRefreshes(n => n + 1)), 60_000);
    return () => window.clearTimeout(timer);
  }, [town, load, refreshes]);

  // What just happened, for the scene to play once.
  const [moment, setMoment] = useState<Moment | null>(null);
  const [collectedAt, setCollectedAt] = useState(0);
  const run = async (kind: Pending, action: () => Promise<TownSelf>, {done, land = false, undo, at}: {done?: string; land?: boolean; undo?: () => void; at?: {x: number; y: number}} = {}) => {
    if (busy) return;
    setPending(kind);
    try {
      const next = await action();
      setTown(next);
      if (done) say(done, 'ok');
      const play = () => { if (at && kind !== 'collect' && kind !== 'trade') setMoment({kind, x: at.x, y: at.y, at: performance.now()}); };
      // New land redraws again once the neighbours load, so its moment waits for them.
      if (land) void loadMap(next).then(play); else play();
    } catch (failure) { undo?.(); say(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(null); }
  };
  // Collecting shows at once; the server's answer then corrects it, or a failure puts the harvest back.
  const collect = () => {
    if (busy || !town) return;
    const before = town;
    setTown(collected(town));
    setCollectedAt(performance.now());
    void run('collect', () => api.collect(), {done: 'Harvest collected', undo: () => setTown(before)});
  };

  if (error && !town) return <div className="tt tt-stage tt-center"><Sky /><div className="tt-glass tt-card"><b>Your town could not load</b><p>{error}</p>
    <button type="button" className="tt-btn" onClick={() => void load()}>Try again</button></div></div>;
  if (!town || !layout) return <div className="tt tt-stage tt-center" aria-busy="true"><Sky /><div className="tt-glass tt-card">Lighting the lamps…</div></div>;

  const own = new Set(town.plots.map(p => plotKey(p.x, p.y)));
  const others = new Map((map?.plots ?? []).filter(([x, y]) => !own.has(plotKey(x, y))).map(([x, y, i]) => [plotKey(x, y), i]));
  const reach = afterCollect(town.wallet, town.harvest.resources, town.caps);
  const spill = Object.fromEntries(RESOURCE_IDS.map(id => [id, Math.max(0, town.wallet[id] + town.harvest.resources[id] - town.caps[id])])) as Resources;
  const harvestWaiting = RESOURCE_IDS.some(id => town.harvest.resources[id] > 0);
  const building = selected?.type === 'building' ? town.buildings.find(b => b.id === selected.id) ?? null : null;
  const plot = selected?.type === 'plot' ? selected : null;
  const plotState = plot ? plotKind(plot.x, plot.y, own, others).kind : null;
  const anchorPlot = building ?? plot;
  // Where the card points: up the building, or just above an empty plot.
  const anchor = anchorPlot ? (() => { const [tx, ty] = plotTile(layout, anchorPlot.x, anchorPlot.y); return [tx + 1, ty + 1, building ? BUILDING_HEIGHT[building.kind] * 0.6 : 10] as const; })() : null;
  const reserve = tab ? 340 : 80;
  const deselect = () => setSelected(null);

  const select = (next: Selection | null) => {
    if (next?.type === 'plot' && claiming && plotKind(next.x, next.y, own, others).kind === 'claimable') {
      setClaiming(false);
      void run('claim', () => api.claim(next.x, next.y), {done: `Plot #${town.nextPlot.number} is yours`, land: true, at: next});
      return;
    }
    if (next?.type === 'plot' && placing && plotKind(next.x, next.y, own, others).kind === 'own') {
      setPlacing(false);
      setSelected(null);
      setMenu(next);
      return;
    }
    setClaiming(false);
    setPlacing(false);
    setSelected(next && selected && JSON.stringify(next) === JSON.stringify(selected) ? null : next);
  };
  const empties = town.plots.filter(p => !town.buildings.some(b => b.x === p.x && b.y === p.y));
  const openBuild = (target?: {x: number; y: number}) => { setSelected(null); setClaiming(false); setPlacing(false); setMenu(target ?? empties[0] ?? 'browse'); };
  // With a choice of empty plots, you pick one in the town first; with one or none, the menu opens at once.
  const startBuild = () => { if (empties.length > 1) { setSelected(null); setMenu(null); setClaiming(false); setPlacing(true); } else openBuild(); };
  const claimable = (() => {
    const free = new Set<string>();
    for (const p of town.plots) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (plotKind(p.x + dx, p.y + dy, own, others).kind === 'claimable') free.add(plotKey(p.x + dx, p.y + dy));
    return free.size;
  })();
  const fresh = town.catalogue.some(entry => !entry.locked && entry.owned === 0);

  return <div className="tt tt-stage">
    <Sky />
    <TownScene layout={layout} plots={town.plots} buildings={town.buildings} map={map} selected={selected} claimMode={claiming}
      buildMode={placing} harvest={harvestWaiting ? {resources: town.harvest.resources, spill} : null} onSelect={select} onCollect={collect}
      label={`${town.alias}'s town`} spins moment={moment} collected={collectedAt}
      popover={(place, size) => {
        if (!anchor) return null;
        const at = place(...anchor);
        if (building) return <Popover key={building.id} at={at} stage={size} reserve={reserve} onClose={deselect}>
          <BuildingPanel town={town} building={building} reach={reach} pending={pending} onUpgrade={() => void run('upgrade', () => api.upgrade(building.id), {done: `Upgraded to Lv ${building.level + 1}`, at: building})} />
        </Popover>;
        if (plot && plotState === 'own') return <Popover key={`${plot.x},${plot.y}`} at={at} stage={size} reserve={reserve} onClose={deselect}>
          <EmptyPlotPanel onBuild={() => openBuild(plot)} />
        </Popover>;
        if (plot && plotState === 'claimable') return <Popover key={`${plot.x},${plot.y}`} at={at} stage={size} reserve={reserve} onClose={deselect}>
          <ClaimPanel town={town} reach={reach} pending={pending} onClaim={() => { setSelected(null); void run('claim', () => api.claim(plot.x, plot.y), {done: `Plot #${town.nextPlot.number} is yours`, land: true, at: plot}); }} />
        </Popover>;
        return null;
      }} />
    <div className="tt-top">
      <Crest alias={town.alias} level={town.level} plots={town.plots.length} />
      <ResourceBar wallet={town.wallet} caps={town.caps} />
      <StreakClock streak={town.harvest.streak} now={now} />
    </div>
    {town.paused && <div className="tt-glass tt-banner" role="status">{town.paused}</div>}
    {claiming && <div className="tt-glass tt-banner" role="status">Pick a glowing plot next to your land. <button type="button" className="tt-link" onClick={() => setClaiming(false)}>Cancel</button></div>}
    {placing && <div className="tt-glass tt-banner" role="status">Pick an empty plot to build on. <button type="button" className="tt-link" onClick={() => setPlacing(false)}>Cancel</button></div>}

    <Drawer tab={tab} onTab={setTab} badges={{land: claimable ? String(claimable) : null, harvest: harvestWaiting ? '' : null}}>
      {tab === 'land' && <LandPane town={town} reach={reach} claimable={claimable} pending={pending} onClaim={() => { setSelected(null); setPlacing(false); setClaiming(true); }}
        onMove={() => void run('move', () => api.move(), {done: 'Your town moved to the frontier', land: true, at: {x: 0, y: 0}})} />}
      {tab === 'harvest' && <HarvestPane town={town} spill={spill} pending={pending} now={now} onCollect={collect}
        onTrade={bricks => void run('trade', () => api.trade(bricks), {done: 'Traded'})} />}
    </Drawer>

    {menu && <BuildMenu town={town} reach={reach} busy={busy} full={menu === 'browse'} onClose={() => setMenu(null)}
      onBuild={kind => { if (menu === 'browse') return; const at = menu; setMenu(null); void run('build', () => api.build(kind, at.x, at.y), {done: `Built a ${BUILDINGS[kind].name}`, at}); }} />}

    <div className="tt-glass tt-dock">
      <button type="button" className="tt-db" onClick={onMap}><MapIcon />Map</button>
      <button type="button" className="tt-cta" disabled={!harvestWaiting || busy || !!town.paused} onClick={collect}>
        <span className="tt-ci"><SparkIcon size={24} /></span>
        <span><b>{harvestWaiting ? 'Collect harvest' : 'Nothing to collect yet'}</b>
          <small>{harvestWaiting ? `${sinceText(town.harvest.since, now)} · ${compact(town.harvest.tokens)} tokens${town.harvest.multiplier > 1 ? ` · ×${town.harvest.multiplier.toFixed(1)} streak` : ''}` : 'New tokens arrive with each upload'}</small></span>
      </button>
      <button type="button" className="tt-db" aria-pressed={placing} onClick={() => placing ? setPlacing(false) : startBuild()}><BuildIcon />Build{fresh && <i className="tt-bd n">New</i>}</button>
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

function LandPane({town, reach, claimable, pending, onClaim, onMove}: {town: TownSelf; reach: Resources; claimable: number; pending: Pending | null; onClaim: () => void; onMove: () => void}) {
  const busy = pending !== null;
  const [confirm, setConfirm] = useState(false);
  const price = town.nextPlot.cost.bricks ?? 0;
  // What collecting would leave to spend, as the Claim button counts it.
  const short = Math.max(0, price - reach.bricks);
  const full = storeText(town.caps, town.nextPlot.cost);
  const note = short > 0 ? full ?? paceText(daysToAfford(short, town.bricksPerDay)) : town.wallet.bricks < price ? 'Your uncollected harvest covers it' : null;
  const move = town.move.cost.bricks ?? 0;
  return <>
    <div className="tt-ph"><b>Your land</b><span className="tt-mu">{town.plots.length} {town.plots.length === 1 ? 'plot' : 'plots'} · {town.buildings.length} built</span></div>
    <div className="tt-kv"><span>Next plot #{town.nextPlot.number}</span><b><CostChips cost={town.nextPlot.cost} /></b></div>
    <Progress have={reach.bricks} need={price} />
    <div className="tt-kv tt-mu"><span>You can spend {count(reach.bricks)}</span>{short > 0 ? <span className="tt-sh">{count(short)} short</span> : <span className="tt-ok">Ready</span>}</div>
    {note && <div className="tt-mu tt-note">{note}</div>}
    <button type="button" className="tt-btn" disabled={busy || reach.bricks < price || !claimable || !!town.paused} onClick={onClaim}>{pending === 'claim' ? 'Claiming…' : `Claim plot #${town.nextPlot.number}`}</button>
    <div className="tt-fr"><i aria-hidden="true">+</i><span>{claimable ? `${claimable} free ${claimable === 1 ? 'plot touches' : 'plots touch'} your land` : 'No free plots touch your land. Move to the frontier.'}</span></div>
    <div className="tt-sep" />
    <div className="tt-kv"><span>Boxed in? Move town</span><b><CostChips cost={town.move.cost} /></b></div>
    <div className="tt-mu tt-note">Half what your land cost, and never more than a full Bricks store. Every building comes with you to the frontier.</div>
    {confirm
      ? <div className="tt-two"><button type="button" className="tt-btn go" disabled={busy || reach.bricks < move} onClick={() => { setConfirm(false); onMove(); }}>Move for {count(move)} Bricks</button>
        <button type="button" className="tt-btn" onClick={() => setConfirm(false)}>Keep</button></div>
      : <button type="button" className="tt-btn" disabled={busy || reach.bricks < move || !!town.paused} onClick={() => setConfirm(true)}><MoveIcon size={16} /> {pending === 'move' ? 'Moving…' : 'Move town'}</button>}
  </>;
}

function HarvestPane({town, spill, pending: action, now, onCollect, onTrade}: {town: TownSelf; spill: Resources; pending: Pending | null; now: number; onCollect: () => void; onTrade: (bricks: number) => void}) {
  const busy = action !== null;
  const [bricks, setBricks] = useState('');
  const pending = RESOURCE_IDS.some(id => town.harvest.resources[id] > 0);
  return <>
    <div className="tt-ph"><b>Harvest</b><span className="tt-mu">{pending ? sinceText(town.harvest.since, now) : 'Collected'}</span></div>
    {RESOURCE_IDS.map(id => <div key={id} className="tt-kv tt-row"><span className="tt-with"><ResourceIcon id={id} size={16} />{RESOURCE_NAMES[id]}</span>
      <span><b>+{count(town.harvest.resources[id])}</b>{town.bonuses[id] > 0 && <i className="tt-mu"> +{town.bonuses[id]}%</i>}{spill[id] > 0 && <i className="tt-sh"> {compact(spill[id])} spills</i>}</span></div>)}
    <div className="tt-mu tt-note">{compact(town.harvest.tokens)} new tokens · {town.harvest.streak}-day streak ×{town.harvest.multiplier.toFixed(2)}</div>
    <button type="button" className="tt-btn go" disabled={!pending || busy || !!town.paused} onClick={onCollect}>Collect harvest</button>
    <div className="tt-sep" />
    <div className="tt-mu tt-note">1 Brick per {compact(town.rates.bricks)} tokens of any kind. 1 Power per {compact(town.rates.power)} output tokens, 1 Water per {compact(town.rates.water)} input and cache-write tokens, 1 Crystal per {compact(town.rates.crystals)} reasoning tokens.</div>
    {town.trade && <>
      <div className="tt-sep" />
      <div className="tt-kv"><span>Market</span><span className="tt-mu">{town.trade.rate} Bricks per Water</span></div>
      <form className="tt-two" onSubmit={event => { event.preventDefault(); const n = Number(bricks); if (Number.isInteger(n) && n > 0) { onTrade(n); setBricks(''); } }}>
        <input className="tt-input" inputMode="numeric" aria-label="Bricks to trade" placeholder={`Bricks, up to ${count(town.wallet.bricks)}`} value={bricks} onChange={event => setBricks(event.target.value.replace(/\D/g, ''))} />
        <button type="submit" className="tt-btn" disabled={busy || !bricks}>{action === 'trade' ? 'Trading…' : 'Trade'}</button>
      </form>
    </>}
  </>;
}

/** A glass card next to a point in the scene, with a short line pointing at it. On narrow screens it becomes a bottom sheet. */
function Popover({at, stage, reserve, onClose, children}: {at: ReturnType<Place>; stage: StageSize; reserve: number; onClose: () => void; children: ReactNode}) {
  // Opens to the right of the point unless that would run into the drawer (`reserve` pixels at the right edge).
  const width = stage.width - reserve;
  const left = at.left + 26 + 290 > width ? Math.max(8, at.left - 26 - 290) : at.left + 26;
  const top = Math.min(Math.max(70, at.top - 120), stage.height - 360);
  const side = left < at.left ? 'right' : 'left';
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return <>
    <svg className="tt-leader" aria-hidden="true"><line x1={at.left} y1={at.top} x2={side === 'left' ? left : left + 290} y2={Math.max(top + 30, Math.min(top + 200, at.top))} /><circle cx={at.left} cy={at.top} r={4} /></svg>
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

function BuildingPanel({town, building, reach, pending, onUpgrade}: {town: TownSelf; building: TownBuilding; reach: Resources; pending: Pending | null; onUpgrade: () => void}) {
  const busy = pending !== null;
  const info = BUILDINGS[building.kind];
  const next = building.next;
  const description = building.kind === 'town-hall' ? HALL_TEXT : town.catalogue.find(c => c.kind === building.kind)?.description;
  const short = next ? shortText(reach, next.cost) : '';
  return <>
    <div className="tt-p-h"><BuildingThumb kind={building.kind} level={building.level} size={46} /><div><b>{info.name}</b><span className="tt-mu">Lv {building.level} · <span className={`tt-rar ${info.rarity}`}>{info.rarity}</span></span></div></div>
    <Pips level={building.level} />
    {description && <p className="tt-desc">{description}</p>}
    {next && next.effects.map(effect => <div key={effect.label} className="tt-st"><span>{effect.label}</span><span><i>{effectValue(effect.from, effect.unit)} →</i> <b>{effectValue(effect.to, effect.unit)}</b></span></div>)}
    {next ? <>
        <div className="tt-two"><CostChips cost={next.cost} have={reach} /></div>
        {next.blocked ? <div className="tt-blocked">{next.blocked}</div> : <>
          <button type="button" className="tt-go" disabled={busy || !!short} onClick={onUpgrade} aria-busy={pending === 'upgrade'}>{pending === 'upgrade' ? 'Upgrading…' : `Upgrade to Lv ${building.level + 1}`}</button>
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

function ClaimPanel({town, reach, pending, onClaim}: {town: TownSelf; reach: Resources; pending: Pending | null; onClaim: () => void}) {
  const busy = pending !== null;
  const cost = town.nextPlot.cost;
  const missing = shortfall(reach, cost).bricks ?? 0;
  const pace = paceText(daysToAfford(missing, town.bricksPerDay));
  const full = storeText(town.caps, cost);
  return <>
    <div className="tt-p-h"><div className="tt-tn" aria-hidden="true"><FlagIcon /></div><div><b>Plot #{town.nextPlot.number}</b><span className="tt-mu">Free land next to yours</span></div></div>
    <CostChips cost={cost} have={reach} />
    <p className="tt-desc">Each plot costs 1.43 times the last.</p>
    {missing > 0 ? <div className="tt-blocked">{full ?? `${count(missing)} Bricks short${pace ? `. ${pace}.` : '.'}`}</div>
      : <button type="button" className="tt-go" disabled={busy || !!town.paused} onClick={onClaim}>{pending === 'claim' ? 'Claiming…' : `Claim plot #${town.nextPlot.number}`}</button>}
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
        const short = shortText(reach, entry.cost);
        const store = storeText(town.caps, entry.cost);
        return <button key={entry.kind} type="button" className={`tt-card ${info.rarity}`} disabled={busy || full || !!short || !!entry.locked || !!town.paused} onClick={() => onBuild(entry.kind)}>
          <BuildingThumb kind={entry.kind} size={72} />
          <span className="tt-card-b"><b>{info.name}</b><span className={`tt-rar ${info.rarity}`}>{info.rarity}</span>
            <span className="tt-desc">{entry.description}</span>
            {entry.locked ? <span className="tt-lock">{entry.locked}</span> : <><CostChips cost={entry.cost} have={reach} />
              <span className="tt-mu">{entry.limit !== null ? `${entry.owned} of ${entry.limit}` : entry.owned ? `You have ${entry.owned}` : 'New'}{short ? ` · ${store ?? `${short} short`}` : ''}</span></>}
          </span>
        </button>;
      })}
    </div>
  </div>;
}
