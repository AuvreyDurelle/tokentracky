import type { BuildingId, TownMapResponse, TownPublic, TownSelf } from '@tokentracky/core';
import type { Area } from './map-view.ts';

/**
 * What the town screens need from a host: the website calls the hosted API with the member's sign-in, the app calls its
 * local API, which forwards with the computer's credential. Failures reject with an Error whose message is shown.
 */
export interface TownApi {
  me(): Promise<TownSelf>;
  collect(): Promise<TownSelf>;
  claim(x: number, y: number): Promise<TownSelf>;
  build(kind: BuildingId, x: number, y: number): Promise<TownSelf>;
  upgrade(buildingId: string): Promise<TownSelf>;
  cancel(jobId: string): Promise<TownSelf>;
  move(): Promise<TownSelf>;
  trade(water: number): Promise<TownSelf>;
  map(area: Area): Promise<TownMapResponse>;
  town(alias: string): Promise<TownPublic>;
  /** Likes, when the host can like profiles. */
  liked?(alias: string): Promise<boolean>;
  like?(alias: string, liked: boolean): Promise<void>;
}
