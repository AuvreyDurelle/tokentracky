import { AdditiveBlending, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, OrthographicCamera, RingGeometry, Scene, type Sprite, WebGLRenderer } from 'three';
import type { SceneLayout } from './layout.ts';
import { buildTown, disposeTown, effectSprite } from './models.ts';
import type { Piece } from './pieces.ts';
import { MOMENT_MS, PITCH, cameraWindow, momentScale, type Moment } from './view.ts';

/** The town drawn in WebGL, under the scene's flat overlay. It draws only when something changes or a moment plays. */
export interface World3D {
  draw(pieces: readonly Piece[], layout: SceneLayout): void;
  /** Turns the town `angle` radians about the middle of its ground, as `spunProjection` does. */
  turn(angle: number): void;
  /** Plays what just happened on the plot whose back tile is `tile`: a ring of light, sparkles, and the building's bounce. */
  play(kind: Moment['kind'], tile: readonly [number, number]): void;
  dispose(): void;
}

/** How far the camera stands from the middle of the town, in tiles: well clear of any town. */
const DISTANCE = 400;

/** Aims the camera down at the middle of the ground from the isometric angle, framed like the flat drawing in a `width` × `height` canvas. */
export function placeCamera(camera: OrthographicCamera, layout: SceneLayout, width: number, height: number) {
  Object.assign(camera, cameraWindow(layout, width, height));
  camera.near = 1;
  camera.far = DISTANCE * 2;
  const flat = Math.cos(PITCH) * Math.SQRT1_2 * DISTANCE;
  camera.position.set(flat, Math.sin(PITCH) * DISTANCE, flat);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

/** Turns the group holding the town as `spunProjection` turns the overlay. */
export function turnTo(spin: Group, angle: number) { spin.rotation.y = -angle; }

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Throws when the browser has no WebGL, so the caller can keep the flat drawing. */
export function createWorld3D(canvas: HTMLCanvasElement): World3D {
  const renderer = new WebGLRenderer({canvas, antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new Scene(), camera = new OrthographicCamera();
  // Turns about the middle of the ground; the town inside it sits with that middle at the origin.
  const spin = new Group();
  scene.add(spin);
  let town: Group | null = null, layout: SceneLayout | null = null, pieces: readonly Piece[] = [], width = 0, height = 0;
  const render = () => { if (layout && width && height) renderer.render(scene, camera); };
  const fit = () => {
    width = canvas.clientWidth; height = canvas.clientHeight;
    if (!layout || !width || !height) return;
    renderer.setSize(width, height, false);
    placeCamera(camera, layout, width, height);
  };
  const resize = new ResizeObserver(() => { fit(); render(); });
  resize.observe(canvas);
  const clear = () => { if (town) { spin.remove(town); disposeTown(town); town = null; } };
  const build = (apart: readonly [number, number] | null) => {
    if (!layout) return;
    clear();
    town = buildTown(pieces, layout, apart);
    town.position.set(-layout.cols, 0, -layout.rows);
    spin.add(town);
  };

  // A moment playing: its effects, and the frame that draws the next step.
  let frame = 0, finish: (() => void) | null = null;
  const stop = () => { cancelAnimationFrame(frame); frame = 0; finish?.(); finish = null; };
  function play(kind: Moment['kind'], tile: readonly [number, number]) {
    stop();
    if (!town || !layout || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const bounces = kind === 'upgrade' || kind === 'build';
    if (bounces) build(tile);
    const host = town, apart = host.getObjectByName('apart') ?? null;
    const [cx, cz] = kind === 'move' ? [layout.cols, layout.rows] : [tile[0] + 1, tile[1] + 1];
    const reach = kind === 'move' ? Math.max(layout.cols, layout.rows) : 2.6;
    // A ring of light spreading over the ground from the plot.
    const ring = new Mesh(new RingGeometry(0.86, 1, 64), new MeshBasicMaterial({color: new Color('#ffd36b'), transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending}));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, 0.08, cz);
    ring.renderOrder = 3;
    host.add(ring);
    // Sparkles rising off the plot.
    const sparks: Array<{sprite: Sprite; dx: number; dz: number; rise: number; delay: number}> = Array.from({length: kind === 'move' ? 0 : 7}, (_, i) => {
      const sprite = effectSprite(i % 2 ? '#fff3c4' : '#ffd36b'), a = i / 7 * Math.PI * 2;
      host.add(sprite);
      return {sprite, dx: Math.cos(a) * 0.55, dz: Math.sin(a) * 0.55, rise: 1.6 + (i % 3) * 0.5, delay: (i % 4) * 0.06};
    });
    finish = () => {
      host.remove(ring);
      ring.geometry.dispose(); ring.material.dispose();
      for (const {sprite} of sparks) { host.remove(sprite); sprite.material.dispose(); }
      apart?.scale.set(1, 1, 1);
      render();
    };
    const start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / MOMENT_MS;
      if (t >= 1) { frame = 0; finish?.(); finish = null; return; }
      const spread = easeOut(t);
      ring.scale.setScalar(0.3 + reach * spread);
      ring.material.opacity = 0.9 * (1 - t);
      for (const s of sparks) {
        const k = Math.max(0, Math.min(1, (t - s.delay) / (1 - s.delay)));
        s.sprite.position.set(cx + s.dx * (1 + k), 0.4 + s.rise * easeOut(k), cz + s.dz * (1 + k));
        s.sprite.scale.setScalar(0.35 * (1 - k * 0.5));
        s.sprite.material.opacity = k > 0 ? 1 - k : 0;
      }
      if (apart) { const [w, h] = momentScale(kind, t); apart.scale.set(w, h, w); }
      render();
      frame = requestAnimationFrame(step);
    };
    // The first step at once, so a new building never shows at full height before it rises.
    step(start);
  }

  return {
    draw(next, nextLayout) {
      stop();
      pieces = next;
      layout = nextLayout;
      build(null);
      fit();
      render();
    },
    turn(angle) { turnTo(spin, angle); render(); },
    play,
    dispose() { stop(); resize.disconnect(); clear(); renderer.dispose(); },
  };
}
