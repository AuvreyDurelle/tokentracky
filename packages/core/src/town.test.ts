import { describe, expect, it } from 'vitest';
import { BUILDINGS, BUILDING_IDS, terrainAt } from './town.ts';

describe('town terrain', () => {
  it('is the same for a plot every time and dry in the middle of the map', () => {
    expect(terrainAt(37, -12)).toBe(terrainAt(37, -12));
    for (let x = -4; x <= 4; x++) for (let y = -4; y <= 4; y++) expect(terrainAt(x, y)).toBe('land');
  });
  it('leaves most of the map claimable, with water and forest in patches', () => {
    const counts = {land: 0, water: 0, forest: 0};
    let touching = 0;
    for (let x = -100; x < 100; x++) for (let y = -100; y < 100; y++) {
      const here = terrainAt(x, y);
      counts[here]++;
      if (here === 'water' && terrainAt(x + 1, y) === 'water') touching++;
    }
    const cells = 200 * 200;
    expect(counts.water / cells).toBeGreaterThan(0.03);
    expect(counts.water / cells).toBeLessThan(0.25);
    expect(counts.forest / cells).toBeGreaterThan(0.02);
    // Patches, not noise: most water sits next to more water.
    expect(touching / counts.water).toBeGreaterThan(0.6);
  });
  it('names every building', () => {
    expect(Object.keys(BUILDINGS).sort()).toEqual([...BUILDING_IDS].sort());
  });
});
