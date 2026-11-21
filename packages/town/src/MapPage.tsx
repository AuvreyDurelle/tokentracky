import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { BUILDINGS, terrainAt, type Terrain, type TownMapResponse, type TownPublic, type TownSelf } from '@tokentracky/core';
import type { TownApi } from './api.ts';
import { CostChips, Crest, useToast } from './Hud.tsx';
import { CloseIcon, GlyphIcon, HeartIcon, HomeIcon, MinusIcon, PlusIcon } from './icons.tsx';
import { afterCollect, count, daysToAfford, paceText, tooBig, tweenAt } from './format.ts';
import { EASE_MS, glide, releaseSpeed } from './spin.ts';
import { cellAt, clampCell, fetchArea, fitView, screenOf, visibleArea, wheelIntent, within, zoomAt, type Area, type MapView } from './map-view.ts';
import { townColour } from './pieces.ts';

const hash = (c: number, q: number) => ((Math.imul(c, 73856093) ^ Math.imul(q, 19349663)) >>> 0);
/** A plot as one number, for fast lookups: the map is far smaller than 65,536 plots a side. */
const cellKey = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768);

/** The map's ground never changes, so each plot's terrain is worked out once. */
const terrains = new Map<number, Terrain>();
function terrainOf(x: number, y: number): Terrain {
  const key = cellKey(x, y);
  let t = terrains.get(key);
  if (t === undefined) {
    if (terrains.size > 400_000) terrains.clear();
    t = terrainAt(x, y);
    terrains.set(key, t);
  }
  return t;
}

/** Which sides of a plot face another town or open ground, as bits: up, down, left, right. */
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8;
/** What drawing needs from a map response, worked out once per response rather than once per frame. */
export interface MapIndex {owners: Map<number, number>; centres: Map<number, [number, number]>; byTown: Map<number, Array<[number, number, number]>>}
export function indexMap(data: TownMapResponse | null): MapIndex {
  const owners = new Map<number, number>(), sums = new Map<number, [number, number, number]>(), byTown = new Map<number, Array<[number, number, number]>>();
  for (const [x, y, town] of data?.plots ?? []) owners.set(cellKey(x, y), town);
  for (const [x, y, town] of data?.plots ?? []) {
    const c = sums.get(town) ?? [0, 0, 0];
    sums.set(town, [c[0] + x + 0.5, c[1] + y + 0.5, c[2] + 1]);
    const other = (ax: number, ay: number) => owners.get(cellKey(ax, ay)) !== town;
    const sides = (other(x, y - 1) ? UP : 0) | (other(x, y + 1) ? DOWN : 0) | (other(x - 1, y) ? LEFT : 0) | (other(x + 1, y) ? RIGHT : 0);
    let list = byTown.get(town);
    if (!list) byTown.set(town, list = []);
    if (sides) list.push([x, y, sides]);
  }
  return {owners, byTown, centres: new Map([...sums].map(([town, [x, y, n]]) => [town, [x / n, y / n]]))};
}

/**
 * Draws the public map: terrain, every claimed plot in its town's colour, your land glowing, Wonders as stars, names, and
 * mist past the frontier. Shapes of one colour are gathered into one path and filled once: a zoomed-out map shows over
 * twelve thousand plots, and filling each on its own made panning stutter.
 */
function draw(canvas: HTMLCanvasElement, view: MapView, data: TownMapResponse | null, index: MapIndex, me: string | null, selected: string | null, hovered: number) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const bg = ctx.createRadialGradient(width * 0.48, height * 0.52, 0, width * 0.48, height * 0.52, Math.max(width, height) * 0.75);
  bg.addColorStop(0, '#1d1f50'); bg.addColorStop(1, '#090a22');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  const cell = view.cell, gap = Math.max(1, cell * 0.05), round = Math.min(4, cell * 0.16);
  const area = visibleArea(view, width, height);
  const {owners, centres, byTown} = index;
  const towns = data?.towns ?? [];
  const mine = towns.findIndex(t => t.alias !== null && t.alias === me);
  const chosen = towns.findIndex(t => t.alias !== null && t.alias === selected);
  // The selected town and the one under the pointer both stand out.
  const lit = (town: number) => town === chosen || town === hovered;
  const edge = data?.edge ?? 0;
  // Small plots skip the rounded corners: under 2 pixels they can't be seen, and rounding thousands of them is slow.
  const tile = (path: Path2D, x: number, y: number, w: number, h: number) => { if (cell >= 14) path.roundRect(x, y, w, h, round); else path.rect(x, y, w, h); };
  const water = new Path2D(), ripples = new Path2D(), land = new Path2D(), forest = new Path2D(), treeA = new Path2D(), treeB = new Path2D();
  const plots = new Map<number, Path2D>(), lights = new Map<number, Path2D>();
  const pathOf = (paths: Map<number, Path2D>, town: number) => { let p = paths.get(town); if (!p) paths.set(town, p = new Path2D()); return p; };
  const fill = (p: Path2D | undefined, style: string, alpha = 1) => { if (!p) return; ctx.globalAlpha = alpha; ctx.fillStyle = style; ctx.fill(p); ctx.globalAlpha = 1; };
  // Ground and plots.
  const [x0, y0] = screenOf(view, width, height, area.x0, area.y0);
  for (let y = area.y0, sy = y0; y <= area.y1; y++, sy += cell) for (let x = area.x0, sx = x0; x <= area.x1; x++, sx += cell) {
    const town = owners.get(cellKey(x, y));
    if (town === undefined) {
      const terrain = terrainOf(x, y);
      if (terrain === 'water') {
        water.rect(sx, sy, cell, cell);
        if (cell >= 14 && hash(x, y) % 4 === 0) {
          const r = ripples;
          r.moveTo(sx + cell * 0.2, sy + cell * 0.5); r.quadraticCurveTo(sx + cell * 0.35, sy + cell * 0.38, sx + cell * 0.5, sy + cell * 0.5); r.quadraticCurveTo(sx + cell * 0.65, sy + cell * 0.62, sx + cell * 0.8, sy + cell * 0.5);
        }
        continue;
      }
      tile(terrain === 'forest' ? forest : land, sx + gap, sy + gap, cell - gap * 2, cell - gap * 2);
      if (terrain === 'forest' && cell >= 12) {
        const a = treeA, b = treeB;
        a.moveTo(sx + cell * 0.54, sy + cell * 0.42); a.arc(sx + cell * 0.35, sy + cell * 0.42, cell * 0.19, 0, Math.PI * 2);
        b.moveTo(sx + cell * 0.88, sy + cell * 0.62); b.arc(sx + cell * 0.65, sy + cell * 0.62, cell * 0.23, 0, Math.PI * 2);
      }
      continue;
    }
    tile(pathOf(plots, town), sx + gap, sy + gap, cell - gap * 2, cell - gap * 2);
    if (cell >= 12) {
      const n = town === mine ? 3 : 1 + (hash(x, y) % 2), radius = cell * (town === mine ? 0.07 : 0.05), p = pathOf(lights, town);
      for (let i = 0; i < n; i++) {
        const h = hash(x * 7 + i, y * 13 + i), cx = sx + cell * (0.25 + (h % 15) / 30), cy = sy + cell * (0.25 + ((h >> 4) % 15) / 30);
        p.moveTo(cx + radius, cy); p.arc(cx, cy, radius, 0, Math.PI * 2);
      }
    }
  }
  fill(water, '#11204c');
  if (cell >= 14) { ctx.strokeStyle = 'rgba(95,128,208,.45)'; ctx.lineWidth = 1.3; ctx.stroke(ripples); }
  fill(land, '#15183c'); fill(forest, '#10222c'); fill(treeA, '#1d4436'); fill(treeB, '#265a42');
  const colourOf = (town: number) => town === mine ? '#ffe39a' : townColour(towns[town]?.alias ?? null);
  for (const [town, p] of plots) fill(p, colourOf(town), town === mine ? 0.34 : lit(town) ? 0.24 : 0.13);
  for (const [town, p] of lights) fill(p, town === mine ? '#fff6d6' : colourOf(town));
  // Borders: each town's outline in its colour, one path a town; yours glows.
  for (const pass of ['others', 'mine'] as const) {
    ctx.save();
    if (pass === 'mine') { ctx.shadowColor = '#ffd36b'; ctx.shadowBlur = 12; }
    ctx.lineCap = 'round';
    for (const [town, cells] of byTown) {
      if ((town === mine) !== (pass === 'mine')) continue;
      const path = new Path2D(), d = gap + 1;
      let any = false;
      for (const [x, y, sides] of cells) {
        if (x < area.x0 - 1 || x > area.x1 + 1 || y < area.y0 - 1 || y > area.y1 + 1) continue;
        const [sx, sy] = screenOf(view, width, height, x, y);
        any = true;
        if (sides & UP) { path.moveTo(sx + d, sy + d); path.lineTo(sx + cell - d, sy + d); }
        if (sides & DOWN) { path.moveTo(sx + d, sy + cell - d); path.lineTo(sx + cell - d, sy + cell - d); }
        if (sides & LEFT) { path.moveTo(sx + d, sy + d); path.lineTo(sx + d, sy + cell - d); }
        if (sides & RIGHT) { path.moveTo(sx + cell - d, sy + d); path.lineTo(sx + cell - d, sy + cell - d); }
      }
      if (!any) continue;
      ctx.strokeStyle = town === mine ? '#ffe9b0' : colourOf(town);
      ctx.lineWidth = town === mine ? 3 : lit(town) ? 2.6 : 1.6;
      ctx.stroke(path);
    }
    ctx.restore();
  }
  // Wonders: stars.
  for (const [x, y] of data?.wonders ?? []) {
    const [sx, sy] = screenOf(view, width, height, x + 0.5, y + 0.5);
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, cell * 1.4);
    glow.addColorStop(0, 'rgba(228,236,255,.7)'); glow.addColorStop(1, 'rgba(228,236,255,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx, sy, cell * 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.shadowColor = '#fffbe6'; ctx.shadowBlur = 10; ctx.fillStyle = '#fffbe6'; ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = (i % 2 ? 0.45 : 1) * cell * 0.34; ctx.lineTo(sx + q * Math.cos(a), sy + q * Math.sin(a)); }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  // Mist past the frontier, where new and moving towns arrive: thicker with each ring out, as square rings.
  if (data) {
    const ring = (inner: number, outer: number | null, alpha: number) => {
      const [ix0, iy0] = screenOf(view, width, height, -inner, -inner), [ix1, iy1] = screenOf(view, width, height, inner + 1, inner + 1);
      const p = new Path2D();
      if (outer === null) p.rect(-1, -1, width + 2, height + 2);
      else { const [ox0, oy0] = screenOf(view, width, height, -outer, -outer), [ox1, oy1] = screenOf(view, width, height, outer + 1, outer + 1); p.rect(ox0, oy0, ox1 - ox0, oy1 - oy0); }
      p.rect(ix0, iy0, ix1 - ix0, iy1 - iy0);
      ctx.fillStyle = `rgba(28,25,68,${alpha})`;
      ctx.fill(p, 'evenodd');
    };
    // A plot `beyond` rings past edge + 2 gets min(0.85, 0.25 + 0.12 × beyond); from the fifth ring on it's all 0.85.
    for (let beyond = 1; beyond <= 4; beyond++) ring(edge + 1 + beyond, edge + 2 + beyond, 0.25 + beyond * 0.12);
    ring(edge + 6, null, 0.85);
  }
  // Names: you, the selected town, then the biggest towns, never overlapping.
  const placed: Array<[number, number, number, number]> = [];
  const label = (text: string, x: number, y: number, colour: string, gold: boolean) => {
    ctx.font = `${gold ? 800 : 700} ${gold ? 13 : 11.5}px Inter, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + (gold ? 22 : 34), h = gold ? 26 : 22;
    const box: [number, number, number, number] = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
    // Clear of the panels: the name plate and key at the top, the zoom buttons on the right, the dock at the bottom.
    if (!gold && (box[0] < 4 || box[2] > width - 64 || box[1] < 150 || box[3] > height - 90 || placed.some(p => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]))) return;
    placed.push(box);
    ctx.fillStyle = gold ? '#ffd36b' : 'rgba(14,12,40,.86)'; ctx.strokeStyle = gold ? '#fff3c4' : 'rgba(200,195,255,.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(box[0], box[1], w, h, h / 2); ctx.fill(); ctx.stroke();
    if (!gold) { ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(box[0] + 13, y, 4.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = gold ? '#2a1d00' : '#f2f1ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, gold ? x : x + 7, y + 0.5);
  };
  const at = (town: number) => { const [x, y] = centres.get(town)!; return screenOf(view, width, height, x, y); };
  // "You" sits just above your land so the land itself stays in view.
  if (mine >= 0 && centres.has(mine)) { const [x, y] = at(mine); label('You', x, y - Math.max(22, cell * 0.9), '#ffd36b', true); }
  const order = [...centres.keys()].filter(t => t !== mine && towns[t]?.alias).sort((a, b) => (lit(b) ? 1 : 0) - (lit(a) ? 1 : 0) || (towns[b]!.plots - towns[a]!.plots));
  for (const town of order) {
    const t = towns[town]!;
    if (!lit(town) && (cell < 10 || t.plots < (cell >= 22 ? 1 : 6))) continue;
    const [x, y] = at(town);
    label(`@${t.alias}${lit(town) ? ` · Lv ${t.level}` : ''}`, x, y, townColour(t.alias), false);
  }
}

/**
 * The public map of every town, with your own town's dock when you have one. With `feature`, it opens on the biggest
 * town with its card showing instead of on yours; `aside` is a panel the host puts on the map.
 */
export function MapPage({api, signedIn, feature = false, aside, onHome, onVisit}: {api: TownApi; signedIn: boolean; feature?: boolean; aside?: ReactNode;
  onHome?: () => void; onVisit: (alias: string) => void}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [me, setMe] = useState<TownSelf | null>(null);
  const [view, setView] = useState<MapView>({cx: 0, cy: 0, cell: 26});
  const [data, setData] = useState<TownMapResponse | null>(null);
  const [fetched, setFetched] = useState<Area | null>(null);
  const [selected, setSelected] = useState<{alias: string; town: TownPublic | null; liked: boolean | null; at: [number, number]} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, say] = useToast();
  const [size, setSize] = useState({width: 0, height: 0});
  // The named town under the pointer, by index into the map's towns, or -1.
  const [hovered, setHovered] = useState(-1);
  const drag = useRef<{x: number; y: number; view: MapView; moved: boolean; trail: Array<[number, number, number]>} | null>(null);
  // Until the first map arrives: the featured town to open, if wanted.
  const featuring = useRef(feature);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth, height = el.clientHeight;
      setSize({width, height});
      // A wider canvas may need bigger plots for what shows to fit one request.
      setView(v => fitView(v, width, height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    void api.me().then(town => { setMe(town); const [first] = town.plots; if (first && !feature) setView(v => ({...v, cx: first.x + 0.5, cy: first.y + 0.5})); }).catch(() => {});
  }, [api, signedIn, feature]);
  // Fetch the plots around the view as soon as it leaves what was fetched, panning or not. One request at a time, unless
  // the view leaves that one's area too; only the newest answer is kept.
  const loading = useRef<Area | null>(null), request = useRef(0);
  useEffect(() => {
    if (!size.width) return;
    const visible = visibleArea(view, size.width, size.height);
    // Back inside what's loaded: a request for somewhere else is no longer wanted.
    if (fetched && within(visible, fetched)) { if (loading.current) { request.current++; loading.current = null; } return; }
    if (loading.current && within(visible, loading.current)) return;
    const area = fetchArea(view, size.width, size.height);
    const ticket = ++request.current;
    loading.current = area;
    api.map(area).then(next => {
      if (ticket !== request.current) return;
      loading.current = null;
      setData(next); setFetched(area); setError(null);
    }, failure => {
      if (ticket !== request.current) return;
      loading.current = null;
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [api, view, size, fetched]);
  useEffect(() => () => { request.current++; loading.current = null; }, []);
  const index = useMemo(() => indexMap(data), [data]);
  // Drawn before the browser paints, in the same frame as the move that changed the view.
  useLayoutEffect(() => { if (canvas.current && size.width) draw(canvas.current, view, data, index, me?.alias ?? null, selected?.alias ?? null, hovered); }, [view, data, index, me, selected, size, hovered]);
  // Pointers and wheels can report faster than the screen draws: the view moves once a frame, to the latest place.
  const nextView = useRef<MapView | null>(null), frame = useRef(0);
  const moveTo = (next: MapView) => {
    nextView.current = next;
    frame.current ||= requestAnimationFrame(() => {
      frame.current = 0;
      const v = nextView.current;
      nextView.current = null;
      if (v) flushSync(() => setView(v));
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // The map gliding on after a flick, or easing to where a button sends it. Any touch of the map stops it.
  const motion = useRef(0);
  useEffect(() => () => cancelAnimationFrame(motion.current), []);
  const still = () => cancelAnimationFrame(motion.current);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const easeTo = (target: MapView) => {
    still();
    const from = nextView.current ?? view, start = performance.now();
    if (reduced()) { setView(target); return; }
    const step = (now: number) => {
      const t = (now - start) / EASE_MS;
      // Zoom eases evenly in scale, so zooming in and out feel alike.
      flushSync(() => setView({cx: tweenAt(from.cx, target.cx, t), cy: tweenAt(from.cy, target.cy, t), cell: Math.exp(tweenAt(Math.log(from.cell), Math.log(target.cell), t))}));
      if (t < 1) motion.current = requestAnimationFrame(step);
    };
    motion.current = requestAnimationFrame(step);
  };
  const glideFrom = (base: MapView, vx: number, vy: number) => {
    if (reduced() || (!vx && !vy)) return;
    let v = base, last = performance.now();
    const step = (now: number) => {
      const ms = now - last;
      last = now;
      vx = glide(vx, ms); vy = glide(vy, ms);
      // Under a fiftieth of a pixel a millisecond, the map has stopped as far as anyone can see.
      if (Math.hypot(vx, vy) < 0.02) return;
      v = {...v, cx: v.cx - vx * ms / v.cell, cy: v.cy - vy * ms / v.cell};
      flushSync(() => setView(v));
      motion.current = requestAnimationFrame(step);
    };
    motion.current = requestAnimationFrame(step);
  };

  const point = (event: {clientX: number; clientY: number}) => { const box = canvas.current!.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top] as const; };
  const open = useCallback((alias: string, at: [number, number]) => {
    setSelected({alias, town: null, liked: null, at});
    api.town(alias).then(town => setSelected(s => s?.alias === alias ? {...s, town} : s)).catch(failure => { setSelected(null); say(failure instanceof Error ? failure.message : String(failure)); });
    if (api.liked && signedIn && alias !== me?.alias) api.liked(alias).then(liked => setSelected(s => s?.alias === alias ? {...s, liked} : s)).catch(() => {});
  }, [api, signedIn, me, say]);
  /** The named town on the plot under a point, as its index and the plot. */
  const townAt = (px: number, py: number) => {
    const [x, y] = cellAt(nextView.current ?? view, size.width, size.height, px, py);
    const town = index.owners.get(cellKey(x, y));
    return town !== undefined && data?.towns[town]?.alias ? {town, alias: data.towns[town]!.alias!, x, y} : null;
  };
  const click = (px: number, py: number) => {
    const hit = townAt(px, py);
    if (hit) open(hit.alias, [hit.x + 0.5, hit.y + 0.5]); else setSelected(null);
  };
  // Wheels and pinches, on a listener that may cancel them, so a pinch zooms the map and never the whole page.
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  wheel.current = event => {
    event.preventDefault();
    still();
    const base = nextView.current ?? view;
    if (wheelIntent(event) === 'pan') { moveTo({...base, cx: base.cx + event.deltaX / base.cell, cy: base.cy + event.deltaY / base.cell}); return; }
    const [px, py] = point(event);
    // A pinch reports small steps; a wheel big ones.
    moveTo(zoomAt(base, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), size.width, size.height, px, py));
  };
  // Safari and the app's web view report a pinch as gestures rather than wheels.
  const pinch = useRef({scale: 1, px: 0, py: 0});
  const gesture = useRef<(event: Event & {scale?: number; clientX?: number; clientY?: number}, start: boolean) => void>(() => {});
  gesture.current = (event, start) => {
    event.preventDefault();
    const scale = event.scale ?? 1;
    if (start) { still(); const [px, py] = point({clientX: event.clientX ?? 0, clientY: event.clientY ?? 0}); pinch.current = {scale, px, py}; return; }
    const {px, py} = pinch.current;
    moveTo(zoomAt(nextView.current ?? view, scale / pinch.current.scale, size.width, size.height, px, py));
    pinch.current.scale = scale;
  };
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => wheel.current(event);
    const onStart = (event: Event) => gesture.current(event, true), onChange = (event: Event) => gesture.current(event, false);
    el.addEventListener('wheel', onWheel, {passive: false});
    el.addEventListener('gesturestart', onStart);
    el.addEventListener('gesturechange', onChange);
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('gesturestart', onStart); el.removeEventListener('gesturechange', onChange); };
  }, []);
  useEffect(() => {
    if (!featuring.current || !data) return;
    featuring.current = false;
    if (!data.featured) return;
    const {alias, x, y} = data.featured;
    setView(v => ({...v, cx: x + 0.5, cy: y + 0.5}));
    open(alias, [x + 0.5, y + 0.5]);
  }, [data, open]);
  const zoom = (factor: number) => easeTo(zoomAt(nextView.current ?? view, factor, size.width, size.height, size.width / 2, size.height / 2));
  const like = async () => {
    if (!selected?.town || !api.like || selected.liked === null) return;
    const next = !selected.liked;
    try {
      await api.like(selected.alias, next);
      setSelected(s => s && s.town ? {...s, liked: next, town: {...s.town, likes: s.town.likes + (next ? 1 : -1)}} : s);
    } catch (failure) { say(failure instanceof Error ? failure.message : String(failure)); }
  };
  const anchor = selected ? screenOf(view, size.width, size.height, selected.at[0], selected.at[1]) : null;
  const price = me?.nextPlot.cost.bricks ?? 0;
  // What collecting would leave to spend, as claiming counts it.
  const spendable = me ? afterCollect(me.wallet, me.harvest.resources, me.caps).bricks : 0;
  const short = me ? Math.max(0, price - spendable) : 0;

  return <div ref={stage} className="tt tt-stage tt-map">
    <canvas ref={canvas} className="tt-canvas" role="img" aria-label="The public map of every town"
      onPointerDown={event => { still(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = {x: event.clientX, y: event.clientY, view: nextView.current ?? view, moved: false, trail: []}; }}
      onPointerMove={event => {
        const d = drag.current;
        if (!d) {
          const [px, py] = point(event), hit = townAt(px, py)?.town ?? -1;
          if (hit !== hovered) setHovered(hit);
          return;
        }
        const dx = event.clientX - d.x, dy = event.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
        if (!d.moved) return;
        d.trail.push([event.timeStamp, dx, dy]);
        moveTo({...d.view, cx: d.view.cx - dx / d.view.cell, cy: d.view.cy - dy / d.view.cell});
      }}
      onPointerUp={event => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) { const [px, py] = point(event); click(px, py); return; }
        // A flick glides on, slowing as the town does when flicked round.
        if (d?.trail.length) {
          const last = d.trail[d.trail.length - 1]!;
          glideFrom({...d.view, cx: d.view.cx - last[1] / d.view.cell, cy: d.view.cy - last[2] / d.view.cell},
            releaseSpeed(d.trail.map(([t, x]) => [t, x]), event.timeStamp), releaseSpeed(d.trail.map(([t, , y]) => [t, y]), event.timeStamp));
        }
      }}
      onPointerLeave={() => setHovered(-1)} style={hovered >= 0 ? {cursor: 'pointer'} : undefined} />
    <div className="tt-top">
      {me && <Crest alias={me.alias} level={me.level} plots={me.plots.length} />}
      <div className="tt-glass tt-ttl"><b>Public map</b><span className="tt-mu">{data ? `${count(data.totals.towns)} towns · ${count(data.totals.plots)} plots claimed` : 'Loading…'}</span></div>
    </div>
    <div className="tt-glass tt-key" aria-label="Map key">
      <span><i style={{background: 'rgba(255,227,154,.45)', boxShadow: '0 0 0 1.5px #ffe39a, 0 0 8px #ffe39a'}} />Your land</span>
      <span><i style={{background: 'linear-gradient(135deg,#5fe0c8,#ff7aa8 50%,#b69cff)'}} />Other towns</span>
      <span><i className="star">★</i>Wonder</span>
      <span><i style={{background: '#16285a'}} />Water</span>
      <span><i style={{background: '#1d4436'}} />Forest</span>
      <span><i style={{background: 'linear-gradient(90deg,#1b1840,#4a4390)'}} />Frontier</span>
    </div>
    <div className="tt-glass tt-zoom">
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1.4)}><PlusIcon size={18} /></button>
      <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.4)}><MinusIcon size={18} /></button>
      {me && <button type="button" aria-label="Show your town" onClick={() => { const [first] = me.plots; if (first) { const v = nextView.current ?? view; easeTo({cx: first.x + 0.5, cy: first.y + 0.5, cell: clampCell(Math.max(v.cell, 26), size.width, size.height)}); } }}><HomeIcon size={18} /></button>}
    </div>
    {error && <div className="tt-glass tt-banner" role="alert">{error}</div>}
    {selected && anchor && <TownCard selected={selected} anchor={anchor} stage={stage} mine={selected.alias === me?.alias} canLike={!!api.like && signedIn}
      onVisit={() => onVisit(selected.alias)} onHome={onHome} onLike={() => void like()} onClose={() => setSelected(null)} />}
    {(onHome || me) && <div className="tt-glass tt-dock tt-dock-map">
      {onHome && <button type="button" className="tt-db" onClick={onHome}><HomeIcon />Your town</button>}
      {me && <div className="tt-cl"><div className="tt-kv"><span>Next plot #{me.nextPlot.number}</span><b><CostChips cost={me.nextPlot.cost} /></b></div>
        <div className="tt-pb"><i style={{width: `${Math.min(100, price ? spendable / price * 100 : 100)}%`}} /></div>
        <div className="tt-kv tt-mu"><span>{count(spendable)} of {count(price)}</span>{short > 0 ? <span className="tt-sh">{tooBig(me.nextPlot.cost, me.caps) ? 'Needs a bigger store' : paceText(daysToAfford(short, me.bricksPerDay)) ?? `${count(short)} short`}</span> : <span className="tt-ok">Ready</span>}</div></div>}
    </div>}
    {aside && <div className="tt-aside">{aside}</div>}
    {toast}
  </div>;
}

function TownCard({selected, anchor, stage, mine, canLike, onVisit, onHome, onLike, onClose}: {selected: {alias: string; town: TownPublic | null; liked: boolean | null}; anchor: [number, number];
  stage: RefObject<HTMLDivElement | null>; mine: boolean; canLike: boolean; onVisit: () => void; onHome?: () => void; onLike: () => void; onClose: () => void}) {
  const width = stage.current?.clientWidth ?? 800;
  const left = anchor[0] + 30 + 284 > width ? Math.max(8, anchor[0] - 30 - 284) : anchor[0] + 30;
  const top = Math.min(Math.max(70, anchor[1] - 110), (stage.current?.clientHeight ?? 600) - 300);
  const town = selected.town;
  const colour = townColour(selected.alias);
  return <div className="tt-glass tt-pop tt-pop-town" style={{left, top, borderColor: colour}} role="dialog" aria-label={`${selected.alias}'s town`}>
    <button type="button" className="tt-x" aria-label="Close" onClick={onClose}><CloseIcon size={16} /></button>
    <div className="tt-p-h"><div className="tt-tn" style={{background: `radial-gradient(circle at 40% 35%, #fff, ${colour})`}} aria-hidden="true">{selected.alias.slice(0, 1).toUpperCase()}</div>
      <div><b>{selected.alias}'s Town</b><span className="tt-mu">{town ? `Lv ${town.level} · ${town.plots.length} plots` : 'Loading…'}</span></div></div>
    {town && <>
      <div className="tt-st"><span>Buildings</span><span>{town.buildings.length}</span></div>
      {town.rarest && <div className="tt-st"><span>Rarest building</span><span className={`tt-rar ${BUILDINGS[town.rarest].rarity}`}>{BUILDINGS[town.rarest].name} · {BUILDINGS[town.rarest].rarity}</span></div>}
      <div className="tt-st"><span>Streak</span><span className="tt-with"><GlyphIcon id="flame" size={15} /> {town.streak}-day</span></div>
      <div className="tt-two">
        {mine && onHome ? <button type="button" className="tt-go" onClick={onHome}>Your town</button> : <button type="button" className="tt-go tt-violet" onClick={onVisit}>Visit town</button>}
        <button type="button" className={`tt-go tt-heart${selected.liked ? ' on' : ''}`} disabled={!canLike || mine || selected.liked === null} onClick={onLike}
          aria-pressed={selected.liked ?? false} aria-label={`${town.likes} likes${canLike && !mine ? ', like this town' : ''}`}><HeartIcon filled={!!selected.liked} /> {count(town.likes)}</button>
      </div>
    </>}
  </div>;
}
