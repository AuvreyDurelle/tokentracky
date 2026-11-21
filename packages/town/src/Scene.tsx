import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { BUILDINGS, RESOURCE_IDS, terrainAt, type BuildingId, type ResourceId, type Resources, type TownMapResponse, type TownPlot } from '@tokentracky/core';
import { BUILDING_HEIGHT, SCENE_DEFS, circle, createArt, isoProjection, r, spark } from './art.ts';
import { compact, count } from './format.ts';
import { plotKey, plotKind, plotTile, plotsBackToFront, type PlotKind, type SceneLayout } from './layout.ts';
import { townColour, townPieces } from './pieces.ts';
import { atHome, useSpin } from './spin.ts';
import { buildingOutline, spunProjection, toStage, type Moment } from './view.ts';
import { ResourceIcon } from './icons.tsx';
import type { World3D } from './world3d.ts';

export interface SceneBuilding {id?: string; kind: BuildingId; x: number; y: number; level: number}
export type Selection = {type: 'building'; id: string} | {type: 'plot'; x: number; y: number};
/** Uncollected harvest to float over the town, with what would spill. */
export interface SceneHarvest {resources: Resources; spill: Resources}

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
    s += `<circle cx="${r(x)}" cy="${r(y)}" r="${a > 0.94 ? 1.5 : a > 0.6 ? 0.9 : 0.6}" fill="#fff" opacity="${(0.2 + a * 0.7 * (1 - y / 800)).toFixed(2)}"/>`;
  }
  for (const [x, y, size] of [[150, 46, 7], [700, 96, 6], [880, 64, 5], [300, 40, 4], [1040, 40, 6], [86, 420, 5], [960, 250, 5]] as const) s += spark(x, y, size);
  s += '<ellipse cx="600" cy="770" rx="780" ry="190" fill="url(#tt-horizon)"/>' + circle(980, 120, 160, 'url(#tt-moon)') + circle(980, 120, 38, '#fff0d0')
    + [[-12, -10, 8], [10, 6, 5], [3, -19, 4]].map(([a, b, size]) => circle(980 + a!, 120 + b!, size!, '#f1dcb4', 'opacity=".65"')).join('');
  return s;
}
/**
 * A dozen stars that twinkle, over the still sky. Each is its own small layer, so twinkling never repaints the sky or the
 * town; animating every star in the drawing kept the whole screen repainting.
 */
const TWINKLES = (() => {
  let z = 11;
  const rn = () => (z = z * 16807 % 2147483647) / 2147483647;
  return Array.from({length: 12}, () => ({left: `${r(4 + rn() * 92)}%`, top: `${r(3 + rn() * 62)}%`, size: rn() > 0.6 ? 3 : 2, delay: `${r(-rn() * 4)}s`}));
})();
let sky: string | null = null;
export function Sky() {
  sky ??= skyMarkup();
  return <>
    <svg className="tt-sky" viewBox="0 0 1192 760" preserveAspectRatio="xMidYMid slice" aria-hidden="true" dangerouslySetInnerHTML={{__html: sky}} />
    <div className="tt-stars" aria-hidden="true">{TWINKLES.map((star, i) => <i key={i} style={{left: star.left, top: star.top, width: star.size, height: star.size, animationDelay: star.delay}} />)}</div>
  </>;
}

/** Starts fetching the 3D town's code, so it is ready by the time the town's data is. */
export const preloadWorld = () => import('./world3d.ts');

/** `value` as last time when its `key` hasn't changed, so a fresh copy of the same town redraws nothing. */
function useSame<T>(value: T, key: string): T {
  const last = useRef<{key: string; value: T} | null>(null);
  if (last.current?.key !== key) last.current = {key, value};
  return last.current.value;
}

interface Props {
  layout: SceneLayout;
  plots: readonly TownPlot[];
  buildings: readonly SceneBuilding[];
  map: TownMapResponse | null;
  selected: Selection | null;
  claimMode?: boolean;
  harvest?: SceneHarvest | null;
  /** What happens on a plot. Without it the scene can only be looked at. */
  onSelect?: (selection: Selection | null) => void;
  onCollect?: () => void;
  label: string;
  /** Someone else's town: no claim markers, since its free plots are not yours to claim. */
  visiting?: boolean;
  /** Whether the town can be turned. The scene keeps the angle, so turning redraws only the scene. */
  spins?: boolean;
  /** What just happened, played once when it arrives. */
  moment?: Moment | null;
  /** When the harvest was last collected: its bubbles fly to their stores (`data-store` elements on the stage). */
  collected?: number;
  /** A card over the scene, given where a point of the town (tile x, tile y, height) sits on the stage as it turns. */
  popover?: (place: Place, stage: StageSize) => ReactNode;
}
export type Place = (tx: number, ty: number, z: number) => {left: number; top: number};
export interface StageSize {width: number; height: number}

/**
 * A town at night in isometric view: its plots, the neighbourhood around it, and everything happening there. The town
 * itself is drawn in 3D where the browser has WebGL, so it can turn; labels, badges and click targets are a flat overlay
 * that turns with it. Without WebGL the flat drawing stays, facing one way.
 */
export function TownScene({layout: given, plots: givenPlots, buildings: givenBuildings, map, selected, claimMode = false, harvest, onSelect, onCollect, label, visiting = false, spins = false, moment = null, collected = 0, popover}: Props) {
  // Every refresh brings new copies of the same town; only a real change rebuilds the 3D world.
  const layout = useSame(given, JSON.stringify(given));
  const plots = useSame(givenPlots, givenPlots.map(p => plotKey(p.x, p.y)).join(' '));
  const buildings = useSame(givenBuildings, givenBuildings.map(b => `${b.id ?? ''}:${b.kind}:${b.x},${b.y}:${b.level}`).join(' '));
  const canvas = useRef<HTMLCanvasElement>(null);
  // The 3D world once it's made, or 'flat' where the browser can't make one and the flat drawing shows instead.
  const [made, setMade] = useState<World3D | 'flat' | null>(null);
  const world3d = made === 'flat' ? null : made;
  // The plot under the pointer or keyboard focus, as its key.
  const [hover, setHover] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [angle, setAngle] = useState(0);
  // Pointer moves can come faster than the screen draws; the town turns once a frame, to the latest angle.
  const frame = useRef(0), latest = useRef(0);
  const spinTo = useCallback((to: number) => {
    latest.current = to;
    frame.current ||= requestAnimationFrame(() => { frame.current = 0; setAngle(latest.current); });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const spinnable = spins && !!world3d;
  const turned = spinnable ? angle : 0;
  const P = useMemo(() => spunProjection(layout, turned), [layout, turned]);
  const spin = useSpin(turned, spinnable ? spinTo : undefined);
  const [size, setSize] = useState<StageSize>({width: 0, height: 0});
  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const measure = () => setSize(s => s.width === el.clientWidth && s.height === el.clientHeight ? s : {width: el.clientWidth, height: el.clientHeight});
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const place: Place = (tx, ty, z) => toStage(layout, size.width, size.height, P(tx, ty, z));
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
  const pieces = useMemo(() => townPieces({layout, kindAt, buildings, map}), [layout, buildings, own, others, map, visiting]);
  useEffect(() => {
    let live = true, world: World3D | null = null;
    preloadWorld().then(({createWorld3D}) => {
      if (!live || !canvas.current) return;
      try { world = createWorld3D(canvas.current); } catch { setMade('flat'); return; }
      setMade(world);
    }, () => { if (live) setMade('flat'); });
    return () => { live = false; world?.dispose(); };
  }, []);
  const ready = made !== null;
  // Before paint, so the town and its overlay arrive together.
  useLayoutEffect(() => { world3d?.draw(pieces, layout); }, [world3d, pieces, layout]);
  useLayoutEffect(() => { world3d?.turn(turned); }, [world3d, turned]);
  // After the draw above, so the moment plays on the town as it now stands.
  const played = useRef(0);
  useLayoutEffect(() => {
    if (!world3d || !moment || moment.at === played.current) return;
    played.current = moment.at;
    world3d.play(moment.kind, plotTile(layout, moment.x, moment.y));
  }, [world3d, moment, layout]);
  // The flat drawing of the same pieces, where there's no 3D town.
  const world = useMemo(() => {
    if (made !== 'flat') return '';
    const P = isoProjection(layout.originX, layout.originY);
    const art = createArt(P, 'tts');
    const nx = layout.cols * 2, ny = layout.rows * 2;
    let ground = '', edges = '', objects = '';
    const B0 = P(nx, ny)[1];
    const L = P(0, ny, -26), R = P(nx, 0, -26), F = P(nx, ny, -26);
    let rock = art.poly([L, [L[0] + (F[0] - L[0]) * 0.35, B0 + 70], [F[0], B0 + 150], [F[0] + (R[0] - F[0]) * 0.65, B0 + 70], R, F], '#1b1534')
      + art.poly([L, [L[0] + (F[0] - L[0]) * 0.35, B0 + 70], [F[0], B0 + 150], F], '#231b40');
    rock += [[-0.6, 50], [-0.25, 96], [0.15, 110], [0.5, 70]].map(([k, dy], i) => art.dot([F[0] + k! * (R[0] - L[0]) * 0.5, B0 + dy!], 2.2, i % 2 ? '#b18cff' : '#7fe3ff')).join('');
    const slab = art.poly([P(0, ny), P(nx, ny), P(nx, ny, -26), P(0, ny, -26)], '#2c2347') + art.poly([P(nx, 0), P(nx, ny), P(nx, ny, -26), P(nx, 0, -26)], '#201a39')
      + art.poly([P(0, ny), P(nx, ny), P(nx, ny, -6), P(0, ny, -6)], '#2e4c48') + art.poly([P(nx, 0), P(nx, ny), P(nx, ny, -6), P(nx, 0, -6)], '#243d3b');
    for (const piece of pieces) {
      switch (piece.type) {
        case 'tile': ground += art.poly(art.sq(piece.x, piece.y, 1, 1), piece.colour); break;
        case 'ripple': { const c = P(piece.x, piece.y); ground += `<path d="M${r(c[0] - 14)},${r(c[1])}h28" stroke="#9fb6f0" stroke-opacity=".3" stroke-width="1.5" stroke-linecap="round"/>`; break; }
        case 'border': edges += art.line(P(...piece.a), P(...piece.b), piece.colour, piece.own ? 2.6 : 1.6, piece.own ? '' : 'opacity=".6"'); break;
        case 'building': objects += art.building(piece.kind, piece.x, piece.y, piece.level); break;
        case 'house': objects += art.house(piece.x, piece.y, piece.roof, piece.variant); break;
        case 'tree': objects += art.tree(piece.x, piece.y, piece.size, piece.pine); break;
        case 'lamp': objects += art.lamp(piece.x, piece.y); break;
      }
    }
    return `${rock}${slab}${ground}<g filter="url(#tt-mg)">${edges}</g>${objects}<defs>${art.defs}</defs>`;
  }, [layout, pieces, made]);

  const tile = (x: number, y: number) => plotTile(layout, x, y);
  const diamond = (x: number, y: number, inset = 0) => {
    const [tx, ty] = tile(x, y);
    return [P(tx + inset, ty + inset), P(tx + 2 - inset, ty + inset), P(tx + 2 - inset, ty + 2 - inset), P(tx + inset, ty + 2 - inset)].map(p => `${r(p[0])},${r(p[1])}`).join(' ');
  };
  const order = plotsBackToFront(layout);
  const byPlot = new Map(buildings.map(b => [plotKey(b.x, b.y), b]));
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
    const top = place(tx + 1, ty + 1, BUILDING_HEIGHT[source.kind] + 40);
    const shift = (sharing.findIndex(other => other.id === id) - (sharing.length - 1) / 2) * 62;
    // Spill warnings alternate in height so neighbouring ones never overlap.
    return {id, x: top.left + shift, y: top.top, value: harvest!.resources[id], spill: harvest!.spill[id], lift: sharing.findIndex(other => other.id === id) % 2 * 20};
  });

  // The hovered plot's highlight, with a building's name over its roof.
  const hovered = (() => {
    if (!hover || !onSelect) return null;
    const [x, y] = hover.split(',').map(Number) as [number, number];
    const kind = kindAt(x, y).kind;
    if (kind !== 'own' && kind !== 'claimable') return null;
    const building = byPlot.get(hover);
    const [tx, ty] = tile(x, y);
    return {x, y, name: building ? `${BUILDINGS[building.kind].name} · Lv ${building.level}` : null, at: P(tx + 1, ty + 1, (building ? BUILDING_HEIGHT[building.kind] : 0) + 22)};
  })();
  // Collected bubbles fly from where they floated to their stores. Bubbles from the frame before the collect, since the
  // harvest is already empty by the time this runs; so this effect comes before the one that remembers them.
  const shown = useRef(bubbles);
  const [flights, setFlights] = useState<Array<{id: ResourceId; x: number; y: number; dx: number; dy: number}>>([]);
  useLayoutEffect(() => {
    const stage = svg.current?.parentElement;
    if (!collected || !stage || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = stage.getBoundingClientRect();
    const next = shown.current.flatMap(b => {
      const store = stage.querySelector(`[data-store="${b.id}"]`)?.getBoundingClientRect();
      return store ? [{id: b.id, x: b.x, y: b.y, dx: store.left + store.width / 2 - box.left - b.x, dy: store.top + store.height / 2 - box.top - b.y}] : [];
    });
    setFlights(next);
    const timer = window.setTimeout(() => setFlights([]), 900);
    return () => window.clearTimeout(timer);
  }, [collected]);
  useLayoutEffect(() => { shown.current = bubbles; });

  const activate = (selection: Selection) => onSelect?.(selection);
  const keyed = (selection: Selection) => (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(selection); } };

  return <>
  <canvas ref={canvas} className={ready ? 'tt-world tt-in' : 'tt-world'} aria-hidden="true" />
  <svg ref={svg} className={`tt-town${spinnable ? ' tt-spins' : ''}${ready ? ' tt-in' : ''}`} viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet" role="group"
    aria-label={spinnable ? `${label}. Drag or use the arrow keys to turn it.` : label} tabIndex={spinnable ? 0 : undefined} {...spin.handlers}>
    <defs dangerouslySetInnerHTML={{__html: SCENE_DEFS}} />
    {/* The overlay waits for the town under it, so labels never float over an empty island. */}
    {ready && <>
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
    {/* Level badges. */}
    {buildings.map(b => {
      const [tx, ty] = tile(b.x, b.y);
      const p = P(tx + 1.7, ty + 1.7, 30);
      const gold = selected?.type === 'building' && selected.id === b.id;
      // A badge whose building just went up a level pops; its key changes with the level so the pop replays.
      const pops = (moment?.kind === 'upgrade' || moment?.kind === 'build') && moment.x === b.x && moment.y === b.y;
      return <g key={`l${b.x},${b.y},${b.level}`} className={pops ? 'tt-badge-pop' : undefined} pointerEvents="none">
        <circle cx={p[0]} cy={p[1]} r={10.5} fill={gold ? '#ffd36b' : '#211e4c'} stroke={gold ? '#fff3c4' : '#bdb8ff'} strokeWidth={1.6} />
        <text x={p[0]} y={p[1] + 4} textAnchor="middle" fill={gold ? '#2a1d00' : '#fff'} fontSize={11} fontWeight={800}>{b.level}</text>
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
    {hovered && <g pointerEvents="none">
      <polygon points={diamond(hovered.x, hovered.y, 0.05)} fill="rgba(255,211,107,.1)" stroke="rgba(255,211,107,.7)" strokeWidth={1.5} strokeLinejoin="round" />
      {hovered.name && <g className="tt-tip">
        <rect x={hovered.at[0] - hovered.name.length * 3.6 - 12} y={hovered.at[1] - 12} width={hovered.name.length * 7.2 + 24} height={24} rx={12} fill="rgba(14,12,40,.9)" stroke="rgba(255,211,107,.5)" />
        <text x={hovered.at[0]} y={hovered.at[1] + 4.5} textAnchor="middle" fill="#fff3c4" fontSize={12.5} fontWeight={700}>{hovered.name}</text>
      </g>}
    </g>}
    {/* Plots you can act on take clicks and keys, back to front so a building in front takes the clicks over what it hides.
        A building takes them over its whole height, not just its ground. */}
    {onSelect && order.map(([x, y]) => {
      const kind = kindAt(x, y);
      const building = byPlot.get(plotKey(x, y));
      if (kind.kind !== 'own' && kind.kind !== 'claimable') return null;
      const selection: Selection = building?.id ? {type: 'building', id: building.id} : {type: 'plot', x, y};
      const name = building ? `${BUILDINGS[building.kind].name}, level ${building.level}` : kind.kind === 'own' ? 'Empty plot' : 'Plot you can claim';
      const [tx, ty] = tile(x, y);
      const points = building ? buildingOutline(P, tx, ty, BUILDING_HEIGHT[building.kind]).map(p => `${r(p[0])},${r(p[1])}`).join(' ') : diamond(x, y);
      const key = plotKey(x, y);
      const enter = () => setHover(key), leave = () => setHover(h => h === key ? null : h);
      return <polygon key={`h${x},${y}`} className="tt-hit" points={points} fill="transparent" role="button" tabIndex={0} aria-label={name}
        aria-pressed={selectedPlot?.x === x && selectedPlot?.y === y} onClick={() => activate(selection)} onKeyDown={keyed(selection)}
        onPointerEnter={enter} onPointerLeave={leave} onFocus={enter} onBlur={leave} />;
    })}
    </>}
  </svg>
  {ready && bubbles.length > 0 && size.width > 0 && <div className="tt-bubbles tt-in">
    {bubbles.map((b, i) => <button key={b.id} type="button" className="tt-bubble" disabled={!onCollect} onClick={onCollect} aria-label={`Collect ${count(b.value)} ${b.id}`}
      style={{left: b.x, top: b.y, '--tt-c': BUBBLE[b.id], animationDelay: `${-1.4 * (i % 2)}s`} as CSSProperties}>
      <span className="tt-orb"><ResourceIcon id={b.id} size={24} /></span>
      <span className="tt-amt">+{compact(b.value)}</span>
      {b.spill > 0 && <span className="tt-spill" style={{marginBottom: b.lift}} title={`${count(b.spill)} will spill: the store is full`}>{compact(b.spill)} will spill</span>}
    </button>)}
  </div>}
  {flights.length > 0 && <div className="tt-bubbles" aria-hidden="true">
    {flights.map((f, i) => <span key={f.id} className="tt-flight" style={{left: f.x, top: f.y, '--dx': `${f.dx}px`, '--dy': `${f.dy}px`, '--tt-c': BUBBLE[f.id], animationDelay: `${i * 0.06}s`} as CSSProperties}>
      <span className="tt-orb"><ResourceIcon id={f.id} size={24} /></span>
    </span>)}
  </div>}
  {popover && size.width > 0 && popover(place, size)}
  {spinnable && !atHome(angle) && <div className="tt-glass tt-reset"><button type="button" onClick={spin.home}>Reset view</button></div>}
  </>;
}
