import { TILE_W, isoProjection, type Project, type Pt } from './art.ts';
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

/** The convex hull of some points, anticlockwise on screen. */
export function hull(points: readonly Pt[]): Pt[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}
/**
 * What a building on the plot whose back tile is (tx, ty) covers on screen: its 2×2 footprint and, `height` pixels up,
 * the middle of the plot, since roofs and towers taper. A building in front takes clicks over the ground behind it.
 */
export function buildingOutline(P: Project, tx: number, ty: number, height: number): Pt[] {
  const square = (inset: number, z: number) => [P(tx + inset, ty + inset, z), P(tx + 2 - inset, ty + inset, z), P(tx + 2 - inset, ty + 2 - inset, z), P(tx + inset, ty + 2 - inset, z)];
  return hull([...square(0, 0), ...square(0.45, height)]);
}
