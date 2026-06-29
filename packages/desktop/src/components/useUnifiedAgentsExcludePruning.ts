import { useEffect, useRef } from "react";

/** How often the `/exclude:` filter is re-evaluated. The match-against-`/last`
 *  check is client-side and time-based, so an excluded agent silently ages out
 *  of the window between fetches — pruning keeps the filter small over time. */
const PRUNE_INTERVAL_MS = 60_000;

/** Every minute, recompute the excluded titles via `pruneExcludedTitles` and
 *  push the (possibly smaller) set back through `setExcludedTitles`. Both
 *  callbacks are read from refs so the interval is installed once and always
 *  sees the latest agents/filters. */
export function useUnifiedAgentsExcludePruning(
  pruneExcludedTitles: () => string[],
  setExcludedTitles: (titles: string[]) => void,
): void {
  const pruneRef = useRef(pruneExcludedTitles);
  pruneRef.current = pruneExcludedTitles;
  const setRef = useRef(setExcludedTitles);
  setRef.current = setExcludedTitles;

  useEffect((): (() => void) => {
    const timer = window.setInterval((): void => {
      setRef.current(pruneRef.current());
    }, PRUNE_INTERVAL_MS);
    return (): void => window.clearInterval(timer);
  }, []);
}
