import { useEffect, useMemo, useRef, useState } from "react";

/**
 * How long an agent stays out of view before the composer lists it: longer
 * than the transcript's follow glide (~220 ms), whose moving rows can dip a
 * card under the bottom fade for a frame or two, than the frame a card waits
 * for the observer's first report, and than the moment between a sub-agent's
 * run arriving and its card mounting.
 */
export const LIST_AFTER_MS = 250;

const NONE: ReadonlySet<string> = new Set();

/** Joins ids into the effect's key: no provider's id holds a NUL. */
const SEPARATOR = "\u0000";

/**
 * The ids of `offScreen` that have each stayed off screen for `delayMs`. One
 * back on screen drops out at once and waits anew the next time it leaves.
 *
 * The list's height moves the transcript's bottom edge, which decides what is
 * on screen: listing at the first frame a card dips out let every transient
 * (a glide, a card not reported yet) shake the whole transcript twice, and
 * kept any loop between the two at frame rate. Adding late and dropping at
 * once bounds it to the delay.
 */
export function useSettledOffScreen(
  offScreen: readonly string[],
  delayMs: number = LIST_AFTER_MS,
): ReadonlySet<string> {
  const [settled, setSettled] = useState<ReadonlySet<string>>(NONE);
  /** When each id now off screen left it (`Date.now()`). */
  const offSinceRef = useRef(new Map<string, number>());
  const key = offScreen.join(SEPARATOR);
  useEffect(() => {
    const offSince = offSinceRef.current;
    const current = new Set(splitKey(key));
    const now = Date.now();
    for (const id of offSince.keys()) if (!current.has(id)) offSince.delete(id);
    for (const id of current) if (!offSince.has(id)) offSince.set(id, now);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      const at = Date.now();
      const due = new Set<string>();
      let next = Infinity;
      for (const [id, since] of offSince) {
        if (at - since >= delayMs) due.add(id);
        else next = Math.min(next, since + delayMs - at);
      }
      setSettled((previous) => (sameIds(previous, due) ? previous : due));
      if (next !== Infinity) timer = setTimeout(settle, next);
    };
    settle();
    return () => clearTimeout(timer);
  }, [key, delayMs]);
  // Back on screen leaves in this very render, not after the effect.
  return useMemo(() => keepOnly(settled, new Set(splitKey(key))), [key, settled]);
}

function splitKey(key: string): string[] {
  return key === "" ? [] : key.split(SEPARATOR);
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function keepOnly(ids: ReadonlySet<string>, allowed: ReadonlySet<string>): ReadonlySet<string> {
  if ([...ids].every((id) => allowed.has(id))) return ids;
  const kept = [...ids].filter((id) => allowed.has(id));
  return kept.length === 0 ? NONE : new Set(kept);
}
