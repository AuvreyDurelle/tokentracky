import { BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide, Group, IcosahedronGeometry, Mesh, ShaderMaterial, ShapeUtils, Sprite, SpriteMaterial, Vector2, Vector3 } from 'three';
import type { BuildingId } from '@tokentracky/core';
import { BUILDING_HEIGHT, TILE_H, TILE_W, hash, shade } from './art.ts';
import type { SceneLayout } from './layout.ts';
import type { Piece } from './pieces.ts';
import { RISE, UNIT } from './view.ts';

/**
 * The Twilight town in 3D: art.ts's buildings, colours and sizes, built from boxes, roofs and cylinders so they can be
 * seen from every side. Points are given the way art.ts gives them: tile x, tile y, and height in drawing pixels.
 */
type V = readonly [number, number, number];
/** A drawing point in the 3D world, where x and y on the ground are X and Z and the height is Y, all in tiles. */
const at = ([x, y, z]: V) => new Vector3(x, z / RISE, y);
/** `px` drawing pixels to the right of a point (and `up` pixels up), as the town first appears. */
const across = ([x, y, z]: V, px: number, up = 0): V => [x + px / TILE_W, y - px / TILE_W, z + up];
/** Tiles of width for each pixel of stroke the flat drawing gives a line on the ground. */
const STROKE = Math.hypot(TILE_W, TILE_H) / (TILE_W * TILE_H);
/** Lifts a panel off its wall so the two never flicker. */
const LIFT = 0.012;
const ROUND = 20;

const VERTEX = `attribute vec4 tint;
varying vec4 vTint;
varying vec3 vNormal;
void main() {
  vTint = tint;
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
/**
 * Light fixed to the viewer, so the town keeps the flat drawing's shading from every side: a face looking up lightens by
 * 10%, a wall facing the viewer's left darkens by 8% and one facing right by 30%, as art.ts shades its boxes. `tint.a` is
 * how much the light applies: 0 for things that glow and for the ground, which keep their colour.
 */
const SOLID = new ShaderMaterial({
  vertexShader: VERTEX,
  fragmentShader: `varying vec4 vTint;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (n.z < 0.0) n = -n;
  float k = clamp(-0.106 - 0.156 * n.x + 0.238 * n.y, -0.6, 0.3) * vTint.a;
  gl_FragColor = vec4(k < 0.0 ? vTint.rgb * (1.0 + k) : mix(vTint.rgb, vec3(1.0), k), 1.0);
}`,
  side: DoubleSide,
});
/** See-through films on the ground: shadows, borders' glow, water ripples. `tint.a` is the opacity. */
const FILM = new ShaderMaterial({
  vertexShader: VERTEX,
  fragmentShader: 'varying vec4 vTint;\nvoid main() { gl_FragColor = vTint; }',
  side: DoubleSide, transparent: true, depthWrite: false,
});

const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as const; };

/** Triangles for one mesh, each vertex with its normal and tint. */
class Batch {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly tint: number[] = [];
  vertex(p: Vector3, n: Vector3, colour: readonly number[], a: number) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.tint.push(colour[0]!, colour[1]!, colour[2]!, a);
  }
  /** A flat polygon, convex unless `concave`. */
  polygon(points: Vector3[], colour: string, a: number, concave = false) {
    const n = new Vector3();
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length]!;
      n.x += (p.y - q.y) * (p.z + q.z); n.y += (p.z - q.z) * (p.x + q.x); n.z += (p.x - q.x) * (p.y + q.y);
    });
    n.normalize();
    const c = rgb(colour);
    for (const corners of triangles(points, n, concave)) for (const i of corners) this.vertex(points[i]!, n, c, a);
  }
  /** Part of a curved surface: corners with their own normals. */
  patch(points: Vector3[], normals: Vector3[], colour: string) {
    const c = rgb(colour);
    for (const corners of points.length === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]]) for (const i of corners) this.vertex(points[i]!, normals[i]!, c, 1);
  }
  mesh(material: ShaderMaterial): Mesh {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('tint', new BufferAttribute(new Float32Array(this.tint), 4));
    return new Mesh(g, material);
  }
}
function triangles(points: Vector3[], n: Vector3, concave: boolean): number[][] {
  if (!concave) return points.slice(2).map((_, i) => [0, i + 1, i + 2]);
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  return ShapeUtils.triangulateShape(points.map(p => ax >= ay && ax >= az ? new Vector2(p.y, p.z) : ay >= az ? new Vector2(p.x, p.z) : new Vector2(p.x, p.y)), []);
}

/** Lights, halos and smoke: flat shapes that always face the viewer. */
type Shape = 'glow' | 'disc' | 'spark' | 'star' | 'moon';
interface Glow {at: V; radius: number; shape: Shape; colour: string; opacity: number}
const inPolygon = (poly: Array<[number, number]>) => (x: number, y: number) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? 1 : 0;
};
/** A star of `points` points, inner radius `inner`, pointing up, as art.ts's `spark` (4) and `star` (5) draw them. */
const starShape = (points: number, inner: number) => inPolygon(Array.from({length: points * 2}, (_, i) => {
  const a = i * Math.PI / points, q = i % 2 ? inner : 1;
  return [q * Math.sin(a), q * Math.cos(a)] as [number, number];
}));
const SHAPES: Record<Shape, (x: number, y: number) => number> = {
  glow: (x, y) => Math.max(0, 1 - Math.hypot(x, y)),
  disc: (x, y) => Math.hypot(x, y) <= 1 ? 1 : 0,
  spark: starShape(4, 0.31),
  star: starShape(5, 0.45),
  // art.ts's crescent: a circle less one of 1.25 times its radius, centred three quarters of a radius to the right.
  moon: (x, y) => Math.hypot(x, y) <= 1 && Math.hypot(x - 0.75, y) > 1.25 ? 1 : 0,
};
const textures = new Map<Shape, DataTexture>();
/** A 64-pixel white shape, its edges smoothed by sampling each pixel 16 times. */
function texture(shape: Shape): DataTexture {
  let t = textures.get(shape);
  if (t) return t;
  const size = 64, data = new Uint8Array(size * size * 4), alpha = SHAPES[shape];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let a = 0;
    for (let s = 0; s < 16; s++) a += alpha((i + (s % 4 + 0.5) / 4) / size * 2 - 1, (j + (Math.floor(s / 4) + 0.5) / 4) / size * 2 - 1);
    data.set([255, 255, 255, Math.round(a / 16 * 255)], (j * size + i) * 4);
  }
  t = new DataTexture(data, size, size);
  t.needsUpdate = true;
  textures.set(shape, t);
  return t;
}
const spriteMaterials = new Map<string, SpriteMaterial>();
function spriteMaterial({shape, colour, opacity}: Glow): SpriteMaterial {
  const key = `${shape}${colour}${opacity}`;
  let m = spriteMaterials.get(key);
  if (m) return m;
  m = new SpriteMaterial({map: texture(shape), color: new Color(colour), opacity, transparent: true, depthWrite: false});
  // Each light is drawn as if a radius nearer the viewer, so the wall it hangs on doesn't cut it in half, while a building
  // in front still hides it.
  m.onBeforeCompile = shader => { shader.vertexShader = shader.vertexShader.replace('mvPosition.xy += rotatedPosition;', 'mvPosition.xy += rotatedPosition;\n\tmvPosition.z += scale.x * 0.5;'); };
  spriteMaterials.set(key, m);
  return m;
}

/** Drawing helpers that add to one town's meshes, in the shape of art.ts's. */
function createModels(solid: Batch, film: Batch, glows: Glow[]) {
  /** The middle of the plot being drawn: windows repeat through it onto the back walls the flat drawing never shows. */
  let mx = 0, my = 0;
  const face = (points: readonly V[], colour: string, glow = false, concave = false) => solid.polygon(points.map(at), colour, glow ? 0 : 1, concave);
  const filmOf = (points: readonly V[], colour: string, opacity: number) => film.polygon(points.map(at), colour, opacity);
  const sq = (x: number, y: number, w: number, d: number, z = 0): V[] => [[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]];
  const wallY = (x: number, y: number, w: number, z: number, h: number): V[] => [[x, y, z], [x + w, y, z], [x + w, y, z + h], [x, y, z + h]];
  const wallX = (x: number, y: number, w: number, z: number, h: number): V[] => [[x, y, z], [x, y + w, z], [x, y + w, z + h], [x, y, z + h]];
  const circle = (n: number, f: (a: number) => V): V[] => Array.from({length: n}, (_, i) => f(i / n * 2 * Math.PI));

  function box(x: number, y: number, w: number, d: number, h: number, c: string, z = 0, top = true) {
    if (top) face(sq(x, y, w, d, z + h), c);
    face(wallY(x, y + d, w, z, h), c); face(wallY(x, y, w, z, h), c);
    face(wallX(x + w, y, d, z, h), c); face(wallX(x, y, d, z, h), c);
  }
  /** A panel on a wall facing +y, the front left as the town first appears (art.ts's `fq`). `twin` repeats it on the back wall. */
  function fq(x: number, yF: number, w: number, z: number, h: number, c: string, glow = false, twin = false, lift = LIFT) {
    face(wallY(x, yF + lift, w, z, h), c, glow);
    if (twin) face(wallY(x, 2 * my - yF - lift, w, z, h), c, glow);
  }
  /** A panel on a wall facing +x, the front right (art.ts's `rq`). */
  function rq(xF: number, y: number, w: number, z: number, h: number, c: string, glow = false, twin = false) {
    face(wallX(xF + LIFT, y, w, z, h), c, glow);
    if (twin) face(wallX(2 * mx - xF - LIFT, y, w, z, h), c, glow);
  }
  // Lit windows follow art.ts's fixed pattern, so a town looks the same in both drawings.
  let windows = 1;
  const glass = () => hash(windows++, 9) % 5 > 0 ? '#ffd27a' : '#2c3058';
  const winL = (x: number, yF: number, z: number, w = 0.2, h = 8) => fq(x, yF, w, z, h, glass(), true, true);
  const winR = (xF: number, y: number, z: number, w = 0.2, h = 8) => rq(xF, y, w, z, h, glass(), true, true);
  const door = (x: number, yF: number, w: number, h: number) => fq(x, yF, w, 0, h, '#ffbf66', true, false, 2 * LIFT);
  function gableX(x: number, y: number, w: number, d: number, z: number, rh: number, roof: string, wall: string) {
    const m = y + d / 2;
    face([[x, y, z], [x + w, y, z], [x + w, m, z + rh], [x, m, z + rh]], roof);
    face([[x, y + d, z], [x + w, y + d, z], [x + w, m, z + rh], [x, m, z + rh]], roof);
    face([[x + w, y, z], [x + w, y + d, z], [x + w, m, z + rh]], wall);
    face([[x, y, z], [x, y + d, z], [x, m, z + rh]], wall);
  }
  function gableY(x: number, y: number, w: number, d: number, z: number, rh: number, roof: string, wall: string) {
    const m = x + w / 2;
    face([[x, y, z], [x, y + d, z], [m, y + d, z + rh], [m, y, z + rh]], roof);
    face([[x + w, y, z], [x + w, y + d, z], [m, y + d, z + rh], [m, y, z + rh]], roof);
    face([[x, y + d, z], [x + w, y + d, z], [m, y + d, z + rh]], wall);
    face([[x, y, z], [x + w, y, z], [m, y, z + rh]], wall);
  }
  function pyr(x: number, y: number, w: number, d: number, z: number, rh: number, c: string) {
    const A: V = [x + w / 2, y + d / 2, z + rh], b = sq(x, y, w, d, z);
    for (let i = 0; i < 4; i++) face([b[i]!, b[(i + 1) % 4]!, A], c);
  }
  /** An upright cylinder of radius `q` tiles, from height `z0` up `h` pixels, with a lid. */
  function cyl(cx: number, cy: number, q: number, z0: number, h: number, c: string) {
    for (let i = 0; i < ROUND; i++) {
      const a0 = i / ROUND * 2 * Math.PI, a1 = (i + 1) / ROUND * 2 * Math.PI;
      const n0 = new Vector3(Math.cos(a0), 0, Math.sin(a0)), n1 = new Vector3(Math.cos(a1), 0, Math.sin(a1));
      const p = (a: number, z: number) => at([cx + q * Math.cos(a), cy + q * Math.sin(a), z]);
      solid.patch([p(a0, z0), p(a1, z0), p(a1, z0 + h), p(a0, z0 + h)], [n0, n1, n1, n0], c);
    }
    disc(cx, cy, q, z0 + h, c);
  }
  const disc = (cx: number, cy: number, q: number, z: number, c: string, glow = false) => face(circle(ROUND, a => [cx + q * Math.cos(a), cy + q * Math.sin(a), z]), c, glow);
  /** An upright cone of base radius `q` tiles, from `z0` up `h` pixels. */
  function cone(cx: number, cy: number, q: number, z0: number, h: number, c: string, sides = ROUND) {
    const H = h / RISE, L = Math.hypot(q, H), tip = at([cx, cy, z0 + h]);
    const n = (a: number) => new Vector3(Math.cos(a) * H / L, q / L, Math.sin(a) * H / L);
    for (let i = 0; i < sides; i++) {
      const a0 = i / sides * 2 * Math.PI, a1 = (i + 1) / sides * 2 * Math.PI;
      solid.patch([at([cx + q * Math.cos(a0), cy + q * Math.sin(a0), z0]), at([cx + q * Math.cos(a1), cy + q * Math.sin(a1), z0]), tip], [n(a0), n(a1), n((a0 + a1) / 2)], c);
    }
  }
  /** Half a sphere of radius `q` tiles sitting at height `z0`. */
  function dome(cx: number, cy: number, q: number, z0: number, c: string) {
    const centre = at([cx, cy, z0]), bands = 6;
    const n = (a: number, e: number) => new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
    const p = (a: number, e: number) => centre.clone().addScaledVector(n(a, e), q);
    for (let i = 0; i < ROUND; i++) for (let j = 0; j < bands; j++) {
      const a0 = i / ROUND * 2 * Math.PI, a1 = (i + 1) / ROUND * 2 * Math.PI, e0 = j / bands * Math.PI / 2, e1 = (j + 1) / bands * Math.PI / 2;
      solid.patch([p(a0, e0), p(a1, e0), p(a1, e1), p(a0, e1)], [n(a0, e0), n(a1, e0), n(a1, e1), n(a0, e1)], c);
    }
  }
  /** A faceted ball of radius `q` tiles. */
  function ball(centre: V, q: number, c: string) {
    const g = new IcosahedronGeometry(q, 1), p = g.getAttribute('position'), o = at(centre);
    for (let i = 0; i < p.count; i += 3) solid.polygon([0, 1, 2].map(k => new Vector3().fromBufferAttribute(p, i + k).add(o)), c, 1);
    g.dispose();
  }
  /** A square bar `px` pixels thick from `a` to `b`: poles, rods, scaffolding. */
  function rod(a: V, b: V, px: number, c: string, glow = false) {
    const A = at(a), B = at(b), d = B.clone().sub(A).normalize(), half = px / UNIT / 2;
    const u = new Vector3().crossVectors(d, Math.abs(d.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize().multiplyScalar(half);
    const v = new Vector3().crossVectors(d, u).normalize().multiplyScalar(half);
    const corner = (P: Vector3, [s, t]: readonly [number, number]) => P.clone().addScaledVector(u, s).addScaledVector(v, t);
    const ring = [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const;
    for (let i = 0; i < 4; i++) solid.polygon([corner(A, ring[i]!), corner(A, ring[(i + 1) % 4]!), corner(B, ring[(i + 1) % 4]!), corner(B, ring[i]!)], c, glow ? 0 : 1);
    solid.polygon(ring.map(k => corner(B, k)), c, glow ? 0 : 1);
  }
  /** A line drawn flat at height `z`, `px` pixels of stroke wide; see-through when `opacity` is below 1. */
  function ribbon(a: readonly [number, number], b: readonly [number, number], z: number, px: number, c: string, opacity = 1) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), w = px * STROKE / 2;
    const [nx, ny, ex, ey] = [-dy / len * w, dx / len * w, dx / len * w, dy / len * w];
    const points: V[] = [[a[0] - ex + nx, a[1] - ey + ny, z], [b[0] + ex + nx, b[1] + ey + ny, z], [b[0] + ex - nx, b[1] + ey - ny, z], [a[0] - ex - nx, a[1] - ey - ny, z]];
    if (opacity < 1) filmOf(points, c, opacity); else face(points, c, true);
  }
  /** Something round on a wall facing +y, `px` pixels in radius: a clock, a dial, a coin. */
  const badge = (cx: number, yF: number, z: number, px: number, c: string, lift = 2 * LIFT) =>
    face(circle(16, a => [cx + px / 32 * Math.cos(a), yF + lift, z + px * Math.sin(a)]), c, true);
  /** A flag on top of a pole whose tip is `top`. */
  const pennant = (top: V, c: string, drop = 9) => face([top, across(top, 15, -4), [top[0], top[1], top[2] - drop]], c, true);
  /** A soft glow on the ground, fading out from the middle. */
  function pool(cx: number, cy: number, q: number, c: string, opacity: number) {
    const up = new Vector3(0, 1, 0), colour = rgb(c), p = (a: number) => at([cx + q * Math.cos(a), cy + q * Math.sin(a), 0.3]);
    for (let i = 0; i < ROUND; i++) {
      film.vertex(at([cx, cy, 0.3]), up, colour, opacity);
      film.vertex(p(i / ROUND * 2 * Math.PI), up, colour, 0);
      film.vertex(p((i + 1) / ROUND * 2 * Math.PI), up, colour, 0);
    }
  }
  const HALO = {halo: ['#ffd9b0', 0.55], lamp: ['#ffc770', 0.6], cyan: ['#7fe3ff', 0.6]} as const;
  const halo = (p: V, px: number, g: keyof typeof HALO = 'lamp') => glows.push({at: p, radius: px, shape: 'glow', colour: HALO[g][0], opacity: HALO[g][1]});
  const dot = (p: V, px: number, c: string) => glows.push({at: p, radius: px, shape: 'disc', colour: c, opacity: 1}, {at: p, radius: px * 2.6, shape: 'glow', colour: c, opacity: 0.5});
  const smoke = (p: V) => { for (const [dx, up, px] of [[2, 6, 6], [9, 16, 9], [19, 29, 11]] as const) glows.push({at: across(p, dx, up), radius: px, shape: 'disc', colour: '#b9b2e8', opacity: 0.22}); };
  const sparkle = (p: V, px: number, c: string, opacity = 0.9, shape: Shape = 'spark') => glows.push({at: p, radius: px, shape, colour: c, opacity});

  function tree(x: number, y: number, s: number, pine = false) {
    const cx = x + 0.5, cy = y + 0.5, [sx, sy] = across([cx, cy, 0], 3);
    filmOf(circle(ROUND, a => [sx + 13 * s / UNIT * Math.cos(a), sy + 13 * s / UNIT * Math.sin(a), 0.3]), '#000014', 0.3);
    box(cx - 2 / UNIT, cy - 2 / UNIT, 4 / UNIT, 4 / UNIT, 12 * s, '#3e2f3c');
    if (pine) cone(cx, cy, 13 * s / UNIT, 10 * s, 36 * s, '#1b4636', 7);
    else ball([cx, cy, 22 * s], 13 * s / UNIT, '#1c473a');
  }
  function lamp(x: number, y: number) {
    rod([x, y, 0], [x, y, 26], 2.4, '#24213c');
    halo([x, y, 26], 20);
    dot([x, y, 26], 3, '#fff1c4');
  }

  // Each model fills the 2×2 plot whose back corner is (ox, oy), as in art.ts.
  const B: Record<BuildingId, (ox: number, oy: number) => void> = {
    'power-plant'(ox, oy) {
      const h = 34, a = h - 11;
      box(ox + 0.2, oy + 0.2, 1.6, 1.6, h, '#646a96');
      fq(ox + 0.2, oy + 1.8, 1.6, a, 5, '#ffd04a', true, true);
      rq(ox + 1.8, oy + 0.2, 1.6, a, 5, '#e9ae30', true, true);
      door(ox + 0.4, oy + 1.8, 0.45, 14);
      for (const y of [0.45, 0.95, 1.4]) winR(ox + 1.8, oy + y, 9, 0.25, 8);
      // The power glyph from art.ts's GLYPHS, 16 pixels tall on the front wall.
      const bolt = [[13.5, 2], [4.5, 13.5], [10.5, 13.5], [9, 22], [19, 9.5], [12.8, 9.5]] as const;
      face(bolt.map(([u, v]): V => [ox + 1.3 + (u / 24 - 0.5) * 0.5, oy + 1.8 + 2 * LIFT, 7 + (1 - v / 24) * 16]), '#ffd23f', true, true);
      for (const [cx, ht] of [[0.6, 58], [1.3, 44]] as const) { cyl(ox + cx, oy + 0.55, 0.17, h, ht, '#575c84'); dot([ox + cx, oy + 0.55, h + ht + 4], 2, '#ff5a4a'); }
      smoke([ox + 0.6, oy + 0.55, h + 62]);
    },
    workshop(ox, oy) {
      const w = '#827a9e';
      box(ox + 0.35, oy + 0.35, 1.3, 1.3, 24, w);
      door(ox + 0.85, oy + 1.65, 0.3, 14);
      winL(ox + 0.5, oy + 1.65, 8, 0.22, 8); winL(ox + 1.3, oy + 1.65, 8, 0.22, 8); winR(ox + 1.65, oy + 0.6, 8, 0.22, 8); winR(ox + 1.65, oy + 1.1, 8, 0.22, 8);
      gableY(ox + 0.3, oy + 0.3, 1.4, 1.4, 24, 18, '#b4573a', w);
      // The gear on the gable: a ring of five pixels.
      for (let i = 0; i < 12; i++) {
        const a0 = i / 12 * 2 * Math.PI, a1 = (i + 0.6) / 12 * 2 * Math.PI, p = (a: number, r: number): V => [ox + 1 + r / 32 * Math.cos(a), oy + 1.7 + 2 * LIFT, 36 + r * Math.sin(a)];
        face([p(a0, 3.8), p(a1, 3.8), p(a1, 6.2), p(a0, 6.2)], '#ffd27a', true);
      }
    },
    reservoir(ox, oy) {
      for (const [a, b] of [[0.45, 0.45], [1.43, 0.45], [0.45, 1.43], [1.43, 1.43]] as const) box(ox + a, oy + b, 0.12, 0.12, 50, '#4c5076');
      cyl(ox + 1, oy + 1, 0.72, 50, 34, '#2f72a8');
      // The level gauge, on the side of the tank that faces you as the town first appears.
      const g = 0.72 * Math.SQRT1_2 + LIFT, gauge = (w: number, z0: number, z1: number, c: string, lift: number) =>
        face([[ox + 1 + g + lift - w, oy + 1 + g + lift + w, z0], [ox + 1 + g + lift + w, oy + 1 + g + lift - w, z0], [ox + 1 + g + lift + w, oy + 1 + g + lift - w, z1], [ox + 1 + g + lift - w, oy + 1 + g + lift + w, z1]], c, true);
      gauge(4 / TILE_W, 52, 86, '#162a50', 0);
      gauge(3 / TILE_W, 52, 76, '#7fe3ff', LIFT);
      cone(ox + 1, oy + 1, 0.72 + 3 / UNIT, 84, 18, '#1d4d7a');
      halo([ox + 1, oy + 1, 106], 18, 'cyan');
      dot([ox + 1, oy + 1, 106], 3, '#7fe3ff');
    },
    brickworks(ox, oy) {
      box(ox + 0.2, oy + 0.2, 1.6, 1.6, 28, '#8c4c40');
      for (const x of [0.4, 0.8, 1.25]) winL(ox + x, oy + 1.8, 9, 0.18, 9);
      gableX(ox + 0.2, oy + 0.2, 1.6, 1.6, 28, 16, '#5e2f2b', '#8c4c40');
      // The chimney starts inside the roof, so no gap shows from behind.
      cyl(ox + 1.45, oy + 0.55, 0.14, 28, 38, '#6b3a32');
      smoke([ox + 1.45, oy + 0.55, 70]);
      halo([ox + 0.4, oy + 1.8, 30], 16);
      dot([ox + 0.4, oy + 1.8, 30], 2.6, '#ffb02e');
    },
    'town-hall'(ox, oy) {
      const W = '#8c86ad';
      box(ox + 0.15, oy + 0.15, 1.7, 1.7, 36, W);
      for (const x of [0.3, 0.6, 1.25, 1.55]) for (const z of [8, 22]) winL(ox + x, oy + 1.85, z, 0.18, 9);
      door(ox + 0.85, oy + 1.85, 0.3, 18);
      for (const y of [0.3, 0.65, 1, 1.35]) for (const z of [8, 22]) winR(ox + 1.85, oy + y, z, 0.18, 9);
      box(ox + 0.5, oy + 0.5, 1, 1, 16, shade(W, -0.04), 36);
      pyr(ox + 0.5, oy + 0.5, 1, 1, 52, 24, '#4c50b8');
      badge(ox + 1, oy + 1.5, 44, 5, '#fff4d0');
      rod([ox + 1, oy + 1, 70], [ox + 1, oy + 1, 96], 1.5, '#9a96c0');
      pennant([ox + 1, oy + 1, 96], '#ffc23d', 8);
    },
    observatory(ox, oy) {
      box(ox + 0.2, oy + 0.2, 1.6, 1.6, 28, '#7a73a6');
      for (const x of [0.45, 0.85, 1.25]) winL(ox + x, oy + 1.8, 9, 0.22, 9);
      for (const y of [0.45, 0.85, 1.25]) winR(ox + 1.8, oy + y, 9, 0.22, 9);
      dome(ox + 1, oy + 1, 0.66, 28, '#6a55d0');
      // The open slit runs up the dome on the side that faces you as the town first appears.
      const c = at([ox + 1, oy + 1, 28]), out = new Vector3(Math.SQRT1_2, 0, Math.SQRT1_2), side = new Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
      for (let j = 0; j < 6; j++) {
        const e0 = j / 6 * 1.2, e1 = (j + 1) / 6 * 1.2, w0 = (4 - j / 6) / UNIT, w1 = (4 - (j + 1) / 6) / UNIT;
        const p = (e: number, w: number) => c.clone().addScaledVector(out, 0.67 * Math.cos(e)).add(new Vector3(0, 0.67 * Math.sin(e), 0)).addScaledVector(side, w);
        solid.polygon([p(e0, -w0), p(e0, w0), p(e1, w1), p(e1, -w1)], '#a8f0ff', 0);
      }
      const eye: V = [ox + 1.21, oy + 1.15, 52];
      rod(eye, across(eye, 20, 16), 6, '#cfd2ee');
    },
    'data-center'(ox, oy) {
      box(ox + 0.15, oy + 0.3, 1.7, 1.4, 26, '#5a6188');
      const L = ['#4cc3f0', '#36d68a', '#9a92ff', '#ffd23f'];
      let i = 0;
      for (let x = 0.3; x < 1.75; x += 0.18) for (const z of [7, 15]) fq(ox + x, oy + 1.7, 0.09, z, 3, L[i++ % 4]!, true, true);
      for (let y = 0.45; y < 1.6; y += 0.18) rq(ox + 1.85, oy + y, 0.09, 11, 3, L[i++ % 4]!, true, true);
      box(ox + 0.35, oy + 0.5, 0.4, 0.4, 9, '#474d70', 26); box(ox + 0.95, oy + 0.5, 0.4, 0.4, 9, '#474d70', 26); box(ox + 1.45, oy + 0.95, 0.25, 0.6, 6, '#3f4466', 26);
      rod([ox + 0.55, oy + 0.7, 35], [ox + 0.55, oy + 0.7, 51], 1.5, '#9a96c0');
      dot([ox + 0.55, oy + 0.7, 52], 2.5, '#ff5a4a');
    },
    vault(ox, oy) {
      box(ox + 0.3, oy + 0.3, 1.4, 1.4, 30, '#7d7697');
      for (const x of [0.4, 0.7, 1.22, 1.52]) fq(ox + x, oy + 1.7, 0.08, 0, 30, '#a59fc4', false, true);
      fq(ox + 0.85, oy + 1.7, 0.3, 0, 20, '#e0a82a', true);
      badge(ox + 1, oy + 1.7, 10, 4, '#fff3c4');
      box(ox + 0.25, oy + 0.25, 1.5, 1.5, 5, '#6a5f8c', 30);
      pyr(ox + 0.5, oy + 0.5, 1, 1, 35, 14, '#c9a54a');
    },
    market(ox, oy) {
      box(ox + 0.15, oy + 0.15, 1.7, 1.7, 4, '#4c4870');
      box(ox + 0.35, oy + 0.35, 1.3, 1.3, 18, '#827a9e', 4);
      const z = 22, m = oy + 1, rh = 14;
      // The striped awning, peaked along the middle.
      for (let i = 0; i < 5; i++) {
        const x0 = ox + 0.3 + i * 0.28, c = i % 2 ? '#e8e0f0' : '#c8463e';
        face([[x0, oy + 0.3, z], [x0 + 0.28, oy + 0.3, z], [x0 + 0.28, m, z + rh], [x0, m, z + rh]], c);
        face([[x0, oy + 1.7, z], [x0 + 0.28, oy + 1.7, z], [x0 + 0.28, m, z + rh], [x0, m, z + rh]], c);
      }
      for (const x of [ox + 0.3, ox + 1.7]) face([[x, oy + 0.3, z], [x, oy + 1.7, z], [x, m, z + rh]], '#5a5679');
      box(ox + 1.45, oy + 1.72, 0.18, 0.18, 7, '#8a5a3a', 4); box(ox + 1.18, oy + 1.75, 0.18, 0.18, 6, '#9a6a42', 4);
      halo([ox + 0.6, oy + 1.65, 12], 16);
      badge(ox + 0.6, oy + 1.65, 12, 5.5, '#ffc23d');
    },
    park(ox, oy) {
      face(sq(ox + 0.15, oy + 0.15, 1.7, 1.7, 0.3), '#2c5a42', true);
      ribbon([ox + 0.15, oy + 1], [ox + 1.85, oy + 1], 0.6, 5, '#5d5a7c');
      ribbon([ox + 1, oy + 0.15], [ox + 1, oy + 1.85], 0.6, 5, '#5d5a7c');
      tree(ox - 0.05, oy - 0.05, 0.75); tree(ox + 0.95, oy - 0.05, 0.7, true); tree(ox - 0.05, oy + 0.95, 0.7, true);
      cyl(ox + 1, oy + 1, 0.32, 0, 7, '#6a6890');
      disc(ox + 1, oy + 1, 0.24, 7.3, '#4cc3f0', true);
      rod([ox + 1, oy + 1, 7], [ox + 1, oy + 1, 23], 2.5, '#bfeaf8', true);
      ball([ox + 1, oy + 1, 24], 3 / UNIT, '#dff6ff');
      lamp(ox + 1.7, oy + 0.3);
      tree(ox + 1.15, oy + 1.15, 0.65);
    },
    tavern(ox, oy) {
      box(ox + 0.3, oy + 0.3, 1.4, 1.4, 24, '#6a5a8c');
      for (const x of [0.45, 1.2]) fq(ox + x, oy + 1.7, 0.25, 8, 9, '#ffd27a', true, true);
      for (const y of [0.55, 1.15]) rq(ox + 1.7, oy + y, 0.25, 8, 9, '#f5c451', true, true);
      fq(ox + 0.82, oy + 1.7, 0.26, 0, 15, '#3a2c5a');
      halo([ox + 0.95, oy + 1.7, 20], 14);
      gableX(ox + 0.25, oy + 0.25, 1.5, 1.5, 24, 18, '#2d2550', '#6a5a8c');
      box(ox + 0.5, oy + 0.45, 0.18, 0.18, 22, '#5a4a7a', 24);
      const moon: V = [ox + 1.5, oy + 0.4, 66];
      sparkle(moon, 22, '#ffe9a8', 0.3, 'glow');
      sparkle(moon, 10, '#ffe9a8', 1, 'moon');
    },
    arena(ox, oy) {
      cyl(ox + 1, oy + 1, 0.85, 0, 22, '#7a73a6');
      // Arched windows all the way round, one of them facing you as the town first appears.
      for (let i = 0; i < 10; i++) {
        const a = Math.PI / 4 + i / 10 * 2 * Math.PI, r = 0.85 + LIFT, w = 4 / UNIT;
        const [x, y, tx, ty] = [ox + 1 + r * Math.cos(a), oy + 1 + r * Math.sin(a), -Math.sin(a) * w, Math.cos(a) * w];
        face([[x - tx, y - ty, 6], [x + tx, y + ty, 6], [x + tx, y + ty, 17], [x - tx, y - ty, 17]], '#ffd27a', true);
      }
      disc(ox + 1, oy + 1, 0.85 * 0.78, 22.3, '#2c5a42');
      for (let i = 0; i < ROUND; i++) {
        const a0 = i / ROUND * 2 * Math.PI, a1 = (i + 1) / ROUND * 2 * Math.PI, p = (a: number, r: number): V => [ox + 1 + r * Math.cos(a), oy + 1 + r * Math.sin(a), 22.6];
        face([p(a0, 0.63), p(a1, 0.63), p(a1, 0.7), p(a0, 0.7)], '#b9b0dc', true);
      }
      for (const [dx, dy, c] of [[-1, 1, '#ff6b5b'], [1, -1, '#ff6b5b'], [-1, -1, '#ffc23d']] as const) {
        const x = ox + 1 + dx * Math.SQRT1_2 * 0.78, y = oy + 1 + dy * Math.SQRT1_2 * 0.78;
        rod([x, y, 22], [x, y, 40], 1.5, '#9a96c0');
        pennant([x, y, 40], c, 6);
      }
    },
    statue(ox, oy) {
      face(sq(ox + 0.35, oy + 0.35, 1.3, 1.3, 0.3), '#4a4668', true);
      tree(ox - 0.05, oy - 0.05, 0.6); tree(ox + 1.05, oy - 0.1, 0.55, true);
      box(ox + 0.7, oy + 0.7, 0.6, 0.6, 16, '#7d7697');
      cyl(ox + 1, oy + 1, 0.13, 16, 22, '#d9b44a');
      const h: V = [ox + 1, oy + 1, 44];
      halo(h, 22);
      ball(h, 6 / UNIT, '#e8c55a');
      rod(across(h, 3, -6), across(h, 13, 8), 3.5, '#d9b44a');
      sparkle(across(h, 15, 12), 6, '#ffd23f', 1, 'star');
    },
    museum(ox, oy) {
      box(ox + 0.2, oy + 0.2, 1.6, 1.6, 24, '#8c86ad');
      for (let x = 0.3; x < 1.75; x += 0.3) fq(ox + x, oy + 1.8, 0.08, 0, 24, '#c9c3e6', false, true);
      door(ox + 0.84, oy + 1.8, 0.3, 14);
      gableY(ox + 0.2, oy + 0.2, 1.6, 1.6, 24, 16, '#4c50b8', '#8c86ad');
    },
    'token-tower'(ox, oy) {
      box(ox + 0.45, oy + 0.45, 1.1, 1.1, 60, '#8c86ad'); box(ox + 0.6, oy + 0.6, 0.8, 0.8, 50, '#9a94bd', 60); box(ox + 0.72, oy + 0.72, 0.56, 0.56, 40, '#a8a2cc', 110);
      pyr(ox + 0.72, oy + 0.72, 0.56, 0.56, 150, 28, '#ffc23d');
      // Bands of light round every side of each tier.
      for (let z = 10; z < 146; z += 12) {
        const [x0, w] = z < 60 ? [ox + 0.45, 1.1] : z < 110 ? [ox + 0.6, 0.8] : [ox + 0.72, 0.56];
        const y0 = x0 - ox + oy;
        fq(x0 + 0.08, y0 + w, w - 0.16, z, 3, '#ffd27a', true, true);
        rq(x0 + w, y0 + 0.08, w - 0.16, z, 3, '#ffd27a', true, true);
      }
      const a: V = [ox + 1, oy + 1, 178];
      halo(a, 30, 'halo');
      rod(a, [ox + 1, oy + 1, 192], 2, '#c9a54a');
      sparkle([ox + 1, oy + 1, 196], 6, '#fffbe6', 1, 'star');
    },
  };

  return {
    /** The floating island under the town: its slab and the rock beneath. */
    island(layout: SceneLayout) {
      const nx = layout.cols * 2, ny = layout.rows * 2;
      box(0, 0, nx, ny, 20, '#30264d', -26, false);
      box(0, 0, nx, ny, 6, '#32534e', -6, false);
      // The point sits as far below the front corner as the flat drawing's rock does.
      const depth = 150 + (nx + ny) * 8;
      const rim: V[] = ([[0, 0], [nx / 2, 0], [nx, 0], [nx, ny / 2], [nx, ny], [nx / 2, ny], [0, ny], [0, ny / 2]] as const).map(([x, y]) => [x, y, -26]);
      const mid: V[] = rim.map(([x, y], i) => { const k = 0.6 + (hash(i, 3) % 7) / 60; return [nx / 2 + (x - nx / 2) * k, ny / 2 + (y - ny / 2) * k, -26 - (depth - 26) * 0.45 - (hash(i, 5) % 30)]; });
      const tip: V = [nx / 2, ny / 2, -depth];
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8, c = i % 2 ? '#2a2150' : '#231b44';
        face([rim[i]!, rim[j]!, mid[j]!], c); face([rim[i]!, mid[j]!, mid[i]!], c); face([mid[i]!, mid[j]!, tip], c);
        const [x, y, z] = mid[i]!;
        dot([nx / 2 + (x - nx / 2) * 1.04, ny / 2 + (y - ny / 2) * 1.04, z + 20], 2.2, i % 2 ? '#b18cff' : '#7fe3ff');
      }
    },
    /** A building, with its level's look: a pennant from Lv 6, and a gold glow and sparkles from Lv 10. */
    building(kind: BuildingId, ox: number, oy: number, level: number) {
      windows = (hash(ox, oy) % 97) + 1;
      mx = ox + 1; my = oy + 1;
      if (level >= 10) pool(ox + 1, oy + 1, 58 / UNIT, '#ffd9b0', 0.55 * 0.7);
      B[kind](ox, oy);
      const top: V = [ox + 1, oy + 1, BUILDING_HEIGHT[kind]];
      if (level >= 6 && kind !== 'town-hall' && kind !== 'token-tower') {
        // A flagpole at the back corner of the plot, as tall as the flat drawing's pennant stands.
        const pole: V = [ox + 1.75, oy + 0.35, Math.min(BUILDING_HEIGHT[kind], 60) + 22];
        rod([pole[0], pole[1], 0], pole, 1.5, '#cfd2ee');
        pennant(pole, level >= 10 ? '#ffc23d' : '#9a92ff');
      }
      if (level >= 10) { sparkle(across(top, 10, 12), 7, '#fff3c4'); sparkle(across(top, -14, -4), 4, '#fff3c4', 0.7); }
    },
    /** Building work: wooden scaffolding round the plot. */
    scaffold(ox: number, oy: number) {
      const C = '#c79a58';
      filmOf(sq(ox + 0.25, oy + 0.25, 1.5, 1.5, 0.4), C, 0.18);
      for (const y of [oy + 1.75, oy + 0.25]) {
        for (let x = 0.3; x <= 1.71; x += 0.47) rod([ox + x, y, 0], [ox + x, y, 44], 1.6, C);
        for (const z of [14, 29, 44]) rod([ox + 0.3, y, z], [ox + 1.7, y, z], 1.6, C);
      }
      for (const x of [ox + 1.75, ox + 0.25]) {
        for (let y = 0.3; y <= 1.71; y += 0.47) rod([x, oy + y, 0], [x, oy + y, 44], 1.6, C);
        for (const z of [14, 29, 44]) rod([x, oy + 0.3, z], [x, oy + 1.7, z], 1.6, C);
      }
      halo([ox + 0.3, oy + 1.75, 46], 14);
      dot([ox + 0.3, oy + 1.75, 46], 2.4, '#ffb02e');
    },
    /** A small home on someone else's land. The roof takes their colour. */
    house(ox: number, oy: number, roof: string, variant: number) {
      const W = '#5a5679';
      mx = ox + 1; my = oy + 1;
      box(ox + 0.35, oy + 0.35, 1.3, 1.3, 20, W);
      winL(ox + 0.55, oy + 1.65, 7, 0.22, 7); winL(ox + 1.15, oy + 1.65, 7, 0.22, 7);
      if (variant) gableY(ox + 0.3, oy + 0.3, 1.4, 1.4, 20, 16, roof, W); else gableX(ox + 0.3, oy + 0.3, 1.4, 1.4, 20, 16, roof, W);
    },
    tree, lamp, face, ribbon, sq,
  };
}

/** The whole town as 3D objects, in tiles with the back corner of the ground at the origin. */
export function buildTown(pieces: readonly Piece[], layout: SceneLayout): Group {
  const solid = new Batch(), film = new Batch(), glows: Glow[] = [];
  const art = createModels(solid, film, glows);
  art.island(layout);
  for (const piece of pieces) {
    switch (piece.type) {
      case 'tile': art.face(art.sq(piece.x, piece.y, 1, 1), piece.colour, true); break;
      case 'ripple': {
        const [ax, ay] = across([piece.x, piece.y, 0], -14), [bx, by] = across([piece.x, piece.y, 0], 14);
        art.ribbon([ax, ay], [bx, by], 0.5, 1.5, '#9fb6f0', 0.3);
        break;
      }
      case 'border':
        art.ribbon(piece.a, piece.b, 0.4, piece.own ? 9 : 6, piece.colour, piece.own ? 0.28 : 0.14);
        art.ribbon(piece.a, piece.b, 0.5, piece.own ? 2.6 : 1.6, piece.colour, piece.own ? 1 : 0.6);
        break;
      case 'building': art.building(piece.kind, piece.x, piece.y, piece.level); break;
      case 'scaffold': art.scaffold(piece.x, piece.y); break;
      case 'house': art.house(piece.x, piece.y, piece.roof, piece.variant); break;
      case 'tree': art.tree(piece.x, piece.y, piece.size, piece.pine); break;
      case 'lamp': art.lamp(piece.x, piece.y); break;
    }
  }
  const group = new Group();
  group.add(solid.mesh(SOLID));
  const films = film.mesh(FILM);
  films.renderOrder = 1;
  group.add(films);
  for (const glow of glows) {
    const sprite = new Sprite(spriteMaterial(glow));
    sprite.position.copy(at(glow.at));
    sprite.scale.setScalar(2 * glow.radius / UNIT);
    sprite.renderOrder = 2;
    group.add(sprite);
  }
  return group;
}

/** Frees a town's meshes. Materials and textures are shared and kept. */
export function disposeTown(group: Group) {
  group.traverse(object => { if (object instanceof Mesh) object.geometry.dispose(); });
}
