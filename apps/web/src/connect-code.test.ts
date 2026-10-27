import { describe, expect, it, vi } from 'vitest';
import { forgetConnectCode, normalizeConnectCode, takeConnectCode } from './connect-code';
import { fillDays, formatShare, niceTicks } from './format';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } } as Storage;
}

describe('connection code hand-off', () => {
  it('accepts typed codes in any case and rejects anything else', () => {
    expect(normalizeConnectCode(' bcdfghjk ')).toBe('BCDF-GHJK');
    expect(normalizeConnectCode('BCDF-GHJK')).toBe('BCDF-GHJK');
    for (const value of ['AAAA-AAAA', 'BCDF-GHJ', '<script>', null, 42]) expect(normalizeConnectCode(value)).toBeNull();
  });
  it('takes the code from the address bar, cleans it, and survives a sign-in redirect for ten minutes', () => {
    const storage = memoryStorage(); const history = { replaceState: vi.fn() };
    expect(takeConnectCode({ href: 'https://board.example/?connect=bcdf-ghjk&x=1#top' }, history, storage, 1_000)).toBe('BCDF-GHJK');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/?x=1#top');
    expect(takeConnectCode({ href: 'https://board.example/#access_token=secret' }, history, storage, 1_000 + 9 * 60_000)).toBe('BCDF-GHJK');
    expect(takeConnectCode({ href: 'https://board.example/' }, history, storage, 1_000 + 10 * 60_000)).toBeNull();
    forgetConnectCode(storage);
    expect(takeConnectCode({ href: 'https://board.example/' }, history, storage, 2_000)).toBeNull();
  });
  it('still works in the current tab when storage is unavailable', () => {
    const broken = { setItem: () => { throw new Error('denied'); }, getItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(takeConnectCode({ href: 'https://board.example/?connect=BCDFGHJK' }, { replaceState: () => {} }, broken)).toBe('BCDF-GHJK');
    expect(takeConnectCode({ href: 'https://board.example/' }, { replaceState: () => {} }, broken)).toBeNull();
  });
});

describe('chart and ranking helpers', () => {
  it('chooses round axis steps that cover the maximum', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(950)).toEqual([0, 500, 1000]);
    expect(niceTicks(1_240_000)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
  });
  it('fills quiet UTC days with zero and keeps early data inside the rolling window', () => {
    const now = new Date('2026-10-23T09:00:00Z');
    expect(fillDays([{ day: '2026-10-21', tokens: 5 }], 3, now)).toEqual([{ day: '2026-10-21', tokens: 5 }, { day: '2026-10-22', tokens: 0 }, { day: '2026-10-23', tokens: 0 }]);
    expect(fillDays([{ day: '2026-10-20', tokens: 7 }], 3, now).map((point) => point.day)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  });
  it('formats community share without claiming a zero for tiny contributions', () => {
    expect(formatShare(0, 100)).toBe('0%');
    expect(formatShare(1, 10_000)).toBe('<0.1%');
    expect(formatShare(125, 1000)).toBe('13%');
    expect(formatShare(45, 1000)).toBe('4.5%');
  });
});
