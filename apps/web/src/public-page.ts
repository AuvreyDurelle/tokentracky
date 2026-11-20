import { useLayoutEffect } from 'react';

/** The static document stays visible while the interactive page makes its first data request. */
export function usePublicPageReady(ready: boolean) {
  useLayoutEffect(() => {
    if (ready) document.getElementById('public-page')?.remove();
  }, [ready]);
}
