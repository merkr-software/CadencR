/**
 * A `useSyncExternalStore` source for one CSS media query. The MediaQueryList
 * is created on first read and shared by every consumer: `getSnapshot` runs on
 * each render, so allocating a fresh `matchMedia` per call would be needless
 * churn.
 */
export interface MediaQueryStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean;
}

export function mediaQueryStore(query: string): MediaQueryStore {
  let mql: MediaQueryList | null = null;
  const list = (): MediaQueryList => {
    mql ??= window.matchMedia(query);
    return mql;
  };
  return {
    subscribe: (onChange) => {
      const current = list();
      current.addEventListener("change", onChange);
      return () => current.removeEventListener("change", onChange);
    },
    getSnapshot: () => list().matches,
  };
}
