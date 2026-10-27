import { BADGE_IDS } from '@tokentracky/core';
import { describe, expect, it } from 'vitest';
import { ACHIEVEMENT_COPY, TIER_NAMES, formatBadgeValue, rarityText } from './achievement-copy';

describe('achievement copy', () => {
  it('names, describes and measures every badge', () => {
    for (const id of BADGE_IDS) {
      expect(ACHIEVEMENT_COPY[id]?.name, id).toBeTruthy();
      expect(ACHIEVEMENT_COPY[id]?.description, id).toBeTruthy();
      expect(ACHIEVEMENT_COPY[id]?.unit, id).toBeTruthy();
    }
    expect(Object.keys(ACHIEVEMENT_COPY)).toHaveLength(BADGE_IDS.length);
    expect(ACHIEVEMENT_COPY['token-titan'].name).toBe('Token Titan');
    expect(ACHIEVEMENT_COPY['weekend-warrior'].name).toBe('Weekend Warrior');
  });
  it('names the four tiers after none', () => {
    expect(TIER_NAMES).toEqual(['None', 'Bronze', 'Silver', 'Gold', 'Diamond']);
  });
  it('shows rarity as a share of builders', () => {
    expect(rarityText(42, 1000)).toBe('4.2% of builders');
    expect(rarityText(500, 1000)).toBe('50% of builders');
    expect(rarityText(0, 1000)).toBe('0% of builders');
    expect(rarityText(1, 30_000)).toBe('<0.1% of builders');
    expect(rarityText(0, 0)).toBeNull();
  });
  it('writes each measure in its own unit', () => {
    expect(formatBadgeValue('token-titan', 18_400_000_000)).toBe('18.4B');
    expect(formatBadgeValue('big-day', 10_000_000)).toBe('10M');
    expect(formatBadgeValue('streak', 1)).toBe('1 day');
    expect(formatBadgeValue('marathoner', 30)).toBe('30 days');
    expect(formatBadgeValue('weekend-warrior', 5)).toBe('5 weekend days');
    expect(formatBadgeValue('momentum', 250)).toBe('2.5×');
    expect(formatBadgeValue('momentum', 0)).toBe('0×');
    expect(formatBadgeValue('podium', 42)).toBe('#42');
    expect(formatBadgeValue('podium', 0)).toBe('Unranked');
    expect(formatBadgeValue('multitool', 1)).toBe('1 tool');
    expect(formatBadgeValue('polyglot', 15)).toBe('15 models');
  });
});
