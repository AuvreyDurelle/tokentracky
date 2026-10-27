import { useEffect, useState, type DependencyList } from 'react';

export interface Load<T> { value: T | null; error: unknown; loading: boolean }

/** Runs `load` whenever `deps` change, after `delay` ms (for typing). A reload keeps the last value until it answers; null `load` clears it. */
export function useLoad<T>(load: (() => Promise<T>) | null, deps: DependencyList, delay = 0): Load<T> {
  const [state, setState] = useState<Load<T>>({ value: null, error: null, loading: load !== null });
  useEffect(() => {
    if (!load) { setState({ value: null, error: null, loading: false }); return; }
    let live = true;
    setState((last) => ({ ...last, loading: true }));
    const timer = window.setTimeout(() => load().then(
      (value) => { if (live) setState({ value, error: null, loading: false }); },
      (error: unknown) => { if (live) setState((last) => ({ value: last.value, error, loading: false })); },
    ), delay);
    return () => { live = false; window.clearTimeout(timer); };
  }, deps);
  return state;
}
