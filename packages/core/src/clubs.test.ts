import { describe, expect, it } from 'vitest';
import { CLUB_MARK_IDS, CLUB_NAME_PATTERN, CLUB_SLUG_PATTERN, clubWeek, inviteCode } from './clubs.ts';

describe('clubs', () => {
  it('runs a club week from Monday 00:00 UTC to the next Monday', () => {
    expect(clubWeek(new Date('2026-11-19T15:30:00Z'))).toEqual({start: '2026-11-16T00:00:00.000Z', end: '2026-11-23T00:00:00.000Z'});
    expect(clubWeek(new Date('2026-11-16T00:00:00Z')).start).toBe('2026-11-16T00:00:00.000Z');
    expect(clubWeek(new Date('2026-11-22T23:59:59Z')).start).toBe('2026-11-16T00:00:00.000Z');
  });
  it('reads an invite code from a link or on its own', () => {
    expect(inviteCode('NIGHT-7K2Q')).toBe('NIGHT-7K2Q');
    expect(inviteCode('  night-7k2q ')).toBe('NIGHT-7K2Q');
    expect(inviteCode('https://tokentracky.com/c/night-shift?invite=NIGHT-7K2Q')).toBe('NIGHT-7K2Q');
    expect(inviteCode('tokentracky.com/c/night-shift?invite=night-7k2q')).toBe('NIGHT-7K2Q');
    expect(inviteCode('tokentracky.com/c/night-shift')).toBeNull();
    expect(inviteCode('NIGHTSHIFT-7K2Q')).toBeNull();
    expect(inviteCode('')).toBeNull();
  });
  it('accepts names and addresses people would choose, and nothing else', () => {
    for (const name of ['Night Shift', 'Cache Hit Society', 'Indie & founders', "Kai's crew", 'Équipe 9', 'AI']) expect(CLUB_NAME_PATTERN.test(name)).toBe(true);
    for (const name of ['', 'A', ' Night', '<script>', 'x'.repeat(41)]) expect(CLUB_NAME_PATTERN.test(name)).toBe(false);
    for (const slug of ['night-shift', 'ai', 'team-9']) expect(CLUB_SLUG_PATTERN.test(slug)).toBe(true);
    for (const slug of ['-night', 'night-', 'night--shift', 'Night', 'a', 'x'.repeat(41)]) expect(CLUB_SLUG_PATTERN.test(slug)).toBe(false);
  });
  it('has the eighteen marks', () => {
    expect(CLUB_MARK_IDS).toHaveLength(18);
  });
});
