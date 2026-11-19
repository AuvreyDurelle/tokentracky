import { describe, expect, it } from 'vitest';
import { TOWN_MAP_SPAN, terrainAt } from '@tokentracky/core';
import { compact, daysToAfford, duration, paceText, shortfall } from './format.ts';
import { cellAt, clampCell, fetchArea, screenOf, visibleArea, zoomAt } from './map-view.ts';
import { plotKey, plotKind, plotsBackToFront, plotTile, sceneLayout } from './layout.ts';

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
});
