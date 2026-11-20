import { describe, expect, it } from 'vitest';
import { Group, Mesh, OrthographicCamera, ShaderLib, Sprite, Vector3 } from 'three';
import { BUILDING_IDS, type TownJob } from '@tokentracky/core';
import { isoProjection } from './art.ts';
import { plotKey, plotKind, sceneLayout } from './layout.ts';
import { buildTown } from './models.ts';
import { townPieces } from './pieces.ts';
import { CLICK_SLOP, atHome, dragged, glide, isDrag, releaseSpeed, wrap } from './spin.ts';
import { RISE, spunProjection } from './view.ts';
import { placeCamera, turnTo } from './world3d.ts';

const landOf = (plots: Array<{x: number; y: number}>) => {
  const own = new Set(plots.map(p => plotKey(p.x, p.y)));
  return {layout: sceneLayout(plots), kindAt: (x: number, y: number) => plotKind(x, y, own, new Map()), map: null};
};

describe('turning the town', () => {
  const layout = sceneLayout([{x: 0, y: 0}, {x: 9, y: 0}]);
  const flat = isoProjection(layout.originX, layout.originY);

  it('draws the flat isometric view before it turns', () => {
    for (const [x, y, z] of [[0, 0, 0], [3.3, 7.1, 40], [layout.cols * 2, layout.rows * 2, -26]] as const) {
      const [a, b] = [spunProjection(layout, 0)(x, y, z), flat(x, y, z)];
      expect(a[0]).toBeCloseTo(b[0], 9);
      expect(a[1]).toBeCloseTo(b[1], 9);
    }
  });
  it('turns about the middle of the ground and comes back after a whole turn', () => {
    expect(spunProjection(layout, 1.2)(layout.cols, layout.rows)).toEqual(flat(layout.cols, layout.rows));
    const [a, b] = [spunProjection(layout, 2 * Math.PI)(1, 2, 5), flat(1, 2, 5)];
    expect(a[0]).toBeCloseTo(b[0]);
    expect(a[1]).toBeCloseTo(b[1]);
  });
  it('brings the back corner round to where the right corner was after a quarter turn', () => {
    const square = sceneLayout([{x: 0, y: 0}]);
    const [a, b] = [spunProjection(square, Math.PI / 2)(0, 0), isoProjection(square.originX, square.originY)(square.cols * 2, 0)];
    expect(a[0]).toBeCloseTo(b[0]);
    expect(a[1]).toBeCloseTo(b[1]);
  });
  it('keeps the 3D town exactly under the overlay at any angle and canvas size', () => {
    for (const [w, h] of [[1440, 900], [600, 900], [800, 300]] as const) for (const angle of [0, 0.7, -2.4]) {
      const camera = new OrthographicCamera();
      placeCamera(camera, layout, w, h);
      camera.updateMatrixWorld();
      const spin = new Group();
      turnTo(spin, angle);
      spin.updateMatrixWorld();
      // The overlay is an SVG with the layout's viewBox, fitted into the canvas's box.
      const k = Math.min(w / layout.width, h / layout.height), left = (w - layout.width * k) / 2, top = (h - layout.height * k) / 2;
      for (const [x, y, z] of [[0, 0, 0], [5, 9, 60], [layout.cols * 2, 1, -26]] as const) {
        const ndc = new Vector3(x - layout.cols, z / RISE, y - layout.rows).applyMatrix4(spin.matrixWorld).project(camera);
        const [px, py] = spunProjection(layout, angle)(x, y, z);
        expect((ndc.x + 1) / 2 * w).toBeCloseTo(left + px * k, 4);
        expect((1 - ndc.y) / 2 * h).toBeCloseTo(top + py * k, 4);
      }
    }
  });
});

describe('spinning by hand', () => {
  const layout = sceneLayout([{x: 0, y: 0}]);
  const front = (angle: number) => spunProjection(layout, angle)(layout.cols * 2, layout.rows * 2)[0];

  it('treats a press that barely moves as a click', () => {
    expect(isDrag(3, 3)).toBe(false);
    expect(isDrag(CLICK_SLOP + 1, 0)).toBe(true);
  });
  it('carries the front of the town the way you drag, once round every 800 pixels', () => {
    expect(front(dragged(0, 30))).toBeGreaterThan(front(0));
    expect(front(dragged(0, -30))).toBeLessThan(front(0));
    expect(atHome(dragged(0.4, 800) - 0.4)).toBe(true);
  });
  it('glides on after a flick, halving its speed every 120 ms until it rests', () => {
    const speed = releaseSpeed([[0, 0], [16, -0.1], [32, -0.2], [48, -0.3]], 50);
    expect(speed).toBeCloseTo(-0.3 / 48);
    expect(glide(speed, 120)).toBeCloseTo(speed / 2);
    let s = speed, frames = 0;
    while (s && frames < 1000) { s = glide(s, 16); frames++; }
    expect(s).toBe(0);
    expect(frames).toBeLessThan(200);
  });
  it("doesn't glide when the pointer stopped before letting go", () => {
    expect(releaseSpeed([[0, 0], [16, 0.2]], 200)).toBe(0);
    expect(releaseSpeed([], 0)).toBe(0);
  });
  it('knows when the town faces the way it started', () => {
    expect(atHome(4 * Math.PI)).toBe(true);
    expect(atHome(0.3)).toBe(false);
    expect(wrap(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });
});

describe("the town's pieces", () => {
  it('borders only the outside edge of your land', () => {
    const pieces = townPieces({...landOf([{x: 0, y: 0}, {x: 1, y: 0}]), buildings: [], jobs: []});
    expect(pieces.filter(p => p.type === 'border' && p.own)).toHaveLength(6);
  });
  it('puts up scaffolding only where work is running', () => {
    const job = (x: number, status: TownJob['status']): TownJob => ({id: `j${x}`, action: 'build', kind: 'park', buildingId: null, x, y: 0, targetLevel: 1, status, cost: {},
      queuedAt: '', startedAt: null, readyAt: null});
    const land = landOf([{x: 0, y: 0}, {x: 1, y: 0}]);
    const pieces = townPieces({...land, buildings: [], jobs: [job(0, 'running'), job(1, 'waiting')]});
    expect(pieces.filter(p => p.type === 'scaffold')).toEqual([{type: 'scaffold', x: (0 - land.layout.x0) * 2, y: (0 - land.layout.y0) * 2}]);
  });
});

describe('the 3D town', () => {
  it('builds every building, at every level look, without a broken point', () => {
    const plots = Array.from({length: 16}, (_, i) => ({x: i % 4, y: Math.floor(i / 4)}));
    const buildings = BUILDING_IDS.map((kind, i) => ({kind, x: i % 4, y: Math.floor(i / 4), level: [1, 6, 10][i % 3]!}));
    const land = landOf(plots);
    const town = buildTown(townPieces({...land, buildings, jobs: []}), land.layout);
    let triangles = 0, sprites = 0;
    town.traverse(object => {
      if (object instanceof Sprite) { sprites++; expect(object.position.toArray().every(Number.isFinite)).toBe(true); }
      if (!(object instanceof Mesh)) return;
      const position = object.geometry.getAttribute('position'), normal = object.geometry.getAttribute('normal');
      triangles += position.count / 3;
      for (let i = 0; i < position.count; i++) {
        expect([position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)).toBe(true);
        // A face with no area has no direction to light it by.
        expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeGreaterThan(0.5);
      }
    });
    expect(triangles).toBeGreaterThan(1000);
    expect(sprites).toBeGreaterThan(20);
  });
  it("can still lift lights off the walls they hang on in this version of three's sprite shader", () => {
    expect(ShaderLib.sprite.vertexShader).toContain('mvPosition.xy += rotatedPosition;');
  });
});
