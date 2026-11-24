import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export interface AnchoredZoom {
  scale: number;
  setScale: Dispatch<SetStateAction<number>>;
  /** Zoom by `factor`, keeping the point under (`anchorX`, `anchorY`) in place. */
  zoomAt: (anchorX: number, anchorY: number, factor: number) => void;
}

/**
 * A zoom level for content inside a native scrolling viewport, where the
 * content's laid-out size follows the scale (an explicit width and height, or
 * CSS `zoom`): zooming re-scrolls the viewport so the anchor point stays put,
 * once the new scale has laid out.
 */
export function useAnchoredZoom(
  containerRef: RefObject<HTMLElement | null>,
  minScale: number,
  maxScale: number,
): AnchoredZoom {
  const [scale, setScale] = useState(1);
  // Scroll offset to apply after a zoom commits, to keep a point anchored.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
  }, [containerRef, scale]);

  const zoomAt = useCallback(
    (anchorX: number, anchorY: number, factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      setScale((prev) => {
        const next = clamp(prev * factor, minScale, maxScale);
        if (next === prev) return prev;
        const k = next / prev;
        pendingScroll.current = {
          left: (el.scrollLeft + anchorX) * k - anchorX,
          top: (el.scrollTop + anchorY) * k - anchorY,
        };
        return next;
      });
    },
    [containerRef, maxScale, minScale],
  );

  return useMemo(() => ({ scale, setScale, zoomAt }), [scale, zoomAt]);
}
