/**
 * Token Town's shared vocabulary: what the hosted API returns and what the app and website draw. The rules that price
 * and grow a town live with the hosted API; this file holds only names, shapes and the map's fixed terrain.
 */

/** Bricks from every token, Power from output tokens, Water from input and cache writes, Crystals from reasoning. */
export const RESOURCE_IDS = ['power', 'bricks', 'water', 'crystals'] as const;
export type ResourceId = (typeof RESOURCE_IDS)[number];
export type Resources = Record<ResourceId, number>;
/** A price: only the resources it takes. */
export type Cost = Partial<Resources>;

export const BUILDING_IDS = ['town-hall', 'power-plant', 'brickworks', 'reservoir', 'observatory', 'data-center', 'vault', 'market',
  'workshop', 'park', 'tavern', 'arena', 'statue', 'museum', 'token-tower'] as const;
export type BuildingId = (typeof BUILDING_IDS)[number];
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export type BuildingGroup = 'make' | 'store' | 'special' | 'decor' | 'wonder';

export const BUILDINGS: Record<BuildingId, {name: string; rarity: Rarity; group: BuildingGroup}> = {
  'town-hall': {name: 'Town Hall', rarity: 'common', group: 'special'},
  'power-plant': {name: 'Power Plant', rarity: 'common', group: 'make'},
  brickworks: {name: 'Brickworks', rarity: 'common', group: 'make'},
  reservoir: {name: 'Reservoir', rarity: 'common', group: 'store'},
  observatory: {name: 'Observatory', rarity: 'rare', group: 'make'},
  'data-center': {name: 'Data Center', rarity: 'epic', group: 'make'},
  vault: {name: 'Vault', rarity: 'rare', group: 'store'},
  market: {name: 'Market', rarity: 'rare', group: 'special'},
  workshop: {name: 'Tool Workshop', rarity: 'common', group: 'special'},
  park: {name: 'Park', rarity: 'common', group: 'decor'},
  tavern: {name: 'Night Owl Tavern', rarity: 'rare', group: 'special'},
  arena: {name: 'Arena', rarity: 'epic', group: 'special'},
  statue: {name: 'Statue', rarity: 'common', group: 'decor'},
  museum: {name: 'Museum', rarity: 'common', group: 'special'},
  'token-tower': {name: 'Token Tower', rarity: 'legendary', group: 'wonder'},
};

/** One line of what an upgrade changes, such as Power from output +60% → +70%. */
export interface TownEffect {label: string; from: number; to: number; unit: 'percent' | 'count'}
/** The next level of a building: its price and what it changes. Paying raises it at once; `blocked` says why it can't be raised yet. */
export interface TownUpgrade {cost: Cost; effects: TownEffect[]; blocked: string | null}
/** A finished building on a plot. `next` is null at the top level. */
export interface TownBuilding {id: string; kind: BuildingId; x: number; y: number; level: number; next: TownUpgrade | null}
/** One card in the build menu: today's price for another copy, which stands as soon as it is paid, and why it is locked or full. */
export interface TownCatalogueEntry {kind: BuildingId; description: string; cost: Cost; owned: number; limit: number | null; locked: string | null}
/** Uncollected harvest: tokens uploaded since the last collect, converted at today's bonuses. */
export interface TownHarvest {resources: Resources; tokens: number; since: string | null; streak: number; multiplier: number}

/** `GET /api/town/me`: the signed-in member's own town. */
export interface TownSelf {
  alias: string;
  /** The Town Hall's level. */
  level: number;
  wallet: Resources;
  caps: Resources;
  harvest: TownHarvest;
  /** Bonus on each resource's harvest from buildings, in percent. */
  bonuses: Resources;
  plots: TownPlot[];
  buildings: TownBuilding[];
  nextPlot: {number: number; cost: Cost};
  move: {cost: Cost};
  /** Bricks a day at the last 14 days' pace, for "about 6 days of coding". */
  bricksPerDay: number;
  /** Bricks per Water at the Market, when the town has one. */
  trade: {rate: number} | null;
  catalogue: TownCatalogueEntry[];
  /** Why the town can't collect, claim or build right now (a profile under review), or null. */
  paused: string | null;
  now: string;
}
export interface TownPlot {x: number; y: number}
/** `GET /api/town/u/:alias`: someone's town, read-only, with the profile's likes and current streak for its card. */
export interface TownPublic {alias: string; level: number; plots: TownPlot[]; buildings: Array<{kind: BuildingId; x: number; y: number; level: number}>;
  rarest: BuildingId | null; likes: number; streak: number}
/** A town on the public map. A hidden member's land shows with no name. */
export interface TownMapTown {alias: string | null; level: number; plots: number; wonder: boolean}
/**
 * `GET /api/town/map?x0&y0&x1&y1`: claimed plots in view, each as `[x, y, index into towns]`. `edge` is the outermost
 * claimed ring, `max(|x|, |y|)`; new and moving towns land just past it. `featured` is the biggest named town anywhere
 * on the map, wherever the area is: most plots, then the higher Town Hall, then the older town, at its Town Hall.
 */
export interface TownMapResponse {x0: number; y0: number; x1: number; y1: number; towns: TownMapTown[]; plots: Array<[number, number, number]>;
  wonders: Array<[number, number]>; totals: {towns: number; plots: number}; edge: number; featured: {alias: string; x: number; y: number} | null}

/** The widest map area one request may cover, in plots per side. */
export const TOWN_MAP_SPAN = 160;

export type Terrain = 'land' | 'water' | 'forest';
const hash = (x: number, y: number, seed: number) => {
  // A murmur-style finaliser over the mixed coordinates, so neighbouring lattice points are unrelated.
  let h = Math.imul(x ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(y ^ 0x61c88647, 0x27d4eb2f) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Smooth value noise in [0, 1): neighbouring plots get similar values, so water and forest form patches. */
const noise = (x: number, y: number, scale: number, seed: number) => {
  const gx = Math.floor(x / scale), gy = Math.floor(y / scale);
  const ease = (t: number) => t * t * (3 - 2 * t);
  const u = ease(x / scale - gx), v = ease(y / scale - gy);
  const a = hash(gx, gy, seed), b = hash(gx + 1, gy, seed), c = hash(gx, gy + 1, seed), d = hash(gx + 1, gy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
/** The map's fixed ground. Water can't be claimed; forest is ordinary land with trees. The middle of the map is dry. */
export function terrainAt(x: number, y: number): Terrain {
  if (Math.max(Math.abs(x), Math.abs(y)) <= 4) return 'land';
  if (noise(x, y, 7, 1) < 0.2) return 'water';
  return noise(x, y, 5, 2) > 0.72 ? 'forest' : 'land';
}
