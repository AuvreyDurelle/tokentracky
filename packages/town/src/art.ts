import type { BuildingId } from '@tokentracky/core';

/**
 * The Twilight town's drawings, as SVG markup. Every function takes numbers and fixed colours only, never names or other
 * text a member typed, so the markup is safe to place into the scene as it is.
 */
export type Pt = [number, number];
export type Project = (x: number, y: number, z?: number) => Pt;

/** Tile size on screen: a tile is 64 wide and 32 tall; a plot is 2×2 tiles. */
export const TILE_W = 64;
export const TILE_H = 32;
export const isoProjection = (ox: number, oy: number): Project => (x, y, z = 0) => [ox + (x - y) * TILE_W / 2, oy + (x + y) * TILE_H / 2 - z];

export const r = (n: number) => Math.round(n * 10) / 10;
/** Lightens (k > 0) or darkens (k < 0) a `#rrggbb` colour. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16), t = k < 0 ? 0 : 255, a = Math.abs(k), m = (v: number) => Math.round(v + (t - v) * a);
  return '#' + ((1 << 24) | (m(n >> 16) << 16) | (m((n >> 8) & 255) << 8) | m(n & 255)).toString(16).slice(1);
}
export const hash = (c: number, q: number) => ((Math.imul(c, 73856093) ^ Math.imul(q, 19349663)) >>> 0);
export const GLOW = 'filter="url(#tt-gl)"';
export const circle = (x: number, y: number, radius: number, fill: string, extra = '') => `<circle cx="${r(x)}" cy="${r(y)}" r="${radius}" fill="${fill}" ${extra}/>`;
export const spark = (x: number, y: number, size: number, fill = '#fff', opacity = 0.9) =>
  `<polygon points="${[0, 1, 2, 3, 4, 5, 6, 7].map(i => { const a = i * Math.PI / 4, q = i % 2 ? size * 0.31 : size; return r(x + q * Math.sin(a)) + ',' + r(y - q * Math.cos(a)); }).join(' ')}" fill="${fill}" opacity="${opacity}"/>`;
export const star = (x: number, y: number, size: number, fill: string) => {
  const p: string[] = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? size * 0.45 : size; p.push(r(x + q * Math.cos(a)) + ',' + r(y + q * Math.sin(a))); }
  return `<polygon points="${p.join(' ')}" fill="${fill}"/>`;
};

/** The resource and streak glyphs, drawn in a 24×24 box. */
export const GLYPHS = {
  power: '<path d="M13.5 2 4.5 13.5h6L9 22l10-12.5h-6.2L13.5 2Z" fill="#ffd23f" stroke="#b8860b" stroke-width="1.2" stroke-linejoin="round"/>',
  bricks: '<rect x="2.5" y="6" width="19" height="12" rx="2" fill="#e0784a" stroke="#9c4524" stroke-width="1.2"/><path d="M2.5 12h19M9 6v6M15 12v6" stroke="#9c4524" stroke-width="1.2"/>',
  water: '<path d="M12 2.5S5 10.4 5 15a7 7 0 0 0 14 0c0-4.6-7-12.5-7-12.5Z" fill="#4cc3f0" stroke="#1f7fa8" stroke-width="1.2"/><path d="M9 15.5a3 3 0 0 0 3 3" stroke="#d8f4ff" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  crystals: '<path d="M6.5 3.5h11l4 5.5L12 21 2.5 9l4-5.5Z" fill="#b18cff" stroke="#6b45c9" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.5 9h19M9 3.5 12 21l3-17.5" stroke="#6b45c9" stroke-width="1" fill="none"/>',
  flame: '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-6 1-9Z" fill="#ff8a3d" stroke="#c4501a" stroke-width="1.1"/><path d="M12 12c2 2 3 3 3 5a3 3 0 0 1-6 0c0-1.5 1-2.5 3-5Z" fill="#ffd23f"/>',
} as const;
export type Glyph = keyof typeof GLYPHS;

/** Gradients, filters and glyphs every scene shares; ids start with `tt-`. */
export const SCENE_DEFS = `${Object.entries(GLYPHS).map(([id, body]) => `<symbol id="tt-${id}" viewBox="0 0 24 24">${body}</symbol>`).join('')}
<linearGradient id="tt-beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffe0a0" stop-opacity=".6"/><stop offset=".6" stop-color="#ffd890" stop-opacity=".14"/><stop offset="1" stop-color="#ffd890" stop-opacity="0"/></linearGradient>
<radialGradient id="tt-bub" cx=".38" cy=".32"><stop offset="0" stop-color="#fff" stop-opacity=".4"/><stop offset=".55" stop-color="#9c98ff" stop-opacity=".16"/><stop offset="1" stop-color="#151338" stop-opacity=".75"/></radialGradient>
${[['halo', '#ffd9b0', 0.55], ['hz', '#ff9a7a', 0.38], ['lamp', '#ffc770', 0.6], ['red', '#ff5a4a', 0.75], ['wht', '#e4ecff', 0.7], ['cyan', '#7fe3ff', 0.6]].map(([id, c, o]) =>
    `<radialGradient id="tt-${id}"><stop offset="0" stop-color="${c}" stop-opacity="${o}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('')}
<filter id="tt-gl" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="tt-mg" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

/** Roughly how tall each drawing stands, for placing badges and harvest bubbles above it. */
export const BUILDING_HEIGHT: Record<BuildingId, number> = {'town-hall': 96, 'power-plant': 100, brickworks: 70, reservoir: 104, observatory: 60, 'data-center': 52, vault: 50,
  market: 40, workshop: 44, park: 30, tavern: 70, arena: 42, statue: 56, museum: 42, 'token-tower': 196};

/** Drawing helpers bound to one scene's projection. `defs` collects the cylinder gradients the drawings ask for. */
export function createArt(P: Project, prefix: string) {
  let defs = '';
  let gradients = 0;
  const grad = (c: string) => {
    const id = `${prefix}g${gradients++}`;
    defs += `<linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${shade(c, 0.12)}"/><stop offset=".5" stop-color="${c}"/><stop offset="1" stop-color="${shade(c, -0.4)}"/></linearGradient>`;
    return id;
  };
  const pts = (a: Pt[]) => a.map(p => r(p[0]) + ',' + r(p[1])).join(' ');
  const poly = (a: Pt[], c: string, e = '') => `<polygon points="${pts(a)}" fill="${c}" ${e}/>`;
  const line = (a: Pt, b: Pt, c: string, w: number, e = '') => `<line x1="${r(a[0])}" y1="${r(a[1])}" x2="${r(b[0])}" y2="${r(b[1])}" stroke="${c}" stroke-width="${w}" stroke-linecap="round" ${e}/>`;
  const dot = (p: Pt, radius: number, c: string) => circle(p[0], p[1], radius, c, GLOW);
  const halo = (p: Pt, radius: number, g = 'lamp') => circle(p[0], p[1], radius, `url(#tt-${g})`);
  const sq = (x: number, y: number, w: number, d: number, z = 0): Pt[] => [P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z)];
  const fq = (x: number, yF: number, w: number, z: number, h: number, c: string, e = '') => poly([P(x, yF, z), P(x + w, yF, z), P(x + w, yF, z + h), P(x, yF, z + h)], c, e);
  const rq = (xF: number, y: number, w: number, z: number, h: number, c: string, e = '') => poly([P(xF, y, z), P(xF, y + w, z), P(xF, y + w, z + h), P(xF, y, z + h)], c, e);
  const box = (x: number, y: number, w: number, d: number, h: number, c: string, z = 0) => fq(x, y + d, w, z, h, shade(c, -0.08)) + rq(x + w, y, d, z, h, shade(c, -0.3)) + poly(sq(x, y, w, d, z + h), shade(c, 0.1));
  // Lit windows follow a fixed pattern per building, so a town looks the same on every visit.
  let windows = 1;
  const lit = () => hash(windows++, 9) % 5 > 0;
  const glass = (on: boolean): [string, string] => [on ? '#ffd27a' : '#2c3058', on ? GLOW : ''];
  const winL = (x: number, yF: number, z: number, w = 0.2, h = 8) => fq(x, yF, w, z, h, ...glass(lit()));
  const winR = (xF: number, y: number, z: number, w = 0.2, h = 8) => rq(xF, y, w, z, h, ...glass(lit()));
  const door = (x: number, yF: number, w: number, h: number) => fq(x, yF, w, 0, h, '#ffbf66', GLOW);
  const gableX = (x: number, y: number, w: number, d: number, z: number, rh: number, roof: string, wall: string) => {
    const m = y + d / 2;
    return poly([P(x, y, z), P(x + w, y, z), P(x + w, m, z + rh), P(x, m, z + rh)], shade(roof, 0.12)) + poly([P(x + w, y, z), P(x + w, y + d, z), P(x + w, m, z + rh)], shade(wall, -0.3))
      + poly([P(x, y + d, z), P(x + w, y + d, z), P(x + w, m, z + rh), P(x, m, z + rh)], roof);
  };
  const gableY = (x: number, y: number, w: number, d: number, z: number, rh: number, roof: string, wall: string) => {
    const m = x + w / 2;
    return poly([P(x, y, z), P(x, y + d, z), P(m, y + d, z + rh), P(m, y, z + rh)], shade(roof, 0.12)) + poly([P(x + w, y, z), P(x + w, y + d, z), P(m, y + d, z + rh), P(m, y, z + rh)], shade(roof, -0.3))
      + poly([P(x, y + d, z), P(x + w, y + d, z), P(m, y + d, z + rh)], shade(wall, -0.08));
  };
  const pyr = (x: number, y: number, w: number, d: number, z: number, rh: number, c: string) => {
    const A = P(x + w / 2, y + d / 2, z + rh);
    return poly([P(x, y, z), P(x, y + d, z), A], shade(c, 0.1)) + poly([P(x, y + d, z), P(x + w, y + d, z), A], c) + poly([P(x + w, y, z), P(x + w, y + d, z), A], shade(c, -0.3));
  };
  const RX = (q: number) => q * TILE_W / 2 * 1.414, RY = (q: number) => q * TILE_H / 2 * 1.414;
  const cyl = (cx: number, cy: number, q: number, z0: number, h: number, c: string) => {
    const b = P(cx, cy, z0), t = P(cx, cy, z0 + h), rx = RX(q), ry = RY(q), id = grad(c);
    return `<path d="M${r(b[0] - rx)},${r(t[1])}V${r(b[1])}A${r(rx)},${r(ry)} 0 0 0 ${r(b[0] + rx)},${r(b[1])}V${r(t[1])}Z" fill="url(#${id})"/><ellipse cx="${r(t[0])}" cy="${r(t[1])}" rx="${r(rx)}" ry="${r(ry)}" fill="${shade(c, 0.15)}"/>`;
  };
  const tree = (x: number, y: number, s: number, pine = false) => {
    const c = P(x + 0.5, y + 0.5);
    let o = `<ellipse cx="${r(c[0] + 3)}" cy="${r(c[1])}" rx="${r(13 * s)}" ry="${r(6 * s)}" fill="rgba(0,0,20,.3)"/><rect x="${r(c[0] - 2)}" y="${r(c[1] - 12 * s)}" width="4" height="${r(12 * s)}" fill="#3e2f3c"/>`;
    if (pine) o += `<polygon points="${r(c[0])},${r(c[1] - 46 * s)} ${r(c[0] + 13 * s)},${r(c[1] - 10 * s)} ${r(c[0] - 13 * s)},${r(c[1] - 10 * s)}" fill="#163a33"/><polygon points="${r(c[0])},${r(c[1] - 46 * s)} ${r(c[0])},${r(c[1] - 10 * s)} ${r(c[0] - 13 * s)},${r(c[1] - 10 * s)}" fill="#22553f"/>`;
    else o += `<circle cx="${r(c[0])}" cy="${r(c[1] - 22 * s)}" r="${r(13 * s)}" fill="#1c473a"/><circle cx="${r(c[0] - 4 * s)}" cy="${r(c[1] - 26 * s)}" r="${r(7 * s)}" fill="#2d6650"/>`;
    return o;
  };
  const smoke = (p: Pt) => `<g fill="#b9b2e8" opacity=".22"><circle cx="${r(p[0] + 2)}" cy="${r(p[1] - 6)}" r="6"/><circle cx="${r(p[0] + 9)}" cy="${r(p[1] - 16)}" r="9"/><circle cx="${r(p[0] + 19)}" cy="${r(p[1] - 29)}" r="11"/></g>`;
  const lamp = (x: number, y: number) => { const b = P(x, y), t = P(x, y, 26); return line(b, t, '#24213c', 2.4) + halo(t, 20) + dot(t, 3, '#fff1c4'); };

  // Each drawing fills the 2×2 plot whose back corner is (ox, oy).
  const B: Record<BuildingId, (ox: number, oy: number) => string> = {
    'power-plant'(ox, oy) {
      const h = 34, a = h - 11;
      let s = box(ox + 0.2, oy + 0.2, 1.6, 1.6, h, '#646a96');
      s += fq(ox + 0.2, oy + 1.8, 1.6, a, 5, '#ffd04a', GLOW) + rq(ox + 1.8, oy + 0.2, 1.6, a, 5, '#e9ae30', GLOW);
      s += door(ox + 0.4, oy + 1.8, 0.45, 14);
      for (const y of [0.45, 0.95, 1.4]) s += winR(ox + 1.8, oy + y, 9, 0.25, 8);
      const c = P(ox + 1.3, oy + 1.8, 7);
      s += `<use href="#tt-power" x="${r(c[0] - 8)}" y="${r(c[1] - 16)}" width="16" height="16"/>`;
      for (const [cx, ht] of [[0.6, 58], [1.3, 44]] as const) s += cyl(ox + cx, oy + 0.55, 0.17, h, ht, '#575c84') + dot(P(ox + cx, oy + 0.55, h + ht + 4), 2, '#ff5a4a');
      return s + smoke(P(ox + 0.6, oy + 0.55, h + 62));
    },
    workshop(ox, oy) {
      const w = '#827a9e';
      let s = box(ox + 0.35, oy + 0.35, 1.3, 1.3, 24, w) + door(ox + 0.85, oy + 1.65, 0.3, 14);
      s += winL(ox + 0.5, oy + 1.65, 8, 0.22, 8) + winL(ox + 1.3, oy + 1.65, 8, 0.22, 8) + winR(ox + 1.65, oy + 0.6, 8, 0.22, 8) + winR(ox + 1.65, oy + 1.1, 8, 0.22, 8);
      s += gableY(ox + 0.3, oy + 0.3, 1.4, 1.4, 24, 18, '#b4573a', w);
      const g = P(ox + 1, oy + 1.66, 36);
      return s + `<circle cx="${r(g[0])}" cy="${r(g[1])}" r="5" fill="none" stroke="#ffd27a" stroke-width="2.5" stroke-dasharray="2.5 1.8" ${GLOW}/>`;
    },
    reservoir(ox, oy) {
      let s = '';
      for (const [a, b] of [[0.45, 0.45], [1.43, 0.45], [0.45, 1.43], [1.43, 1.43]] as const) s += box(ox + a, oy + b, 0.12, 0.12, 50, '#4c5076');
      s += cyl(ox + 1, oy + 1, 0.72, 50, 34, '#2f72a8');
      const t = P(ox + 1, oy + 1, 84), ap = P(ox + 1, oy + 1, 102), rx = RX(0.72), f = P(ox + 1, oy + 1, 50);
      s += `<rect x="${r(f[0] - 4)}" y="${r(f[1] + RY(0.72) - 36)}" width="8" height="34" rx="3" fill="#162a50"/><rect x="${r(f[0] - 3)}" y="${r(f[1] + RY(0.72) - 26)}" width="6" height="24" rx="2" fill="#7fe3ff" ${GLOW}/>`;
      s += `<polygon points="${r(t[0] - rx - 3)},${r(t[1])} ${r(ap[0])},${r(ap[1])} ${r(t[0] + rx + 3)},${r(t[1])}" fill="#1d4d7a"/>`;
      return s + halo([ap[0], ap[1] - 4], 18, 'cyan') + dot([ap[0], ap[1] - 4], 3, '#7fe3ff');
    },
    brickworks(ox, oy) {
      let s = box(ox + 0.2, oy + 0.2, 1.6, 1.6, 28, '#8c4c40');
      for (const x of [0.4, 0.8, 1.25]) s += winL(ox + x, oy + 1.8, 9, 0.18, 9);
      s += gableX(ox + 0.2, oy + 0.2, 1.6, 1.6, 28, 16, '#5e2f2b', '#8c4c40');
      s += cyl(ox + 1.45, oy + 0.55, 0.14, 36, 30, '#6b3a32');
      const a = P(ox + 0.4, oy + 1.8, 30);
      return s + smoke(P(ox + 1.45, oy + 0.55, 70)) + halo(a, 16) + dot(a, 2.6, '#ffb02e');
    },
    'town-hall'(ox, oy) {
      const W = '#8c86ad';
      let s = box(ox + 0.15, oy + 0.15, 1.7, 1.7, 36, W);
      for (const x of [0.3, 0.6, 1.25, 1.55]) for (const z of [8, 22]) s += winL(ox + x, oy + 1.85, z, 0.18, 9);
      s += door(ox + 0.85, oy + 1.85, 0.3, 18);
      for (const y of [0.3, 0.65, 1, 1.35]) for (const z of [8, 22]) s += winR(ox + 1.85, oy + y, z, 0.18, 9);
      s += box(ox + 0.5, oy + 0.5, 1, 1, 16, shade(W, -0.04), 36) + pyr(ox + 0.5, oy + 0.5, 1, 1, 52, 24, '#4c50b8');
      const ck = P(ox + 1, oy + 1.5, 44);
      s += `<circle cx="${r(ck[0])}" cy="${r(ck[1])}" r="5" fill="#fff4d0" stroke="#4c50b8" stroke-width="1.5" ${GLOW}/>`;
      const ap = P(ox + 1, oy + 1, 76);
      return s + line(ap, [ap[0], ap[1] - 20], '#9a96c0', 1.5) + `<polygon points="${r(ap[0])},${r(ap[1] - 20)} ${r(ap[0] + 15)},${r(ap[1] - 16)} ${r(ap[0])},${r(ap[1] - 12)}" fill="#ffc23d"/>`;
    },
    observatory(ox, oy) {
      let s = box(ox + 0.2, oy + 0.2, 1.6, 1.6, 28, '#7a73a6');
      for (const x of [0.45, 0.85, 1.25]) s += winL(ox + x, oy + 1.8, 9, 0.22, 9);
      for (const y of [0.45, 0.85, 1.25]) s += winR(ox + 1.8, oy + y, 9, 0.22, 9);
      const b = P(ox + 1, oy + 1, 28), rx = RX(0.66), ry = RY(0.66), id = grad('#6a55d0');
      s += `<path d="M${r(b[0] - rx)},${r(b[1])}A${r(rx)},30 0 0 1 ${r(b[0] + rx)},${r(b[1])}A${r(rx)},${r(ry)} 0 0 1 ${r(b[0] - rx)},${r(b[1])}Z" fill="url(#${id})"/>`;
      return s + `<polygon points="${r(b[0] - 4)},${r(b[1] + ry - 3)} ${r(b[0] + 4)},${r(b[1] + ry - 3)} ${r(b[0] + 3)},${r(b[1] - 24)} ${r(b[0] - 3)},${r(b[1] - 24)}" fill="#a8f0ff" ${GLOW}/>` + line([b[0] + 2, b[1] - 18], [b[0] + 22, b[1] - 34], '#cfd2ee', 6);
    },
    'data-center'(ox, oy) {
      let s = box(ox + 0.15, oy + 0.3, 1.7, 1.4, 26, '#5a6188');
      const L = ['#4cc3f0', '#36d68a', '#9a92ff', '#ffd23f'];
      let i = 0;
      for (let x = 0.3; x < 1.75; x += 0.18) for (const z of [7, 15]) s += fq(ox + x, oy + 1.7, 0.09, z, 3, L[i++ % 4]!, GLOW);
      for (let y = 0.45; y < 1.6; y += 0.18) s += rq(ox + 1.85, oy + y, 0.09, 11, 3, L[i++ % 4]!, GLOW);
      s += box(ox + 0.35, oy + 0.5, 0.4, 0.4, 9, '#474d70', 26) + box(ox + 0.95, oy + 0.5, 0.4, 0.4, 9, '#474d70', 26) + box(ox + 1.45, oy + 0.95, 0.25, 0.6, 6, '#3f4466', 26);
      const a = P(ox + 0.55, oy + 0.7, 35);
      return s + line(a, [a[0], a[1] - 16], '#9a96c0', 1.5) + dot([a[0], a[1] - 17], 2.5, '#ff5a4a');
    },
    vault(ox, oy) {
      let s = box(ox + 0.3, oy + 0.3, 1.4, 1.4, 30, '#7d7697');
      for (const x of [0.4, 0.7, 1.22, 1.52]) s += fq(ox + x, oy + 1.7, 0.08, 0, 30, '#a59fc4');
      s += fq(ox + 0.85, oy + 1.7, 0.3, 0, 20, '#e0a82a', GLOW);
      const d = P(ox + 1, oy + 1.7, 10);
      s += `<circle cx="${r(d[0])}" cy="${r(d[1])}" r="4" fill="#fff3c4" stroke="#9a6d10" stroke-width="1.2"/>`;
      return s + box(ox + 0.25, oy + 0.25, 1.5, 1.5, 5, '#6a5f8c', 30) + pyr(ox + 0.5, oy + 0.5, 1, 1, 35, 14, '#c9a54a');
    },
    market(ox, oy) {
      let s = box(ox + 0.15, oy + 0.15, 1.7, 1.7, 4, '#4c4870') + box(ox + 0.35, oy + 0.35, 1.3, 1.3, 18, '#827a9e', 4);
      const z = 22, m = oy + 1, rh = 14;
      for (let i = 0; i < 5; i++) { const x0 = ox + 0.3 + i * 0.28; s += poly([P(x0, oy + 0.3, z), P(x0 + 0.28, oy + 0.3, z), P(x0 + 0.28, m, z + rh), P(x0, m, z + rh)], shade(i % 2 ? '#e8e0f0' : '#c8463e', 0.1)); }
      s += poly([P(ox + 1.7, oy + 0.3, z), P(ox + 1.7, oy + 1.7, z), P(ox + 1.7, m, z + rh)], '#5a5679');
      for (let i = 0; i < 5; i++) { const x0 = ox + 0.3 + i * 0.28; s += poly([P(x0, oy + 1.7, z), P(x0 + 0.28, oy + 1.7, z), P(x0 + 0.28, m, z + rh), P(x0, m, z + rh)], i % 2 ? '#e8e0f0' : '#c8463e'); }
      s += box(ox + 1.45, oy + 1.72, 0.18, 0.18, 7, '#8a5a3a', 4) + box(ox + 1.18, oy + 1.75, 0.18, 0.18, 6, '#9a6a42', 4);
      const c = P(ox + 0.6, oy + 1.7, 12);
      return s + halo(c, 16) + `<circle cx="${r(c[0])}" cy="${r(c[1])}" r="5.5" fill="#ffc23d" stroke="#9a6d10" stroke-width="1.2" ${GLOW}/>`;
    },
    park(ox, oy) {
      let s = poly(sq(ox + 0.15, oy + 0.15, 1.7, 1.7), '#2c5a42');
      s += line(P(ox + 0.15, oy + 1), P(ox + 1.85, oy + 1), '#5d5a7c', 5) + line(P(ox + 1, oy + 0.15), P(ox + 1, oy + 1.85), '#5d5a7c', 5);
      s += tree(ox - 0.05, oy - 0.05, 0.75) + tree(ox + 0.95, oy - 0.05, 0.7, true) + tree(ox - 0.05, oy + 0.95, 0.7, true) + cyl(ox + 1, oy + 1, 0.32, 0, 7, '#6a6890');
      const t = P(ox + 1, oy + 1, 7);
      s += `<ellipse cx="${r(t[0])}" cy="${r(t[1])}" rx="${r(RX(0.24))}" ry="${r(RY(0.24))}" fill="#4cc3f0" ${GLOW}/>` + line(t, [t[0], t[1] - 16], '#bfeaf8', 2.5) + `<circle cx="${r(t[0])}" cy="${r(t[1] - 17)}" r="3" fill="#dff6ff"/>`;
      return s + lamp(ox + 1.7, oy + 0.3) + tree(ox + 1.15, oy + 1.15, 0.65);
    },
    tavern(ox, oy) {
      let s = box(ox + 0.3, oy + 0.3, 1.4, 1.4, 24, '#6a5a8c');
      for (const x of [0.45, 1.2]) s += fq(ox + x, oy + 1.7, 0.25, 8, 9, '#ffd27a', GLOW);
      for (const y of [0.55, 1.15]) s += rq(ox + 1.7, oy + y, 0.25, 8, 9, '#f5c451', GLOW);
      s += fq(ox + 0.82, oy + 1.7, 0.26, 0, 15, '#3a2c5a');
      const lp = P(ox + 0.95, oy + 1.7, 20);
      s += halo(lp, 14);
      s += gableX(ox + 0.25, oy + 0.25, 1.5, 1.5, 24, 18, '#2d2550', '#6a5a8c') + box(ox + 0.5, oy + 0.45, 0.18, 0.18, 22, '#5a4a7a', 24);
      const m = P(ox + 1.5, oy + 0.4, 66);
      return s + `<path d="M${r(m[0])},${r(m[1] - 10)}a10,10 0 1,0 0,20a7.5,7.5 0 1,1 0,-20z" fill="#ffe9a8" ${GLOW}/>`;
    },
    arena(ox, oy) {
      const b = P(ox + 1, oy + 1, 0), t = P(ox + 1, oy + 1, 22), rx = RX(0.85), ry = RY(0.85);
      let s = cyl(ox + 1, oy + 1, 0.85, 0, 22, '#7a73a6');
      for (const a of [-0.7, -0.35, 0, 0.35, 0.7]) { const x = b[0] + a * rx, y = b[1] + Math.sqrt(1 - a * a) * ry; s += `<rect x="${r(x - 4)}" y="${r(y - 17)}" width="8" height="11" rx="4" fill="#ffd27a" ${GLOW}/>`; }
      s += `<ellipse cx="${r(t[0])}" cy="${r(t[1] + 2)}" rx="${r(rx * 0.78)}" ry="${r(ry * 0.78)}" fill="#2c5a42" stroke="#b9b0dc" stroke-width="3"/>`;
      for (const a of [-1, 0, 1]) { const x = t[0] + a * rx * 0.92, y = t[1] - (a === 0 ? ry * 0.92 : 0); s += line([x, y], [x, y - 18], '#9a96c0', 1.5) + `<polygon points="${r(x)},${r(y - 18)} ${r(x + 11)},${r(y - 15)} ${r(x)},${r(y - 12)}" fill="${a ? '#ff6b5b' : '#ffc23d'}"/>`; }
      return s;
    },
    statue(ox, oy) {
      let s = poly(sq(ox + 0.35, oy + 0.35, 1.3, 1.3), '#4a4668') + tree(ox - 0.05, oy - 0.05, 0.6) + tree(ox + 1.05, oy - 0.1, 0.55, true);
      s += box(ox + 0.7, oy + 0.7, 0.6, 0.6, 16, '#7d7697') + cyl(ox + 1, oy + 1, 0.13, 16, 22, '#d9b44a');
      const h = P(ox + 1, oy + 1, 44);
      return s + halo(h, 22) + `<circle cx="${r(h[0])}" cy="${r(h[1])}" r="6" fill="#e8c55a"/>` + line([h[0] + 3, h[1] + 6], [h[0] + 13, h[1] - 8], '#d9b44a', 3.5) + star(h[0] + 15, h[1] - 12, 6, '#ffd23f');
    },
    museum(ox, oy) {
      let s = box(ox + 0.2, oy + 0.2, 1.6, 1.6, 24, '#8c86ad');
      for (let x = 0.3; x < 1.75; x += 0.3) s += fq(ox + x, oy + 1.8, 0.08, 0, 24, '#c9c3e6');
      s += fq(ox + 0.84, oy + 1.8, 0.3, 0, 14, '#ffbf66', GLOW);
      return s + gableY(ox + 0.2, oy + 0.2, 1.6, 1.6, 24, 16, '#4c50b8', '#8c86ad');
    },
    'token-tower'(ox, oy) {
      let s = box(ox + 0.45, oy + 0.45, 1.1, 1.1, 60, '#8c86ad') + box(ox + 0.6, oy + 0.6, 0.8, 0.8, 50, '#9a94bd', 60) + box(ox + 0.72, oy + 0.72, 0.56, 0.56, 40, '#a8a2cc', 110) + pyr(ox + 0.72, oy + 0.72, 0.56, 0.56, 150, 28, '#ffc23d');
      for (let z = 10; z < 146; z += 12) {
        const k = z < 60 ? [ox + 0.45, oy + 1.55, 1.1] : z < 110 ? [ox + 0.6, oy + 1.4, 0.8] : [ox + 0.72, oy + 1.28, 0.56];
        s += fq(k[0]! + 0.08, k[1]!, k[2]! - 0.16, z, 3, '#ffd27a', GLOW);
      }
      const a = P(ox + 1, oy + 1, 178);
      return s + halo(a, 30, 'halo') + line(a, [a[0], a[1] - 14], '#c9a54a', 2) + star(a[0], a[1] - 18, 6, '#fffbe6');
    },
  };

  /** A building, with its level's look: a pennant from Lv 6, and a gold glow and star from Lv 10. */
  function building(kind: BuildingId, ox: number, oy: number, level: number): string {
    windows = (hash(ox, oy) % 97) + 1;
    let s = '';
    if (level >= 10) s += `<ellipse cx="${r(P(ox + 1, oy + 1)[0])}" cy="${r(P(ox + 1, oy + 1)[1])}" rx="58" ry="29" fill="url(#tt-halo)" opacity=".7"/>`;
    s += B[kind](ox, oy);
    const top = P(ox + 1, oy + 1, BUILDING_HEIGHT[kind]);
    if (level >= 6 && kind !== 'town-hall' && kind !== 'token-tower') {
      const pole = P(ox + 1.75, oy + 0.35, Math.min(BUILDING_HEIGHT[kind], 60));
      s += line(pole, [pole[0], pole[1] - 22], '#cfd2ee', 1.5) + `<polygon points="${r(pole[0])},${r(pole[1] - 22)} ${r(pole[0] + 14)},${r(pole[1] - 18)} ${r(pole[0])},${r(pole[1] - 13)}" fill="${level >= 10 ? '#ffc23d' : '#9a92ff'}"/>`;
    }
    if (level >= 10) s += spark(top[0] + 10, top[1] - 12, 7, '#fff3c4') + spark(top[0] - 14, top[1] + 4, 4, '#fff3c4', 0.7);
    return s;
  }
  /** Building work: wooden scaffolding over the plot. */
  function scaffold(ox: number, oy: number): string {
    const C = '#c79a58';
    let s = poly(sq(ox + 0.25, oy + 0.25, 1.5, 1.5), 'rgba(199,154,88,.18)');
    for (let x = 0.3; x <= 1.71; x += 0.47) s += line(P(ox + x, oy + 1.75, 0), P(ox + x, oy + 1.75, 44), C, 1.6);
    for (const z of [14, 29, 44]) s += line(P(ox + 0.3, oy + 1.75, z), P(ox + 1.7, oy + 1.75, z), C, 1.6);
    for (let y = 0.3; y <= 1.71; y += 0.47) s += line(P(ox + 1.75, oy + y, 0), P(ox + 1.75, oy + y, 44), shade(C, -0.2), 1.6);
    for (const z of [14, 29, 44]) s += line(P(ox + 1.75, oy + 0.3, z), P(ox + 1.75, oy + 1.7, z), shade(C, -0.2), 1.6);
    const a = P(ox + 0.3, oy + 1.75, 46);
    return s + halo(a, 14) + dot(a, 2.4, '#ffb02e');
  }
  /** A small home on someone else's land. The roof takes their colour. */
  function house(ox: number, oy: number, roof: string, variant: number): string {
    const W = '#5a5679';
    return box(ox + 0.35, oy + 0.35, 1.3, 1.3, 20, W) + winL(ox + 0.55, oy + 1.65, 7, 0.22, 7) + winL(ox + 1.15, oy + 1.65, 7, 0.22, 7)
      + (variant ? gableY(ox + 0.3, oy + 0.3, 1.4, 1.4, 20, 16, roof, W) : gableX(ox + 0.3, oy + 0.3, 1.4, 1.4, 20, 16, roof, W));
  }
  return {poly, line, sq, dot, halo, tree, lamp, building, scaffold, house, pts, get defs() { return defs; }};
}
export type Art = ReturnType<typeof createArt>;
