import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ListRange, VirtuosoHandle } from "react-virtuoso";
import { useScrollParentOffsetSync } from "@/hooks/useScrollParentOffsetSync";

export function useVirtualFeatureFocus(
  featureIds: readonly number[],
  rootRef: RefObject<HTMLDivElement | null>,
  virtuosoRef: RefObject<VirtuosoHandle | null>,
  indexAttribute: string,
): { focusIndex: (index: number) => void; handleRangeChanged: (range: ListRange) => void } {
  const pendingFeatureIdRef = useRef<number | null>(null);
  useEffect(() => {
    const featureId = pendingFeatureIdRef.current;
    if (featureId == null) return;
    const index = featureIds.indexOf(featureId);
    if (index < 0) pendingFeatureIdRef.current = null;
    else virtuosoRef.current?.scrollIntoView({ index, align: "center" });
  }, [featureIds, virtuosoRef]);
  const focusIndex = useCallback(
    (index: number): void => {
      const mounted = rootRef.current?.querySelector<HTMLElement>(
        `[${indexAttribute}="${index}"] [data-nav-item]`,
      );
      if (mounted) {
        mounted.focus({ focusVisible: true } as FocusOptions);
        return;
      }
      pendingFeatureIdRef.current = featureIds[index] ?? null;
      virtuosoRef.current?.scrollToIndex({ index, align: "center" });
    },
    [featureIds, indexAttribute, rootRef, virtuosoRef],
  );
  const handleRangeChanged = useCallback(
    (range: ListRange): void => {
      const featureId = pendingFeatureIdRef.current;
      if (featureId == null) return;
      const index = featureIds.indexOf(featureId);
      if (index < 0) {
        pendingFeatureIdRef.current = null;
        return;
      }
      if (index < range.startIndex || index > range.endIndex) return;
      pendingFeatureIdRef.current = null;
      requestAnimationFrame(() => {
        rootRef.current
          ?.querySelector<HTMLElement>(`[${indexAttribute}="${index}"] [data-nav-item]`)
          ?.focus({ focusVisible: true } as FocusOptions);
      });
    },
    [featureIds, indexAttribute, rootRef],
  );
  return useMemo(() => ({ focusIndex, handleRangeChanged }), [focusIndex, handleRangeChanged]);
}

export function useMeasuredActiveRange(
  activeIndex: number,
  activeKey: unknown,
  virtuosoRef: RefObject<VirtuosoHandle | null>,
  onRangeChanged: (range: ListRange) => void,
  revealKey: unknown,
): (range: ListRange) => void {
  const pendingActiveIndexRef = useRef<number | null>(activeIndex >= 0 ? activeIndex : null);
  const lastActiveKeyRef = useRef<unknown>(Symbol("uninitialized-active-key"));
  const lastRevealKeyRef = useRef<unknown>(Symbol("uninitialized-reveal-key"));
  const armedActiveKeyRef = useRef<unknown>(activeKey);
  useEffect(() => {
    if (
      !Object.is(lastActiveKeyRef.current, activeKey) ||
      !Object.is(lastRevealKeyRef.current, revealKey)
    ) {
      lastActiveKeyRef.current = activeKey;
      lastRevealKeyRef.current = revealKey;
      armedActiveKeyRef.current = activeKey;
    }
    if (!Object.is(armedActiveKeyRef.current, activeKey) || activeIndex < 0) return;
    armedActiveKeyRef.current = Symbol("revealed-active-key");
    pendingActiveIndexRef.current = activeIndex;
    virtuosoRef.current?.scrollToIndex({ index: activeIndex, align: "center" });
  }, [activeIndex, activeKey, revealKey, virtuosoRef]);
  return useCallback(
    (range: ListRange): void => {
      onRangeChanged(range);
      const pendingIndex = pendingActiveIndexRef.current;
      if (pendingIndex == null) return;
      if (pendingIndex >= range.startIndex && pendingIndex <= range.endIndex) {
        pendingActiveIndexRef.current = null;
        return;
      }
      virtuosoRef.current?.scrollToIndex({ index: pendingIndex, align: "center" });
    },
    [onRangeChanged, virtuosoRef],
  );
}

interface SidebarNavigateDetail {
  direction: "up" | "down";
  handled: boolean;
}

/**
 * Moves the sidebar's up/down keyboard navigation through a virtualized list
 * (`cadencr-sidebar-navigate`, see useSidebarKeyboardNavigation): from the
 * focused row to the next one in `featureIndexes`, mounting it if needed, or
 * into the list from its first or last row.
 */
export function useVirtualListNavigation(
  rootRef: RefObject<HTMLDivElement | null>,
  featureIndexes: readonly number[],
  focusIndex: (index: number) => void,
  indexAttribute: string,
): void {
  const handleNavigate = useCallback(
    (event: Event): void => {
      const { detail, target } = event as CustomEvent<SidebarNavigateDetail>;
      const row =
        target === rootRef.current
          ? null
          : (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
              `[${indexAttribute}]`,
            );
      if (!row || !rootRef.current?.contains(row)) {
        const boundary =
          detail.direction === "down"
            ? featureIndexes[0]
            : featureIndexes[featureIndexes.length - 1];
        if (boundary == null) return;
        detail.handled = true;
        focusIndex(boundary);
        return;
      }
      const position = featureIndexes.indexOf(Number(row.getAttribute(indexAttribute)));
      const next = featureIndexes[position + (detail.direction === "down" ? 1 : -1)];
      if (next == null) return;
      detail.handled = true;
      focusIndex(next);
    },
    [featureIndexes, focusIndex, indexAttribute, rootRef],
  );
  useEffect(() => {
    const root = rootRef.current;
    root?.addEventListener("cadencr-sidebar-navigate", handleNavigate);
    return () => root?.removeEventListener("cadencr-sidebar-navigate", handleNavigate);
  }, [handleNavigate, rootRef]);
}

/**
 * A sidebar virtual list's plumbing: the scroll parent (the sidebar's scroll
 * area), keyboard navigation, revealing the open row and re-measuring when
 * content above the list resizes. `rowIds` holds each entry's conversation
 * id, null for a header; `reveal` brings the open conversation into view.
 */
export function useSidebarVirtualList(
  rowIds: readonly (number | null)[],
  activeFeatureId: number | null,
  reveal: boolean,
  indexAttribute: string,
) {
  const featureIds = useMemo(() => rowIds.map((id, index) => id ?? -index - 1), [rowIds]);
  const featureIndexes = useMemo(
    () => rowIds.flatMap((id, index) => (id === null ? [] : [index])),
    [rowIds],
  );
  const revealIndex = reveal && activeFeatureId !== null ? rowIds.indexOf(activeFeatureId) : -1;
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const virtualFocus = useVirtualFeatureFocus(featureIds, rootRef, virtuosoRef, indexAttribute);
  const handleRangeChanged = useMeasuredActiveRange(
    revealIndex,
    activeFeatureId,
    virtuosoRef,
    virtualFocus.handleRangeChanged,
    scrollParent,
  );
  useVirtualListNavigation(rootRef, featureIndexes, virtualFocus.focusIndex, indexAttribute);
  useScrollParentOffsetSync(rootRef, scrollParent);
  const wrapperRef = useCallback((element: HTMLDivElement | null): void => {
    rootRef.current = element;
    setScrollParent(element?.closest<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null);
  }, []);
  return { wrapperRef, rootRef, virtuosoRef, scrollParent, revealIndex, handleRangeChanged };
}
