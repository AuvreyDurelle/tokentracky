import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { BUILDINGS, terrainAt, type TownMapResponse, type TownPublic, type TownSelf } from '@tokentracky/core';
import type { TownApi } from './api.ts';
import { CostChips, Crest, useToast } from './Hud.tsx';
import { CloseIcon, GlyphIcon, HeartIcon, HomeIcon, MinusIcon, MoveIcon, PlusIcon } from './icons.tsx';
import { count, daysToAfford, paceText } from './format.ts';
import { plotKey } from './layout.ts';
import { cellAt, clampCell, fetchArea, screenOf, visibleArea, within, zoomAt, type Area, type MapView } from './map-view.ts';
import { townColour } from './pieces.ts';

const hash = (c: number, q: number) => ((Math.imul(c, 73856093) ^ Math.imul(q, 19349663)) >>> 0);

/** Draws the public map: terrain, every claimed plot in its town's colour, your land glowing, Wonders as stars, names, and mist past the frontier. */
function draw(canvas: HTMLCanvasElement, view: MapView, data: TownMapResponse | null, me: string | null, selected: string | null) {
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
  const owners = new Map<string, number>();
  for (const [x, y, town] of data?.plots ?? []) owners.set(plotKey(x, y), town);
  const towns = data?.towns ?? [];
  const mine = towns.findIndex(t => t.alias !== null && t.alias === me);
  const chosen = towns.findIndex(t => t.alias !== null && t.alias === selected);
  const edge = data?.edge ?? 0;
  const rect = (x: number, y: number, w: number, h: number) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, round); };
  // Ground and plots.
  for (let y = area.y0; y <= area.y1; y++) for (let x = area.x0; x <= area.x1; x++) {
    const [sx, sy] = screenOf(view, width, height, x, y);
    const town = owners.get(plotKey(x, y));
    if (town === undefined) {
      const terrain = terrainAt(x, y);
      if (terrain === 'water') {
        ctx.fillStyle = '#11204c'; ctx.fillRect(sx, sy, cell, cell);
        if (cell >= 14 && hash(x, y) % 4 === 0) { ctx.strokeStyle = 'rgba(95,128,208,.45)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(sx + cell * 0.2, sy + cell * 0.5); ctx.quadraticCurveTo(sx + cell * 0.35, sy + cell * 0.38, sx + cell * 0.5, sy + cell * 0.5); ctx.quadraticCurveTo(sx + cell * 0.65, sy + cell * 0.62, sx + cell * 0.8, sy + cell * 0.5); ctx.stroke(); }
        continue;
      }
      ctx.fillStyle = terrain === 'forest' ? '#10222c' : '#15183c';
      rect(sx + gap, sy + gap, cell - gap * 2, cell - gap * 2); ctx.fill();
      if (terrain === 'forest' && cell >= 12) {
        ctx.fillStyle = '#1d4436'; ctx.beginPath(); ctx.arc(sx + cell * 0.35, sy + cell * 0.42, cell * 0.19, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#265a42'; ctx.beginPath(); ctx.arc(sx + cell * 0.65, sy + cell * 0.62, cell * 0.23, 0, Math.PI * 2); ctx.fill();
      }
      continue;
    }
    const t = towns[town];
    const colour = town === mine ? '#ffe39a' : townColour(t?.alias ?? null);
    ctx.globalAlpha = town === mine ? 0.34 : town === chosen ? 0.24 : 0.13;
    ctx.fillStyle = colour;
    rect(sx + gap, sy + gap, cell - gap * 2, cell - gap * 2); ctx.fill();
    ctx.globalAlpha = 1;
    if (cell >= 12) {
      const lights = town === mine ? 3 : 1 + (hash(x, y) % 2);
      for (let i = 0; i < lights; i++) {
        const h = hash(x * 7 + i, y * 13 + i);
        ctx.fillStyle = town === mine ? '#fff6d6' : colour;
        ctx.beginPath(); ctx.arc(sx + cell * (0.25 + (h % 15) / 30), sy + cell * (0.25 + ((h >> 4) % 15) / 30), cell * (town === mine ? 0.07 : 0.05), 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  // Borders: each town's outline in its colour; yours glows.
  for (const pass of ['others', 'mine'] as const) {
    ctx.save();
    if (pass === 'mine') { ctx.shadowColor = '#ffd36b'; ctx.shadowBlur = 12; }
    for (const [x, y, town] of data?.plots ?? []) {
      if ((town === mine) !== (pass === 'mine')) continue;
      if (x < area.x0 - 1 || x > area.x1 + 1 || y < area.y0 - 1 || y > area.y1 + 1) continue;
      const [sx, sy] = screenOf(view, width, height, x, y);
      const same = (ax: number, ay: number) => owners.get(plotKey(ax, ay)) === town;
      const d = gap + 1;
      ctx.strokeStyle = town === mine ? '#ffe9b0' : townColour(towns[town]?.alias ?? null);
      ctx.lineWidth = town === mine ? 3 : town === chosen ? 2.6 : 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (!same(x, y - 1)) { ctx.moveTo(sx + d, sy + d); ctx.lineTo(sx + cell - d, sy + d); }
      if (!same(x, y + 1)) { ctx.moveTo(sx + d, sy + cell - d); ctx.lineTo(sx + cell - d, sy + cell - d); }
      if (!same(x - 1, y)) { ctx.moveTo(sx + d, sy + d); ctx.lineTo(sx + d, sy + cell - d); }
      if (!same(x + 1, y)) { ctx.moveTo(sx + cell - d, sy + d); ctx.lineTo(sx + cell - d, sy + cell - d); }
      ctx.stroke();
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
  // Mist past the frontier, where new and moving towns arrive.
  if (data) for (let y = area.y0; y <= area.y1; y++) for (let x = area.x0; x <= area.x1; x++) {
    const beyond = Math.max(Math.abs(x), Math.abs(y)) - (edge + 2);
    if (beyond <= 0) continue;
    const [sx, sy] = screenOf(view, width, height, x, y);
    ctx.fillStyle = `rgba(28,25,68,${Math.min(0.85, 0.25 + beyond * 0.12)})`;
    ctx.fillRect(sx, sy, cell + 0.5, cell + 0.5);
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
  const centres = new Map<number, [number, number, number]>();
  for (const [x, y, town] of data?.plots ?? []) { const c = centres.get(town) ?? [0, 0, 0]; centres.set(town, [c[0] + x + 0.5, c[1] + y + 0.5, c[2] + 1]); }
  const at = (town: number) => { const c = centres.get(town)!; return screenOf(view, width, height, c[0] / c[2], c[1] / c[2]); };
  // "You" sits just above your land so the land itself stays in view.
  if (mine >= 0 && centres.has(mine)) { const [x, y] = at(mine); label('You', x, y - Math.max(22, cell * 0.9), '#ffd36b', true); }
  const order = [...centres.keys()].filter(t => t !== mine && towns[t]?.alias).sort((a, b) => (b === chosen ? 1 : 0) - (a === chosen ? 1 : 0) || (towns[b]!.plots - towns[a]!.plots));
  for (const town of order) {
    const t = towns[town]!;
    if (town !== chosen && (cell < 10 || t.plots < (cell >= 22 ? 1 : 6))) continue;
    const [x, y] = at(town);
    label(`@${t.alias}${town === chosen ? ` · Lv ${t.level}` : ''}`, x, y, townColour(t.alias), false);
  }
}

/** The public map of every town, with your own town's dock when you have one. */
export function MapPage({api, signedIn, onHome, onVisit}: {api: TownApi; signedIn: boolean; onHome?: () => void; onVisit: (alias: string) => void}) {
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
  const drag = useRef<{x: number; y: number; view: MapView; moved: boolean} | null>(null);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setSize({width: el.clientWidth, height: el.clientHeight});
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    void api.me().then(town => { setMe(town); const [first] = town.plots; if (first) setView(v => ({...v, cx: first.x + 0.5, cy: first.y + 0.5})); }).catch(() => {});
  }, [api, signedIn]);
  // Fetch the plots around the view whenever it leaves what was fetched.
  useEffect(() => {
    if (!size.width) return;
    const visible = visibleArea(view, size.width, size.height);
    if (fetched && within(visible, fetched)) return;
    const area = fetchArea(view, size.width, size.height);
    const timer = window.setTimeout(() => {
      api.map(area).then(next => { setData(next); setFetched(area); setError(null); }).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)));
    }, fetched ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [api, view, size, fetched]);
  useEffect(() => { if (canvas.current && size.width) draw(canvas.current, view, data, me?.alias ?? null, selected?.alias ?? null); }, [view, data, me, selected, size]);

  const point = (event: {clientX: number; clientY: number}) => { const box = canvas.current!.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top] as const; };
  const open = useCallback((alias: string, at: [number, number]) => {
    setSelected({alias, town: null, liked: null, at});
    api.town(alias).then(town => setSelected(s => s?.alias === alias ? {...s, town} : s)).catch(failure => { setSelected(null); say(failure instanceof Error ? failure.message : String(failure)); });
    if (api.liked && signedIn && alias !== me?.alias) api.liked(alias).then(liked => setSelected(s => s?.alias === alias ? {...s, liked} : s)).catch(() => {});
  }, [api, signedIn, me, say]);
  const click = (px: number, py: number) => {
    const [x, y] = cellAt(view, size.width, size.height, px, py);
    const hit = data?.plots.find(p => p[0] === x && p[1] === y);
    const alias = hit ? data!.towns[hit[2]]?.alias : null;
    if (alias) open(alias, [x + 0.5, y + 0.5]); else setSelected(null);
  };
  const zoom = (factor: number) => setView(v => zoomAt(v, factor, size.width, size.height, size.width / 2, size.height / 2));
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
  const short = me ? Math.max(0, price - me.wallet.bricks) : 0;

  return <div ref={stage} className="tt tt-stage tt-map">
    <canvas ref={canvas} className="tt-canvas" role="img" aria-label="The public map of every town"
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = {x: event.clientX, y: event.clientY, view, moved: false}; }}
      onPointerMove={event => {
        const d = drag.current;
        if (!d) return;
        const dx = event.clientX - d.x, dy = event.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
        if (d.moved) setView({...d.view, cx: d.view.cx - dx / d.view.cell, cy: d.view.cy - dy / d.view.cell});
      }}
      onPointerUp={event => { const d = drag.current; drag.current = null; if (d && !d.moved) { const [px, py] = point(event); click(px, py); } }}
      onWheel={event => { const [px, py] = point(event); setView(v => zoomAt(v, Math.exp(-event.deltaY * 0.0015), size.width, size.height, px, py)); }} />
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
      {me && <button type="button" aria-label="Show your town" onClick={() => { const [first] = me.plots; if (first) setView(v => ({...v, cx: first.x + 0.5, cy: first.y + 0.5, cell: clampCell(Math.max(v.cell, 26), size.width, size.height)})); }}><HomeIcon size={18} /></button>}
    </div>
    {error && <div className="tt-glass tt-banner" role="alert">{error}</div>}
    {selected && anchor && <TownCard selected={selected} anchor={anchor} stage={stage} mine={selected.alias === me?.alias} canLike={!!api.like && signedIn}
      onVisit={() => onVisit(selected.alias)} onHome={onHome} onLike={() => void like()} onClose={() => setSelected(null)} />}
    {(onHome || me) && <div className="tt-glass tt-dock tt-dock-map">
      {onHome && <button type="button" className="tt-db" onClick={onHome}><HomeIcon />Your town</button>}
      {me && <div className="tt-cl"><div className="tt-kv"><span>Next plot #{me.nextPlot.number}</span><b><CostChips cost={me.nextPlot.cost} /></b></div>
        <div className="tt-pb"><i style={{width: `${Math.min(100, price ? me.wallet.bricks / price * 100 : 100)}%`}} /></div>
        <div className="tt-kv tt-mu"><span>{count(me.wallet.bricks)} of {count(price)}</span>{short > 0 ? <span className="tt-sh">{paceText(daysToAfford(short, me.bricksPerDay)) ?? `${count(short)} short`}</span> : <span className="tt-ok">Ready</span>}</div></div>}
      {me && <div className="tt-cl"><div className="tt-kv"><span className="tt-with"><MoveIcon size={18} />Move town</span><b><CostChips cost={me.move.cost} /></b></div>
        <div className="tt-mu">Moves in your town</div></div>}
    </div>}
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
