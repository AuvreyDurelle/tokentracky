import { useMemo, type KeyboardEvent, type Ref } from 'react';
import { BUILDINGS, RESOURCE_IDS, terrainAt, type BuildingId, type ResourceId, type Resources, type TownJob, type TownMapResponse, type TownPlot } from '@tokentracky/core';
import { BUILDING_HEIGHT, SCENE_DEFS, circle, createArt, hash, isoProjection, r, spark, type Pt } from './art.ts';
import { compact, count, duration } from './format.ts';
import { plotKey, plotKind, plotTile, plotsBackToFront, type PlotKind, type SceneLayout } from './layout.ts';

export interface SceneBuilding {id?: string; kind: BuildingId; x: number; y: number; level: number}
export type Selection = {type: 'building'; id: string} | {type: 'plot'; x: number; y: number};
/** Uncollected harvest to float over the town, with what would spill. */
export interface SceneHarvest {resources: Resources; spill: Resources}

/** Colours for other towns, picked by name so a town has the same colour in the scene and on the map. */
const PALETTE = ['#ffa25e', '#4fe0c4', '#ff7aa8', '#b69cff', '#6fb8ff', '#a8e06a', '#f08de0', '#ff9f7a', '#7ad7ff', '#ffd36b'];
export function townColour(alias: string | null): string {
  if (alias === null) return '#6c6890';
  let h = 0;
  for (const c of alias) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
const GROUND: Record<PlotKind['kind'], [string, string]> = {own: ['#3b6b53', '#386650'], claimable: ['#283f41', '#263c3e'], free: ['#22383a', '#203538'],
  forest: ['#1f3a33', '#1d362f'], other: ['#2a4442', '#284140'], water: ['#172856', '#1a2c5c']};
/** Which building a resource's harvest bubble floats over. */
const SOURCE: Record<ResourceId, BuildingId> = {power: 'power-plant', bricks: 'brickworks', water: 'reservoir', crystals: 'observatory'};
const BUBBLE: Record<ResourceId, string> = {power: '#ffd23f', bricks: '#ff9a5c', water: '#6fd3ff', crystals: '#c4a4ff'};

/** The sky behind every town: stars, a low moon and the glow of the horizon. Fixed, so it is drawn once. */
function skyMarkup(): string {
  let z = 7;
  const rn = () => (z = z * 16807 % 2147483647) / 2147483647;
  let s = '<defs><linearGradient id="tt-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070823"/><stop offset=".4" stop-color="#17184a"/><stop offset=".68" stop-color="#33276a"/><stop offset=".85" stop-color="#6a3e78"/><stop offset="1" stop-color="#b45e78"/></linearGradient>'
    + '<radialGradient id="tt-moon"><stop offset="0" stop-color="#ffd9b0" stop-opacity=".55"/><stop offset="1" stop-color="#ffd9b0" stop-opacity="0"/></radialGradient>'
    + '<radialGradient id="tt-horizon"><stop offset="0" stop-color="#ff9a7a" stop-opacity=".38"/><stop offset="1" stop-color="#ff9a7a" stop-opacity="0"/></radialGradient></defs>';
  s += '<rect width="1192" height="760" fill="url(#tt-sky)"/>';
  for (let i = 0; i < 170; i++) {
    const x = rn() * 1192, y = rn() * 620, a = rn();
    s += `<circle class="tt-twinkle" style="animation-delay:${r(a * 4)}s" cx="${r(x)}" cy="${r(y)}" r="${a > 0.94 ? 1.5 : a > 0.6 ? 0.9 : 0.6}" fill="#fff" opacity="${(0.2 + a * 0.7 * (1 - y / 800)).toFixed(2)}"/>`;
  }
  for (const [x, y, size] of [[150, 46, 7], [700, 96, 6], [880, 64, 5], [300, 40, 4], [1040, 40, 6], [86, 420, 5], [960, 250, 5]] as const) s += spark(x, y, size);
  s += '<ellipse cx="600" cy="770" rx="780" ry="190" fill="url(#tt-horizon)"/>' + circle(980, 120, 160, 'url(#tt-moon)') + circle(980, 120, 38, '#fff0d0')
    + [[-12, -10, 8], [10, 6, 5], [3, -19, 4]].map(([a, b, size]) => circle(980 + a!, 120 + b!, size!, '#f1dcb4', 'opacity=".65"')).join('');
  return s;
}
let sky: string | null = null;
export function Sky() {
  sky ??= skyMarkup();
  return <svg className="tt-sky" viewBox="0 0 1192 760" preserveAspectRatio="xMidYMid slice" aria-hidden="true" dangerouslySetInnerHTML={{__html: sky}} />;
}

interface Props {
  layout: SceneLayout;
  plots: readonly TownPlot[];
  buildings: readonly SceneBuilding[];
  jobs?: readonly TownJob[];
  map: TownMapResponse | null;
  selected: Selection | null;
  claimMode?: boolean;
  harvest?: SceneHarvest | null;
  now: number;
  /** What happens on a plot. Without it the scene can only be looked at. */
  onSelect?: (selection: Selection | null) => void;
  onCollect?: () => void;
  label: string;
  svgRef?: Ref<SVGSVGElement>;
  /** Someone else's town: no claim markers, since its free plots are not yours to claim. */
  visiting?: boolean;
}

/** A town at night in isometric view: its plots, the neighbourhood around it, and everything happening there. */
export function TownScene({layout, plots, buildings, jobs = [], map, selected, claimMode = false, harvest, now, onSelect, onCollect, label, svgRef, visiting = false}: Props) {
  const P = useMemo(() => isoProjection(layout.originX, layout.originY), [layout]);
  const own = useMemo(() => new Set(plots.map(p => plotKey(p.x, p.y))), [plots]);
  const others = useMemo(() => {
    const out = new Map<string, number>();
    for (const [x, y, town] of map?.plots ?? []) if (!own.has(plotKey(x, y))) out.set(plotKey(x, y), town);
    return out;
  }, [map, own]);
  const kindAt = (x: number, y: number): PlotKind => {
    const kind = plotKind(x, y, own, others);
    return visiting && kind.kind === 'claimable' ? {kind: terrainAt(x, y) === 'forest' ? 'forest' : 'free'} : kind;
  };

  // The world: ground, borders, neighbours' homes, trees and every building, back to front. Redrawn when the town changes.
  const world = useMemo(() => {
    const art = createArt(P, 'tts');
    const nx = layout.cols * 2, ny = layout.rows * 2;
    const order = plotsBackToFront(layout);
    let ground = '', edges = '', objects = '';
    const B0 = P(nx, ny)[1];
    const L = P(0, ny, -26), R = P(nx, 0, -26), F = P(nx, ny, -26);
    let rock = art.poly([L, [L[0] + (F[0] - L[0]) * 0.35, B0 + 70], [F[0], B0 + 150], [F[0] + (R[0] - F[0]) * 0.65, B0 + 70], R, F], '#1b1534')
      + art.poly([L, [L[0] + (F[0] - L[0]) * 0.35, B0 + 70], [F[0], B0 + 150], F], '#231b40');
    rock += [[-0.6, 50], [-0.25, 96], [0.15, 110], [0.5, 70]].map(([k, dy], i) => art.dot([F[0] + k! * (R[0] - L[0]) * 0.5, B0 + dy!], 2.2, i % 2 ? '#b18cff' : '#7fe3ff')).join('');
    const slab = art.poly([P(0, ny), P(nx, ny), P(nx, ny, -26), P(0, ny, -26)], '#2c2347') + art.poly([P(nx, 0), P(nx, ny), P(nx, ny, -26), P(nx, 0, -26)], '#201a39')
      + art.poly([P(0, ny), P(nx, ny), P(nx, ny, -6), P(0, ny, -6)], '#2e4c48') + art.poly([P(nx, 0), P(nx, ny), P(nx, ny, -6), P(nx, 0, -6)], '#243d3b');
    const built = new Map(buildings.map(b => [plotKey(b.x, b.y), b]));
    const working = new Map(jobs.filter(job => job.status === 'running').map(job => [plotKey(job.x, job.y), job]));
    for (const [x, y] of order) {
      const kind = kindAt(x, y);
      const [tx, ty] = plotTile(layout, x, y);
      const colours = GROUND[kind.kind];
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) ground += art.poly(art.sq(tx + i, ty + j, 1, 1), colours[(tx + ty + i + j) % 2]!);
      const h = hash(x, y);
      if (kind.kind === 'water') {
        const c = P(tx + 1, ty + 1);
        if (h % 3 === 0) ground += `<path d="M${r(c[0] - 14)},${r(c[1])}h28" stroke="#9fb6f0" stroke-opacity=".3" stroke-width="1.5" stroke-linecap="round"/>`;
        continue;
      }
      // Borders: yours glow gold, a neighbour's take their colour.
      const owner = kind.kind === 'own' ? 'own' : kind.kind === 'other' ? `t${kind.town}` : null;
      if (owner) {
        const same = (ax: number, ay: number) => { const k = kindAt(ax, ay); return owner === 'own' ? k.kind === 'own' : k.kind === 'other' && `t${k.town}` === owner; };
        const colour = owner === 'own' ? '#ffe08a' : townColour(kind.kind === 'other' ? map?.towns[kind.town]?.alias ?? null : null);
        const d = owner === 'own' ? 0.06 : 0.1, x0 = tx, y0 = ty, x1 = tx + 2, y1 = ty + 2;
        const sides: Array<[Pt, Pt]> = [];
        if (!same(x, y - 1)) sides.push([P(x0 + d, y0 + d), P(x1 - d, y0 + d)]);
        if (!same(x, y + 1)) sides.push([P(x0 + d, y1 - d), P(x1 - d, y1 - d)]);
        if (!same(x - 1, y)) sides.push([P(x0 + d, y0 + d), P(x0 + d, y1 - d)]);
        if (!same(x + 1, y)) sides.push([P(x1 - d, y0 + d), P(x1 - d, y1 - d)]);
        for (const [a, b] of sides) edges += art.line(a, b, colour, owner === 'own' ? 2.6 : 1.6, owner === 'own' ? '' : 'opacity=".6"');
      }
      const job = working.get(plotKey(x, y));
      const building = built.get(plotKey(x, y));
      if (building) objects += art.building(building.kind, tx, ty, building.level);
      if (job) objects += art.scaffold(tx, ty);
      if (kind.kind === 'other') objects += art.house(tx, ty, townColour(map?.towns[kind.town]?.alias ?? null), h % 3);
      if (kind.kind === 'forest' || (kind.kind === 'free' && h % 4 === 0)) {
        objects += art.tree(tx + 0.2 + (h % 5) / 10, ty + 0.1, 0.85, h % 2 === 0) + art.tree(tx + 0.9, ty + 0.8 + (h % 3) / 10, 0.8, h % 3 === 0);
        if (kind.kind === 'forest') objects += art.tree(tx + 0.2, ty + 1, 0.75, true);
      }
      if (kind.kind === 'own' && !building && !job && h % 2 === 0) objects += art.lamp(tx + 1.85, ty + 1.85);
    }
    return `${rock}${slab}${ground}<g filter="url(#tt-mg)">${edges}</g>${objects}<defs>${art.defs}</defs>`;
  }, [P, layout, buildings, jobs, own, others, map, visiting]);

  const tile = (x: number, y: number) => plotTile(layout, x, y);
  const diamond = (x: number, y: number, inset = 0) => {
    const [tx, ty] = tile(x, y);
    return [P(tx + inset, ty + inset), P(tx + 2 - inset, ty + inset), P(tx + 2 - inset, ty + 2 - inset), P(tx + inset, ty + 2 - inset)].map(p => `${r(p[0])},${r(p[1])}`).join(' ');
  };
  const order = plotsBackToFront(layout);
  const byPlot = new Map(buildings.map(b => [plotKey(b.x, b.y), b]));
  const jobAt = new Map(jobs.map(job => [plotKey(job.x, job.y), job]));
  const selectedPlot = selected?.type === 'plot' ? selected : selected ? buildings.find(b => b.id === selected.id) : undefined;

  // Labels for neighbouring towns, at the middle of their visible land.
  const labels = useMemo(() => {
    const groups = new Map<number, Array<[number, number]>>();
    for (const [x, y] of plotsBackToFront(layout)) { const k = plotKind(x, y, own, others); if (k.kind === 'other') groups.set(k.town, [...(groups.get(k.town) ?? []), [x, y]]); }
    return [...groups].map(([town, cells]) => {
      const cx = cells.reduce((sum, [x]) => sum + x, 0) / cells.length, cy = cells.reduce((sum, [, y]) => sum + y, 0) / cells.length;
      const [tx, ty] = plotTile(layout, cx, cy);
      return {town, at: P(tx + 1, ty + 1, 8)};
    });
  }, [P, layout, own, others]);

  // Each bubble floats over the building that makes its resource, or over the Town Hall; bubbles sharing a building sit side by side.
  const placed = harvest ? RESOURCE_IDS.filter(id => harvest.resources[id] > 0).map(id => ({id, source: buildings.find(b => b.kind === SOURCE[id]) ?? buildings.find(b => b.kind === 'town-hall') ?? buildings[0]}))
    .filter((b): b is {id: ResourceId; source: SceneBuilding} => !!b.source) : [];
  const bubbles = placed.map(({id, source}) => {
    const sharing = placed.filter(other => other.source === source);
    const [tx, ty] = tile(source.x, source.y);
    const top = P(tx + 1, ty + 1, BUILDING_HEIGHT[source.kind] + 40);
    const shift = (sharing.findIndex(other => other.id === id) - (sharing.length - 1) / 2) * 64;
    // Spill warnings alternate in height so neighbouring ones never overlap.
    return {id, x: top[0] + shift, y: top[1], value: harvest!.resources[id], spill: harvest!.spill[id], lift: sharing.findIndex(other => other.id === id) % 2 * 20};
  });

  const activate = (selection: Selection) => onSelect?.(selection);
  const keyed = (selection: Selection) => (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(selection); } };

  return <svg ref={svgRef} className="tt-town" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={label}>
    <defs dangerouslySetInnerHTML={{__html: SCENE_DEFS}} />
    <g dangerouslySetInnerHTML={{__html: world}} />
    {/* Claimable plots: a dashed gold outline and a plus. */}
    {order.filter(([x, y]) => kindAt(x, y).kind === 'claimable').map(([x, y]) => {
      const [tx, ty] = tile(x, y);
      const c = P(tx + 1, ty + 1);
      return <g key={`c${x},${y}`} className={claimMode ? 'tt-claim on' : 'tt-claim'} pointerEvents="none">
        <polygon points={diamond(x, y, 0.16)} fill="rgba(255,211,107,.05)" stroke="#ffd36b" strokeOpacity={claimMode ? 1 : 0.55} strokeWidth={claimMode ? 2.4 : 1.6} strokeDasharray="6 5" />
        <circle cx={c[0]} cy={c[1]} r={9} fill="rgba(20,16,50,.75)" stroke="#ffd36b" strokeWidth={1.5} />
        <path d={`M${r(c[0] - 4)},${r(c[1])}h8M${r(c[0])},${r(c[1] - 4)}v8`} stroke="#ffd36b" strokeWidth={2} strokeLinecap="round" />
      </g>;
    })}
    {selectedPlot && <polygon points={diamond(selectedPlot.x, selectedPlot.y, 0.05)} fill="rgba(255,211,107,.18)" stroke="#ffd36b" strokeWidth={3} strokeLinejoin="round" filter="url(#tt-gl)" pointerEvents="none" />}
    {/* Level badges, queued and running work. */}
    {buildings.map(b => {
      const [tx, ty] = tile(b.x, b.y);
      const p = P(tx + 1.7, ty + 1.7, 30);
      const gold = selected?.type === 'building' && selected.id === b.id;
      return <g key={`l${b.x},${b.y}`} pointerEvents="none">
        <circle cx={p[0]} cy={p[1]} r={10.5} fill={gold ? '#ffd36b' : '#211e4c'} stroke={gold ? '#fff3c4' : '#bdb8ff'} strokeWidth={1.6} />
        <text x={p[0]} y={p[1] + 4} textAnchor="middle" fill={gold ? '#2a1d00' : '#fff'} fontSize={11} fontWeight={800}>{b.level}</text>
      </g>;
    })}
    {jobs.map(job => {
      const [tx, ty] = tile(job.x, job.y);
      const p = P(tx + 0.3, ty + 1.9, 0);
      const x = p[0] - 30, y = p[1] + 14;
      if (job.status === 'waiting') return <g key={`j${job.id}`} pointerEvents="none"><rect x={x - 14} y={y - 12} width={74} height={24} rx={12} fill="rgba(14,12,40,.88)" stroke="#9a92ff" strokeOpacity={0.7} />
        <text x={x + 23} y={y + 4} textAnchor="middle" fill="#cfcaff" fontSize={11} fontWeight={700}>Queued</text></g>;
      const total = Date.parse(job.readyAt!) - Date.parse(job.startedAt!);
      const done = total > 0 ? Math.min(1, (now - Date.parse(job.startedAt!)) / total) : 1;
      const c = 2 * Math.PI * 8;
      return <g key={`j${job.id}`} pointerEvents="none">
        <rect x={x - 14} y={y - 12} width={104} height={24} rx={12} fill="rgba(14,12,40,.88)" stroke="#ffc23d" strokeOpacity={0.7} />
        <circle cx={x} cy={y} r={8} fill="none" stroke="rgba(255,255,255,.18)" strokeWidth={3} />
        <circle cx={x} cy={y} r={8} fill="none" stroke="#ffc23d" strokeWidth={3} strokeDasharray={`${r(c * done)} ${r(c)}`} transform={`rotate(-90 ${x} ${y})`} />
        <text x={x + 14} y={y + 4} fill="#fff" fontSize={11.5}>{duration((Date.parse(job.readyAt!) - now) / 1000)}</text>
        <text x={x + 82} y={y + 4} textAnchor="end" fill="#ffc23d" fontSize={11} fontWeight={800}>→{job.targetLevel}</text>
      </g>;
    })}
    {labels.map(({town, at}) => {
      const t = map?.towns[town];
      if (!t) return null;
      const text = t.alias ? `@${t.alias}${t.level ? ` · Lv ${t.level}` : ''}` : 'Under review';
      const w = text.length * 6.6 + 34;
      return <g key={`n${town}`} pointerEvents="none">
        <rect x={at[0] - w / 2} y={at[1] - 11} width={w} height={22} rx={11} fill="rgba(14,12,40,.86)" stroke="rgba(200,195,255,.3)" />
        <circle cx={at[0] - w / 2 + 13} cy={at[1]} r={4.5} fill={townColour(t.alias)} filter="url(#tt-gl)" />
        <text x={at[0] + 7} y={at[1] + 4} textAnchor="middle" fill="#f2f1ff" fontSize={11.5} fontWeight={700}>{text}</text>
      </g>;
    })}
    {/* Plots you can act on take clicks and keys. */}
    {onSelect && order.map(([x, y]) => {
      const kind = kindAt(x, y);
      const building = byPlot.get(plotKey(x, y));
      if (kind.kind !== 'own' && kind.kind !== 'claimable') return null;
      const selection: Selection = building?.id ? {type: 'building', id: building.id} : {type: 'plot', x, y};
      const job = jobAt.get(plotKey(x, y));
      const name = building ? `${BUILDINGS[building.kind].name}, level ${building.level}` : job ? `${BUILDINGS[job.kind].name}, being built` : kind.kind === 'own' ? 'Empty plot' : 'Plot you can claim';
      return <polygon key={`h${x},${y}`} className="tt-hit" points={diamond(x, y)} fill="transparent" role="button" tabIndex={0} aria-label={name}
        aria-pressed={selectedPlot?.x === x && selectedPlot?.y === y} onClick={() => activate(selection)} onKeyDown={keyed(selection)} />;
    })}
    {bubbles.map(b => <g key={b.id} className="tt-bubble" role={onCollect ? 'button' : undefined} tabIndex={onCollect ? 0 : undefined}
      aria-label={onCollect ? `Collect ${count(b.value)} ${b.id}` : undefined} onClick={onCollect} onKeyDown={event => { if (onCollect && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onCollect(); } }}>
      <circle cx={b.x} cy={b.y} r={27} fill={BUBBLE[b.id]} opacity={0.2} filter="url(#tt-gl)" />
      <circle cx={b.x} cy={b.y} r={21} fill="url(#tt-bub)" stroke={BUBBLE[b.id]} strokeWidth={2} />
      <use href={`#tt-${b.id}`} x={b.x - 12} y={b.y - 14} width={24} height={24} />
      <path d={`M${b.x - 13},${b.y - 6}a14,14 0 0 1 8,-9`} stroke="#fff" strokeWidth={2.4} strokeOpacity={0.75} fill="none" strokeLinecap="round" />
      <rect x={b.x - 27} y={b.y + 12} width={54} height={19} rx={9.5} fill={BUBBLE[b.id]} />
      <text x={b.x} y={b.y + 25.5} textAnchor="middle" fill="#1a1530" fontSize={12.5} fontWeight={800}>+{compact(b.value)}</text>
      {b.spill > 0 && <g><rect x={b.x - (compact(b.spill).length * 6.2 + 74) / 2} y={b.y - 52 - b.lift} width={compact(b.spill).length * 6.2 + 74} height={18} rx={9} fill="#ff5a4a" filter="url(#tt-gl)" />
        <text x={b.x} y={b.y - 39.5 - b.lift} textAnchor="middle" fill="#fff" fontSize={10.5} fontWeight={800}>{compact(b.spill)} will spill</text><title>{`${count(b.spill)} will spill: the store is full`}</title></g>}
    </g>)}
  </svg>;
}
