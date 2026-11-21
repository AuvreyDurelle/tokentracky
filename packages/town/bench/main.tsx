// The real town screens against a fake API, for drive.mjs. Query flags:
//   page=map       the public map instead of your town
//   side=N         a town of N×N plots (default 6)
//   noharvest      nothing waiting to collect
//   select=N       click the Nth plot once the town shows
//   zoom=out       start the map zoomed right out
//   slow=MS        the fake server takes this long to answer an action
//   nowebgl        a browser without WebGL, to see the flat drawing
//   empty=N        leave the last N plots without a building
//   notwinkle, nobob, noblur, nofilter  switch an effect off, to see what it costs
import { createRoot } from 'react-dom/client';
import { BUILDING_IDS, terrainAt, type BuildingId, type TownMapResponse, type TownSelf } from '@tokentracky/core';
import { MapPage, TownPage, type TownApi } from '../src/index.ts';

const q = new URLSearchParams(location.search);
const side = Number(q.get('side') ?? 6);
const off: Record<string, string> = {
  notwinkle: '.tt-stars i{animation:none!important}',
  noblur: '.tt-glass{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
  nobob: '.tt-bubble{animation:none!important}',
  nofilter: '[filter]{filter:none!important}',
};
const style = document.createElement('style');
style.textContent = Object.keys(off).filter(flag => q.has(flag)).map(flag => off[flag]).join('\n');
document.head.append(style);

if (q.has('nowebgl')) {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    return kind.startsWith('webgl') ? null : (real as (...a: unknown[]) => unknown).call(this, kind, ...rest);
  } as typeof real;
}

const plots: Array<{x: number; y: number}> = [];
for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) plots.push({x: x + 10, y: y + 10});
const res = (n: number) => ({power: n, bricks: n, water: n, crystals: n});
const town: TownSelf = {
  alias: 'bench', level: 6, wallet: res(9000), caps: res(10000),
  harvest: {resources: res(q.has('noharvest') ? 0 : 400), tokens: 4e6, since: new Date(Date.now() - 3600e3).toISOString(), streak: 5, multiplier: 1.2},
  bonuses: res(10), plots,
  buildings: plots.slice(0, plots.length - Number(q.get('empty') ?? 0)).map((p, i) => ({id: `b${i}`, kind: BUILDING_IDS[i % BUILDING_IDS.length] as BuildingId, x: p.x, y: p.y, level: 1 + (i % 15),
    next: {cost: {bricks: 500}, effects: [{label: 'Power', from: 10, to: 20, unit: 'percent'}], blocked: null}})),
  nextPlot: {number: plots.length + 1, cost: {bricks: 4000}}, move: {cost: {bricks: 2000}}, bricksPerDay: 800, rates: res(4e5), trade: {rate: 3},
  catalogue: BUILDING_IDS.map(kind => ({kind, description: 'A building.', cost: {bricks: 800}, owned: 1, limit: null, locked: null})), paused: null, now: new Date().toISOString(),
};
const mapOf = (a: {x0: number; y0: number; x1: number; y1: number}): TownMapResponse => {
  const out: Array<[number, number, number]> = [];
  for (let x = a.x0; x <= a.x1; x++) for (let y = a.y0; y <= a.y1; y++) {
    if (x >= 10 && x < 10 + side && y >= 10 && y < 10 + side) { out.push([x, y, 0]); continue; }
    if (terrainAt(x, y) !== 'water' && (Math.imul(x, 7919) ^ Math.imul(y, 104729)) % 7 < 3) out.push([x, y, 1 + Math.abs(Math.floor(x / 6) * 31 + Math.floor(y / 6)) % 300]);
  }
  return {...a, plots: out, wonders: [[3, 3], [-20, 14]], edge: 70, featured: null, totals: {towns: 301, plots: out.length},
    towns: Array.from({length: 301}, (_, i) => ({alias: i ? `t${i}` : 'bench', level: 3, plots: 8 + (i % 30), wonder: false}))};
};
const later = <T,>(value: T, ms = 30) => new Promise<T>(done => setTimeout(() => done(structuredClone(value)), ms));
const act = () => later(town, Number(q.get('slow') ?? 30));
// Actions change the fake town as the hosted rules would, near enough to see what each one shows.
const change = (apply: () => void) => { apply(); return act(); };
const api: TownApi = {
  me: () => later(town), move: act, trade: act, map: area => later(mapOf(area)),
  collect: () => change(() => { town.wallet = res(Math.min(10000, town.wallet.power + 400)); town.harvest = {...town.harvest, resources: res(0), tokens: 0}; }),
  claim: (x, y) => change(() => { town.plots = [...town.plots, {x, y}]; town.nextPlot = {...town.nextPlot, number: town.nextPlot.number + 1}; }),
  build: (kind, x, y) => change(() => { town.buildings = [...town.buildings, {...town.buildings[0]!, id: `b${town.buildings.length}`, kind, x, y, level: 1}]; }),
  upgrade: id => change(() => { town.buildings = town.buildings.map(b => b.id === id ? {...b, level: Math.min(15, b.level + 1)} : b); }),
  town: alias => later({alias, level: 3, plots, buildings: town.buildings, rarest: null, likes: 2, streak: 3}),
};

const root = document.getElementById('root')!;
root.style.height = '100vh';
createRoot(root).render(q.get('page') === 'map'
  ? <MapPage api={api} signedIn onVisit={() => {}} onHome={() => {}} />
  : <TownPage api={api} onMap={() => {}} />);

const until = (find: () => Element | null | undefined) => new Promise<Element>(done => { const look = () => { const el = find(); if (el) done(el); else setTimeout(look, 50); }; look(); });
const select = q.get('select');
if (select !== null) void until(() => document.querySelectorAll('.tt-hit')[Number(select)]).then(el => el.dispatchEvent(new MouseEvent('click', {bubbles: true})));
if (q.get('zoom') === 'out') void until(() => document.querySelector('.tt-canvas')).then(canvas => {
  for (let i = 0; i < 12; i++) canvas.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 400, deltaMode: 1, clientX: 720, clientY: 450}));
});
