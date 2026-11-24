import { useEffect, type RefObject } from "react";

import type { TabKind } from "@/stores/feature-layout-schema";

/**
 * Keep the active tab inside a strip that overflows horizontally — a custom tab
 * added from the "+" menu lands at the end, often past the visible edge. Reads
 * layout only when the active tab or the tab count changes.
 */
export function useRevealActiveTab(
  listRef: RefObject<HTMLDivElement | null>,
  activeTabId: TabKind | null,
  tabCount: number,
): void {
  useEffect(() => {
    const list = listRef.current;
    const target = list && activeTabId ? activeTabTarget(list, activeTabId) : null;
    if (!list || !target) return;
    // Tab widths settle after fonts and badges load (any tab before it can
    // push it out), so follow every tab's size while this one is active.
    const reveal = (): void => revealInStrip(list, target);
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    for (const child of Array.from(list.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [activeTabId, listRef, tabCount]);
}

/** The active trigger's wrapper, which also holds its close button. */
function activeTabTarget(list: HTMLElement, activeTabId: TabKind): HTMLElement | null {
  const trigger = Array.from(list.querySelectorAll<HTMLElement>("[data-feature-tab-kind]")).find(
    (element) => element.dataset.featureTabKind === activeTabId,
  );
  if (!trigger) return null;
  return trigger.parentElement && trigger.parentElement !== list ? trigger.parentElement : trigger;
}

function revealInStrip(list: HTMLElement, target: HTMLElement): void {
  if (list.scrollWidth <= list.clientWidth) return;
  const listBox = list.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  if (box.left < listBox.left) list.scrollLeft -= listBox.left - box.left;
  else if (box.right > listBox.right) list.scrollLeft += box.right - listBox.right;
}
