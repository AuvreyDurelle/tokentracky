import { describe, expect, it } from 'vitest';
import type { Publication } from '@tokentracky/core';
import { aliasFromHandle, draftFromPublication, publicationRequest, weekStart } from './publication';

describe('publication request', () => {
  it('sends only the alias, with no consent, history or sharing fields', () => {
    expect(draftFromPublication(null)).toEqual({ alias: '' });
    expect(publicationRequest({ alias: 'signal_1' })).toEqual({ alias: 'signal_1' });
  });

  it('loads a saved publication as its name alone, so a save never sends its sharing fields back', () => {
    const publication: Publication = { alias: 'builder-one', historyStart: '2026-10-01T00:00:00.000Z', shareTools: false, shareCost: false, shareModels: false, generation: 'internal' };
    expect(draftFromPublication(publication)).toEqual({ alias: 'builder-one' });
    expect(publicationRequest(draftFromPublication(publication))).toEqual({ alias: 'builder-one' });
  });

  it.each(['', 'ab', '-lead', 'has space', 'x'.repeat(31)])('rejects the alias %j before sending', (alias) => {
    expect(() => publicationRequest({ alias })).toThrow('Alias must contain');
  });

  it.each([
    ['2026-10-26T00:15:00+02:00', '2026-10-19'],
    ['2026-10-25T23:15:00-02:00', '2026-10-26'],
    ['2026-01-01T10:00:00Z', '2025-12-29'],
  ])('uses UTC week boundaries for %s', (time, expected) => {
    expect(weekStart(new Date(time))).toBe(expected);
  });
});

describe('name from a sign-in handle', () => {
  it('keeps valid handles and makes others into valid names, or gives none', () => {
    expect(aliasFromHandle('EXAMPLE-BUILDER')).toBe('EXAMPLE-BUILDER');
    expect(aliasFromHandle('jane.doe')).toBe('jane-doe');
    expect(aliasFromHandle('_hidden')).toBe('hidden');
    expect(aliasFromHandle('x'.repeat(40))).toBe('x'.repeat(30));
    expect(aliasFromHandle('ab')).toBeNull();
    expect(aliasFromHandle('..')).toBeNull();
    expect(aliasFromHandle(undefined)).toBeNull();
    expect(aliasFromHandle(42)).toBeNull();
  });
});
