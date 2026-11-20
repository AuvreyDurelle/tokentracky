import { Group, OrthographicCamera, Scene, WebGLRenderer } from 'three';
import type { SceneLayout } from './layout.ts';
import { buildTown, disposeTown } from './models.ts';
import type { Piece } from './pieces.ts';
import { PITCH, cameraWindow } from './view.ts';

/** The town drawn in WebGL, under the scene's flat overlay. It draws only when something changes. */
export interface World3D {
  draw(pieces: readonly Piece[], layout: SceneLayout): void;
  /** Turns the town `angle` radians about the middle of its ground, as `spunProjection` does. */
  turn(angle: number): void;
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

/** Throws when the browser has no WebGL, so the caller can keep the flat drawing. */
export function createWorld3D(canvas: HTMLCanvasElement): World3D {
  const renderer = new WebGLRenderer({canvas, antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new Scene(), camera = new OrthographicCamera();
  // Turns about the middle of the ground; the town inside it sits with that middle at the origin.
  const spin = new Group();
  scene.add(spin);
  let town: Group | null = null, layout: SceneLayout | null = null, width = 0, height = 0;
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
  return {
    draw(pieces, next) {
      clear();
      town = buildTown(pieces, next);
      town.position.set(-next.cols, 0, -next.rows);
      spin.add(town);
      layout = next;
      fit();
      render();
    },
    turn(angle) { turnTo(spin, angle); render(); },
    dispose() { resize.disconnect(); clear(); renderer.dispose(); },
  };
}
