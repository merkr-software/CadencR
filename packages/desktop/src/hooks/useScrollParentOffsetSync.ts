import { useEffect, type RefObject } from "react";

type ListRef = RefObject<HTMLElement | null>;

/** Each list's last offset in the scroll content, undefined until first measured. */
interface ScrollContentWatch {
  observer: ResizeObserver;
  lists: Map<ListRef, number | undefined>;
}

/** One observer per scroll parent, however many lists it holds. */
const watches = new WeakMap<HTMLElement, ScrollContentWatch>();

function watchScrollContent(scrollParent: HTMLElement, content: Element): ScrollContentWatch {
  const existing = watches.get(scrollParent);
  if (existing) return existing;
  const lists = new Map<ListRef, number | undefined>();
  // Resize callbacks run after layout, so these reads never force a reflow;
  // they all happen before the one write (the replayed scroll).
  const observer = new ResizeObserver(() => {
    const contentTop = scrollParent.getBoundingClientRect().top - scrollParent.scrollTop;
    let moved = false;
    for (const [ref, lastOffset] of lists) {
      if (!ref.current) continue;
      const offset = ref.current.getBoundingClientRect().top - contentTop;
      if (offset === lastOffset) continue;
      lists.set(ref, offset);
      moved = true;
    }
    if (moved) scrollParent.dispatchEvent(new Event("scroll"));
  });
  observer.observe(content);
  const watch = { observer, lists };
  watches.set(scrollParent, watch);
  return watch;
}

/**
 * Virtuoso with a `customScrollParent` re-reads the list's offset only on the
 * parent's scroll or resize and the list's own resize, so content above it
 * resizing leaves the rows it brings into view blank. Replays a `scroll` on
 * the parent when a list's offset in the scroll content (the Radix viewport's
 * single child) changes. Radix shows its scrollbar only when `scrollTop`
 * changes, so the synthetic event stays invisible.
 */
export function useScrollParentOffsetSync(
  listRef: ListRef,
  scrollParent: HTMLElement | null,
): void {
  useEffect(() => {
    const content = scrollParent?.firstElementChild;
    if (!scrollParent || !content) return;
    const watch = watchScrollContent(scrollParent, content);
    watch.lists.set(listRef, undefined);
    return () => {
      watch.lists.delete(listRef);
      if (watch.lists.size > 0) return;
      watch.observer.disconnect();
      watches.delete(scrollParent);
    };
  }, [listRef, scrollParent]);
}
