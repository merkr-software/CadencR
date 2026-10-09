import { useSyncExternalStore } from "react";

/**
 * Primary pointer can't hover — phones and tablets. Distinct from
 * `useIsMobile`, which is a viewport-width breakpoint: a narrow desktop window
 * still has a mouse and a right-click.
 */
const TOUCH_QUERY = "(hover: none)";

// One shared MediaQueryList for every consumer (see `useIsMobile`).
const mql = window.matchMedia(TOUCH_QUERY);

function subscribe(onChange: () => void): () => void {
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return mql.matches;
}

/** `true` when the primary input is touch (no hover, no right-click). */
export function useIsTouchDevice(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
