import { TOWN_MAP_SPAN } from '@tokentracky/core';

/** The public map's camera: the plot at the middle of the canvas and each plot's size in CSS pixels. */
export interface MapView {cx: number; cy: number; cell: number}
export interface Area {x0: number; y0: number; x1: number; y1: number}

const MAX_CELL = 48;
/** The smallest plot size that keeps the whole canvas within one request's area. */
export const minCell = (width: number, height: number) => Math.max(6, Math.ceil(Math.max(width, height) / (TOWN_MAP_SPAN - 8)));
export const clampCell = (cell: number, width: number, height: number) => Math.min(MAX_CELL, Math.max(minCell(width, height), cell));
/** The view with plots big enough for a canvas of this size; the same view when they already are. */
export const fitView = (view: MapView, width: number, height: number): MapView => {
  const cell = clampCell(view.cell, width, height);
  return cell === view.cell ? view : {...view, cell};
};

/** The plot under a point on the canvas. */
export function cellAt(view: MapView, width: number, height: number, px: number, py: number): [number, number] {
  return [Math.floor(view.cx + (px - width / 2) / view.cell), Math.floor(view.cy + (py - height / 2) / view.cell)];
}
/** A plot's top-left corner on the canvas. */
export function screenOf(view: MapView, width: number, height: number, x: number, y: number): [number, number] {
  return [width / 2 + (x - view.cx) * view.cell, height / 2 + (y - view.cy) * view.cell];
}
/** Zooms by `factor` keeping the plot under (px, py) where it is. */
export function zoomAt(view: MapView, factor: number, width: number, height: number, px: number, py: number): MapView {
  const cell = clampCell(view.cell * factor, width, height);
  const fx = view.cx + (px - width / 2) / view.cell, fy = view.cy + (py - height / 2) / view.cell;
  return {cell, cx: fx - (px - width / 2) / cell, cy: fy - (py - height / 2) / cell};
}
/** The plots on screen. */
export function visibleArea(view: MapView, width: number, height: number): Area {
  const [x0, y0] = cellAt(view, width, height, 0, 0);
  const [x1, y1] = cellAt(view, width, height, width, height);
  return {x0, y0, x1, y1};
}
/** What to fetch for a view: the visible plots plus a margin, never wider than one request allows. */
export function fetchArea(view: MapView, width: number, height: number): Area {
  const v = visibleArea(view, width, height);
  const grow = (lo: number, hi: number): [number, number] => {
    const margin = Math.max(0, Math.floor((TOWN_MAP_SPAN - 1 - (hi - lo)) / 2));
    const extra = Math.min(margin, 12);
    return [lo - extra, Math.min(hi + extra, lo - extra + TOWN_MAP_SPAN - 1)];
  };
  const [x0, x1] = grow(v.x0, v.x1);
  const [y0, y1] = grow(v.y0, v.y1);
  return {x0, y0, x1, y1};
}
/** True when `inner` lies inside `outer`. */
export const within = (inner: Area, outer: Area) => inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
