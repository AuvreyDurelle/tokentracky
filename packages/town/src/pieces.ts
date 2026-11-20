import type { BuildingId, TownMapResponse } from '@tokentracky/core';
import { hash } from './art.ts';
import { plotKey, plotTile, plotsBackToFront, type PlotKind, type SceneLayout } from './layout.ts';

/** Colours for other towns, picked by name so a town has the same colour in the scene and on the map. */
const PALETTE = ['#ffa25e', '#4fe0c4', '#ff7aa8', '#b69cff', '#6fb8ff', '#a8e06a', '#f08de0', '#ff9f7a', '#7ad7ff', '#ffd36b'];
export function townColour(alias: string | null): string {
  if (alias === null) return '#6c6890';
  let h = 0;
  for (const c of alias) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
const GROUND: Record<PlotKind['kind'], [string, string]> = {own: ['#3b6b53', '#386650'], claimable: ['#283f41', '#263c3e'], free: ['#22383a', '#203538'],
  forest: ['#1f3a33', '#1d362f'], other: ['#2a4442', '#284140'], water: ['#172856', '#1a2c5c']};

/**
 * One thing on the town's land, in tile coordinates (a plot is 2×2 tiles). The flat drawing and the 3D scene both draw
 * from the same list, so they always show the same town.
 */
export type Piece =
  | {type: 'tile'; x: number; y: number; colour: string}
  | {type: 'ripple'; x: number; y: number}
  | {type: 'border'; a: [number, number]; b: [number, number]; colour: string; own: boolean}
  | {type: 'building'; kind: BuildingId; x: number; y: number; level: number}
  | {type: 'house'; x: number; y: number; roof: string; variant: number}
  | {type: 'tree'; x: number; y: number; size: number; pine: boolean}
  | {type: 'lamp'; x: number; y: number};

export interface TownLand {
  layout: SceneLayout;
  kindAt: (x: number, y: number) => PlotKind;
  buildings: ReadonlyArray<{kind: BuildingId; x: number; y: number; level: number}>;
  map: TownMapResponse | null;
}

/** Ground, borders, neighbours' homes, trees and every building, plot by plot from back to front. */
export function townPieces({layout, kindAt, buildings, map}: TownLand): Piece[] {
  const out: Piece[] = [];
  const built = new Map(buildings.map(b => [plotKey(b.x, b.y), b]));
  for (const [x, y] of plotsBackToFront(layout)) {
    const kind = kindAt(x, y);
    const [tx, ty] = plotTile(layout, x, y);
    const colours = GROUND[kind.kind];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) out.push({type: 'tile', x: tx + i, y: ty + j, colour: colours[(tx + ty + i + j) % 2]!});
    const h = hash(x, y);
    if (kind.kind === 'water') {
      if (h % 3 === 0) out.push({type: 'ripple', x: tx + 1, y: ty + 1});
      continue;
    }
    // Borders: yours glow gold, a neighbour's take their colour.
    const owner = kind.kind === 'own' ? 'own' : kind.kind === 'other' ? `t${kind.town}` : null;
    if (owner) {
      const same = (ax: number, ay: number) => { const k = kindAt(ax, ay); return owner === 'own' ? k.kind === 'own' : k.kind === 'other' && `t${k.town}` === owner; };
      const colour = owner === 'own' ? '#ffe08a' : townColour(kind.kind === 'other' ? map?.towns[kind.town]?.alias ?? null : null);
      const d = owner === 'own' ? 0.06 : 0.1, x0 = tx, y0 = ty, x1 = tx + 2, y1 = ty + 2;
      const sides: Array<[[number, number], [number, number]]> = [];
      if (!same(x, y - 1)) sides.push([[x0 + d, y0 + d], [x1 - d, y0 + d]]);
      if (!same(x, y + 1)) sides.push([[x0 + d, y1 - d], [x1 - d, y1 - d]]);
      if (!same(x - 1, y)) sides.push([[x0 + d, y0 + d], [x0 + d, y1 - d]]);
      if (!same(x + 1, y)) sides.push([[x1 - d, y0 + d], [x1 - d, y1 - d]]);
      for (const [a, b] of sides) out.push({type: 'border', a, b, colour, own: owner === 'own'});
    }
    const building = built.get(plotKey(x, y));
    if (building) out.push({type: 'building', kind: building.kind, x: tx, y: ty, level: building.level});
    if (kind.kind === 'other') out.push({type: 'house', x: tx, y: ty, roof: townColour(map?.towns[kind.town]?.alias ?? null), variant: h % 3});
    if (kind.kind === 'forest' || (kind.kind === 'free' && h % 4 === 0)) {
      out.push({type: 'tree', x: tx + 0.2 + (h % 5) / 10, y: ty + 0.1, size: 0.85, pine: h % 2 === 0}, {type: 'tree', x: tx + 0.9, y: ty + 0.8 + (h % 3) / 10, size: 0.8, pine: h % 3 === 0});
      if (kind.kind === 'forest') out.push({type: 'tree', x: tx + 0.2, y: ty + 1, size: 0.75, pine: true});
    }
    if (kind.kind === 'own' && !building && h % 2 === 0) out.push({type: 'lamp', x: tx + 1.85, y: ty + 1.85});
  }
  return out;
}
