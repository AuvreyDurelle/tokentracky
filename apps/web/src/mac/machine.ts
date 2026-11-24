import { createContext, useContext } from 'react';
import type { ShellState } from '../api';

/** How the pages name the computer and where the app's icon sits: `this ${name}`, `your ${name}`, `the ${bar}`. */
export interface Machine {
  /** `Mac`, `PC` or `computer`. */
  name: string;
  /** `menu bar` or `tray`. */
  bar: string;
}

/** The words for the app's platform: a Mac and its menu bar, a PC or another computer and its tray. Without an app
 *  shell (the CLI's dashboard, in a browser on any system) it is a computer. */
export function machine(shell: ShellState | null): Machine {
  switch (shell?.platform) {
    case 'macos': return { name: 'Mac', bar: 'menu bar' };
    case 'windows': return { name: 'PC', bar: 'tray' };
    default: return { name: 'computer', bar: 'tray' };
  }
}

/** Given once at the root, from the shell state read before the first page renders. */
export const MachineContext = createContext<Machine>(machine(null));

export const useMachine = (): Machine => useContext(MachineContext);
