import { describe, expect, it } from 'vitest';
import type { ShellState } from '../api';
import { machine } from './machine';

const shell = (platform: ShellState['platform']): ShellState => ({ launchAtLogin: false, update: { state: 'idle', version: null }, version: '1.0.0', platform });

describe('machine', () => {
  it('names a Mac and its menu bar, a PC and its tray, and any other computer and its tray', () => {
    expect(machine(shell('macos'))).toEqual({ name: 'Mac', bar: 'menu bar' });
    expect(machine(shell('windows'))).toEqual({ name: 'PC', bar: 'tray' });
    expect(machine(shell('linux'))).toEqual({ name: 'computer', bar: 'tray' });
  });
  it('says computer without an app shell, as in the CLI’s dashboard', () => {
    expect(machine(null)).toEqual({ name: 'computer', bar: 'tray' });
  });
});
