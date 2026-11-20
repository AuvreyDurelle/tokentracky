import { TILE_W, isoProjection, type Project } from './art.ts';
import type { SceneLayout } from './layout.ts';

/**
 * The town seen from any angle round. The 3D world and the flat overlay on top of it (labels, badges, click targets) both
 * use these numbers, so they stay lined up while the town spins.
 */

/** The camera looks down at 30°, which draws a tile twice as wide as it is tall: the isometric look of the flat drawing. */
export const PITCH = Math.PI / 6;
/** Drawing pixels per tile along the ground, seen square on. */
export const UNIT = TILE_W / Math.SQRT2;
/** Drawing pixels per tile of height. The drawings measure height in pixels; the 3D world measures it in tiles. */
export const RISE = UNIT * Math.cos(PITCH);

/** The town turned `angle` radians about the middle of its ground. Angle 0 is the flat drawing's projection. */
export function spunProjection(layout: SceneLayout, angle: number): Project {
  const P = isoProjection(layout.originX, layout.originY);
  const cx = layout.cols, cy = layout.rows, cos = Math.cos(angle), sin = Math.sin(angle);
  return (x, y, z) => P(cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos, z);
}

/**
 * The orthographic camera's edges, in tiles from the middle of the ground, for a `width` × `height` canvas. They put the
 * 3D world exactly under an SVG with the layout's viewBox fitted into the same box (`preserveAspectRatio="xMidYMid meet"`).
 */
export function cameraWindow(layout: SceneLayout, width: number, height: number) {
  const k = Math.min(width / layout.width, height / layout.height);
  const [cx, cy] = isoProjection(layout.originX, layout.originY)(layout.cols, layout.rows);
  // The canvas's top-left corner, in drawing pixels.
  const x0 = (layout.width - width / k) / 2, y0 = (layout.height - height / k) / 2;
  return {left: (x0 - cx) / UNIT, right: (x0 + width / k - cx) / UNIT, top: (cy - y0) / UNIT, bottom: (cy - y0 - height / k) / UNIT};
}
