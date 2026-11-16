import { useLayoutEffect, useRef, type RefObject } from "react";
import { animationsDisabled } from "@/lib/animations/animations-disabled";
import { intArraysEqual } from "@/lib/utils";

const ROW_SELECTOR = '[data-nav-type="feature"][data-nav-id]';
const DURATION_MS = 180;

function measureRows(container: HTMLElement): Map<string, number> {
  const tops = new Map<string, number>();
  for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.dataset.navId) tops.set(row.dataset.navId, row.getBoundingClientRect().top);
  }
  return tops;
}

/**
 * FLIP-animates conversation rows inside `containerRef` when the displayed id
 * order changes, so a re-sort reads as rows sliding into place rather than the
 * list jumping. The "before" positions are read during the render that changes
 * the order — the last moment the old layout is still in the DOM. That read is
 * idempotent (a StrictMode double render sees the order already recorded) and
 * only happens on an actual reorder, which is throttled upstream.
 */
export function useReorderAnimation(
  containerRef: RefObject<HTMLElement | null>,
  orderedIds: readonly number[],
): void {
  const idsRef = useRef(orderedIds);
  const beforeRef = useRef<Map<string, number> | null>(null);
  if (!intArraysEqual(idsRef.current, orderedIds)) {
    idsRef.current = orderedIds;
    const container = containerRef.current;
    beforeRef.current = container && !animationsDisabled() ? measureRows(container) : null;
  }

  useLayoutEffect(() => {
    const before = beforeRef.current;
    beforeRef.current = null;
    const container = containerRef.current;
    if (!before || !container) return;
    // Read every position first, then start animations, to avoid interleaved reflows.
    const after = measureRows(container);
    const moves: [HTMLElement, number][] = [];
    for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const id = row.dataset.navId;
      const previousTop = id ? before.get(id) : undefined;
      const nextTop = id ? after.get(id) : undefined;
      if (previousTop === undefined || nextTop === undefined) continue;
      if (Math.abs(previousTop - nextTop) >= 1) moves.push([row, previousTop - nextTop]);
    }
    for (const [row, delta] of moves) {
      row.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
        duration: DURATION_MS,
        easing: "ease-out",
      });
    }
  });
}
