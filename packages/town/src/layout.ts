import { terrainAt, type TownPlot } from '@tokentracky/core';
import { TILE_H, TILE_W } from './art.ts';

/** What a plot in view is: yours, free to claim, someone else's (by index into the map's towns), or open ground. */
export type PlotKind = {kind: 'own'} | {kind: 'claimable'} | {kind: 'other'; town: number} | {kind: 'water'} | {kind: 'forest'} | {kind: 'free'};

export const plotKey = (x: number, y: number) => `${x},${y}`;
/** The side of a plot that touches another along an edge. */
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Classifies a plot. `others` maps claimed plots that aren't yours to their town's index. */
export function plotKind(x: number, y: number, own: ReadonlySet<string>, others: ReadonlyMap<string, number>): PlotKind {
  const key = plotKey(x, y);
  if (own.has(key)) return {kind: 'own'};
  const town = others.get(key);
  if (town !== undefined) return {kind: 'other', town};
  const terrain = terrainAt(x, y);
  if (terrain === 'water') return {kind: 'water'};
  if (own.size && SIDES.some(([dx, dy]) => own.has(plotKey(x + dx, y + dy)))) return {kind: 'claimable'};
  return terrain === 'forest' ? {kind: 'forest'} : {kind: 'free'};
}

/** The scene's window onto the map: which plots it shows and where the projection puts them. */
export interface SceneLayout {
  /** The back corner plot. */
  x0: number; y0: number;
  cols: number; rows: number;
  /** Projection origin for tile (0, 0), and the drawing's size. */
  originX: number; originY: number; width: number; height: number;
}
const PAD_X = 70;
const PAD_TOP = 210;
const PAD_BOTTOM = 150;
/**
 * A window that holds every plot with a ring of neighbours around it, at least `minimum` plots a side so a new town
 * still sits in a neighbourhood.
 */
export function sceneLayout(plots: readonly TownPlot[], minimum = 6): SceneLayout {
  const xs = plots.map(p => p.x), ys = plots.map(p => p.y);
  const span = (lo: number, hi: number) => {
    const size = Math.max(minimum, hi - lo + 3);
    const start = Math.floor((lo + hi) / 2 - (size - 1) / 2);
    return [start, size] as const;
  };
  const [x0, cols] = span(Math.min(...xs), Math.max(...xs));
  const [y0, rows] = span(Math.min(...ys), Math.max(...ys));
  const nx = cols * 2, ny = rows * 2;
  return {x0, y0, cols, rows, originX: PAD_X + ny * TILE_W / 2, originY: PAD_TOP, width: PAD_X * 2 + (nx + ny) * TILE_W / 2, height: PAD_TOP + (nx + ny) * TILE_H / 2 + PAD_BOTTOM};
}
/** The tile coordinates of a plot's back corner in the scene. */
export const plotTile = (layout: SceneLayout, x: number, y: number): [number, number] => [(x - layout.x0) * 2, (y - layout.y0) * 2];
/** Plots in the window, back to front, so later ones draw over earlier ones. */
export function plotsBackToFront(layout: SceneLayout): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let sum = 0; sum <= layout.cols + layout.rows - 2; sum++) {
    for (let i = 0; i < layout.cols; i++) {
      const j = sum - i;
      if (j >= 0 && j < layout.rows) out.push([layout.x0 + i, layout.y0 + j]);
    }
  }
  return out;
}
