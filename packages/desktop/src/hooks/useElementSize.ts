import { useEffect, useState, type RefObject } from "react";

/** Wait for a resize to settle before re-laying out (and re-rendering) what it sizes. */
const RESIZE_SETTLE_MS = 120;

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Content size of `ref`, updated once a resize settles — dragging a split
 * handle fires dozens of observations, and each change re-renders everything
 * laid out from the size (every visible page, every agent card). `null` while
 * the element has no width.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize | null {
  const [size, setSize] = useState<ElementSize | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (width: number, height: number): void => {
      const next = { width: Math.round(width), height: Math.round(height) };
      setSize((previous) =>
        next.width <= 0
          ? null
          : previous?.width === next.width && previous.height === next.height
            ? previous
            : next,
      );
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      clearTimeout(timer);
      timer = setTimeout(() => update(rect?.width ?? 0, rect?.height ?? 0), RESIZE_SETTLE_MS);
    });
    observer.observe(node);
    update(node.clientWidth, node.clientHeight);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref]);
  return size;
}

export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  return useElementSize(ref)?.width ?? null;
}
