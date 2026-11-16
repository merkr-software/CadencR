import { useLayoutEffect, type RefObject } from "react";

/** Reports an element's border-box height now and on every resize, so the island can fit it. */
export function useReportHeight(
  ref: RefObject<HTMLElement | null>,
  onHeight: (height: number) => void,
): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    onHeight(node.getBoundingClientRect().height);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) onHeight(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, onHeight]);
}
