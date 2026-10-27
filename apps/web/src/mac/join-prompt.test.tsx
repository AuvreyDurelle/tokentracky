import { describe, expect, it } from 'vitest';
import type { Health, LocalStatus } from '../api';
import { askToJoin } from './JoinPrompt';

const health = (cloudUrl: string | null) => ({ cloudUrl }) as Health;
const status = (cloudLinked: boolean) => ({ cloudLinked }) as LocalStatus;
const cloud = health('https://tokentracky.com');

describe('askToJoin', () => {
  it('asks a Mac that is not linked, once its status has loaded', () => {
    expect(askToJoin(null, cloud, null)).toBeNull();
    expect(askToJoin(null, cloud, status(false))).toBe(true);
  });
  it('leaves a linked Mac, and a build with no leaderboard server, alone', () => {
    expect(askToJoin(null, cloud, status(true))).toBe(false);
    expect(askToJoin(null, health(null), status(false))).toBe(false);
  });
  it('decides once per window: unlinking later, or closing it, does not ask again', () => {
    expect(askToJoin(false, cloud, status(false))).toBe(false);
    expect(askToJoin(true, cloud, status(false))).toBe(true);
  });
});
