import { describe, expect, it } from 'vitest';
import { TOWN_MAP_SPAN, terrainAt } from '@tokentracky/core';
import { afterCollect, collected, compact, daysToAfford, duration, paceText, shortfall, tooBig } from './format.ts';
import { cellAt, clampCell, fetchArea, fitView, screenOf, visibleArea, within, zoomAt } from './map-view.ts';
import { plotKey, plotKind, plotsBackToFront, plotTile, sceneLayout } from './layout.ts';
import { indexMap } from './MapPage.tsx';
import { buildingOutline, hull, spunProjection, toStage } from './view.ts';
import { levelLook, type Pt } from './art.ts';

/** True when `p` lies inside the polygon. */
const inside = (poly: Pt[], [x, y]: Pt) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

describe('town numbers', () => {
  it('writes token counts and waits the way the screens show them', () => {
    expect(compact(84_200_000)).toBe('84.2M');
    expect(compact(950)).toBe('950');
    expect(compact(1_234_567_890)).toBe('1.2B');
    expect(duration(45)).toBe('45s');
    expect(duration(4320)).toBe('1h 12m');
    expect(duration(7200)).toBe('2h');
    expect(duration(183_600)).toBe('2d 3h');
  });
  it('says what is missing and how long it takes at the current pace', () => {
    expect(shortfall({power: 1284, bricks: 2310, water: 0, crystals: 0}, {power: 900, bricks: 3001})).toEqual({bricks: 691});
    expect(daysToAfford(691, 125)).toBe(6);
    expect(daysToAfford(0, 0)).toBe(0);
    expect(daysToAfford(10, 0)).toBeNull();
    expect(paceText(6)).toBe('About 6 days of coding');
    expect(paceText(0)).toBe('Ready now');
  });
  it('tells a price no store can ever hold from one that coding will pay for', () => {
    const room = {power: 7000, bricks: 17_000, water: 24_000, crystals: 300};
    expect(tooBig({bricks: 17_200}, room)).toBe('bricks');
    expect(tooBig({power: 100, crystals: 301}, room)).toBe('crystals');
    expect(tooBig({bricks: 17_000, crystals: 300}, room)).toBeNull();
  });
  it('counts only the harvest the stores have room for, as collecting does', () => {
    // 1,500 Bricks stored and 800 to collect with room for 2,000: 300 spill, so 2,000 is all there is to spend.
    expect(afterCollect({power: 10, bricks: 1500, water: 0, crystals: 0}, {power: 5, bricks: 800, water: 0, crystals: 0}, {power: 1000, bricks: 2000, water: 1000, crystals: 100}))
      .toEqual({power: 15, bricks: 2000, water: 0, crystals: 0});
  });
});

describe('how a building looks at each level', () => {
  it('adds something you can see at Lv 3, 6, 9, 10 and 15', () => {
    const looks = Array.from({length: 15}, (_, i) => JSON.stringify(levelLook(i + 1)));
    const changes = looks.flatMap((look, i) => i > 0 && look !== looks[i - 1] ? [i + 1] : []);
    expect(changes).toEqual([3, 6, 9, 10, 15]);
    expect(levelLook(1)).toEqual({litFrom: 2, pennant: null, lamps: false, glow: false, crown: false});
    expect(levelLook(15)).toEqual({litFrom: 1, pennant: '#ffc23d', lamps: true, glow: true, crown: true});
  });
});

describe('placing things over the town', () => {
  const layout = sceneLayout([{x: 0, y: 0}]);
  it('centres the drawing in a wider stage and scales it to the height', () => {
    const k = 600 / layout.height;
    expect(toStage(layout, 2000, 600, [0, 0])).toEqual({left: (2000 - layout.width * k) / 2, top: 0});
    expect(toStage(layout, 2000, 600, [layout.width, layout.height])).toEqual({left: (2000 + layout.width * k) / 2, top: 600});
  });
  it('centres it in a taller stage and scales it to the width', () => {
    const at = toStage(layout, 400, 2000, [layout.width / 2, layout.height / 2]);
    expect(at.left).toBeCloseTo(200);
    expect(at.top).toBeCloseTo(1000);
  });
});

describe('collecting at once', () => {
  it('fills the stores as the server will, spills the rest and empties the harvest', () => {
    const res = (power: number, bricks: number, water: number, crystals: number) => ({power, bricks, water, crystals});
    const town = {wallet: res(90, 10, 0, 5), caps: res(100, 100, 100, 100), harvest: {resources: res(30, 20, 0, 1), tokens: 5000, since: null, streak: 2, multiplier: 1.1}};
    const after = collected(town as unknown as Parameters<typeof collected>[0]);
    expect(after.wallet).toEqual(res(100, 30, 0, 6));
    expect(after.wallet).toEqual(afterCollect(town.wallet, town.harvest.resources, town.caps));
    expect(after.harvest.resources).toEqual(res(0, 0, 0, 0));
    expect(after.harvest.tokens).toBe(0);
    expect(after.harvest.streak).toBe(2);
  });
});

describe('the town scene', () => {
  it('shows a small town in a neighbourhood at least six plots a side, centred on it', () => {
    const layout = sceneLayout([{x: 10, y: 4}]);
    expect([layout.cols, layout.rows]).toEqual([6, 6]);
    expect(layout.x0).toBeLessThanOrEqual(9);
    expect(layout.x0 + layout.cols - 1).toBeGreaterThanOrEqual(11);
    expect(plotTile(layout, 10, 4)).toEqual([(10 - layout.x0) * 2, (4 - layout.y0) * 2]);
  });
  it('grows the window to hold a large town with a ring around it', () => {
    const layout = sceneLayout([{x: 0, y: 0}, {x: 9, y: 0}]);
    expect(layout.cols).toBe(12);
    expect(layout.x0).toBe(-1);
  });
  it('lists plots from back to front', () => {
    const order = plotsBackToFront({...sceneLayout([{x: 0, y: 0}], 2), x0: 0, y0: 0, cols: 2, rows: 2});
    expect(order).toHaveLength(4);
    expect(new Set(order.map(([x, y]) => plotKey(x, y))).size).toBe(4);
    const depths = order.map(([x, y]) => x + y);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });
  it('tells your plots, claimable ones and neighbours apart', () => {
    const own = new Set([plotKey(0, 0)]);
    const others = new Map([[plotKey(2, 0), 3]]);
    expect(plotKind(0, 0, own, others)).toEqual({kind: 'own'});
    expect(plotKind(1, 0, own, others)).toEqual({kind: 'claimable'});
    expect(plotKind(2, 0, own, others)).toEqual({kind: 'other', town: 3});
    expect(plotKind(1, 1, own, others).kind).not.toBe('claimable');
    // Far from the middle there is water that is never claimable.
    let water: [number, number] | null = null;
    for (let x = 5; x < 60 && !water; x++) if (terrainAt(x, 5) === 'water') water = [x, 5];
    expect(plotKind(water![0], water![1], new Set([plotKey(water![0] - 1, 5)]), others)).toEqual({kind: 'water'});
  });
});

describe('picking in the town', () => {
  it('wraps points in their convex hull', () => {
    expect(hull([[0, 0], [4, 0], [2, 1], [4, 4], [0, 4], [2, 2]])).toHaveLength(4);
  });
  it('lets a tall building take clicks over the ground of the plot it hides, and over its whole height at any angle', () => {
    const layout = sceneLayout([{x: 0, y: 0}, {x: 1, y: 1}]);
    for (const angle of [0, 0.4, -0.4]) {
      const P = spunProjection(layout, angle);
      const [fx, fy] = plotTile(layout, 1, 1), [bx, by] = plotTile(layout, 0, 0);
      const hall = buildingOutline(P, fx, fy, 96);
      // Facing the way it first appears, the middle of the back plot's ground sits right behind the Town Hall in front of it.
      if (angle === 0) expect(inside(hall, P(bx + 1, by + 1))).toBe(true);
      // Its own ground and its roof are both in the outline; the sky well above is not.
      expect(inside(hall, P(fx + 1, fy + 1))).toBe(true);
      expect(inside(hall, P(fx + 1, fy + 1, 90))).toBe(true);
      expect(inside(hall, P(fx + 1, fy + 1, 160))).toBe(false);
    }
  });
});

describe('indexing a map once per answer', () => {
  it('finds each town\'s outside edges and its middle', () => {
    // Town 0 holds two plots side by side; town 1 holds the plot below the first.
    const data = {x0: 0, y0: 0, x1: 4, y1: 4, plots: [[0, 0, 0], [1, 0, 0], [0, 1, 1]] as Array<[number, number, number]>,
      towns: [], wonders: [], totals: {towns: 2, plots: 3}, edge: 1, featured: null};
    const {byTown, centres, owners} = indexMap(data);
    const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8;
    expect(byTown.get(0)).toEqual([[0, 0, UP | DOWN | LEFT], [1, 0, UP | DOWN | RIGHT]]);
    expect(byTown.get(1)).toEqual([[0, 1, UP | DOWN | LEFT | RIGHT]]);
    expect(centres.get(0)).toEqual([1, 0.5]);
    expect(owners.size).toBe(3);
  });
});

describe('the public map camera', () => {
  const view = {cx: 0, cy: 0, cell: 20};
  it('finds the plot under the pointer and puts plots back where they belong', () => {
    expect(cellAt(view, 400, 300, 200, 150)).toEqual([0, 0]);
    expect(cellAt(view, 400, 300, 221, 150)).toEqual([1, 0]);
    expect(screenOf(view, 400, 300, 1, 0)).toEqual([220, 150]);
  });
  it('zooms around the pointer and keeps the zoom within limits', () => {
    const zoomed = zoomAt(view, 2, 400, 300, 300, 150);
    expect(zoomed.cell).toBe(40);
    expect(cellAt(zoomed, 400, 300, 300, 150)).toEqual(cellAt(view, 400, 300, 300, 150));
    expect(clampCell(1, 400, 300)).toBe(6);
    expect(clampCell(500, 400, 300)).toBe(48);
    expect(clampCell(6, 3000, 2000)).toBeGreaterThan(6);
  });
  it('fetches the visible plots with a margin, never more than one request allows', () => {
    const area = fetchArea(view, 400, 300);
    const visible = visibleArea(view, 400, 300);
    expect(area.x0).toBeLessThan(visible.x0);
    expect(area.x1).toBeGreaterThan(visible.x1);
    const wide = fetchArea({cx: 0, cy: 0, cell: clampCell(1, 2400, 1400)}, 2400, 1400);
    expect(wide.x1 - wide.x0).toBeLessThan(TOWN_MAP_SPAN);
  });
  it('grows the plots when the canvas grows, so what shows still fits one request', () => {
    // Zoomed right out in a small window, then the window is made wide.
    const small = {cx: 0, cy: 0, cell: clampCell(1, 600, 400)};
    expect(within(visibleArea(small, 1400, 800), fetchArea(small, 1400, 800))).toBe(false);
    const fitted = fitView(small, 1400, 800);
    expect(within(visibleArea(fitted, 1400, 800), fetchArea(fitted, 1400, 800))).toBe(true);
    expect(fitView(view, 400, 300)).toBe(view);
  });
});
