import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const BUTTON_STEP = 1.2;
/** Inline fit never shrinks text below this; wider diagrams scroll instead. */
const MIN_WIDTH_FIT = 0.75;
/** Full-screen fit may enlarge a small diagram, up to this. */
const MAX_CONTAIN_FIT = 2;

/**
 * `width`: fit the viewport's width, never enlarging (inline in a message).
 * `contain`: fit the whole diagram in the viewport (full screen).
 */
type PanZoomFit = "width" | "contain";

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export interface PanZoom {
  /** The clipping/scrolling viewport. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The element the SVG is injected into; sized to the scaled diagram. */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Inline style for the content wrapper (its scaled width/height). */
  contentStyle: React.CSSProperties;
  scale: number;
  isPanning: boolean;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

interface PanHandlers {
  isPanning: boolean;
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
}

function usePanHandlers(containerRef: RefObject<HTMLDivElement | null>): PanHandlers {
  const [isPanning, setIsPanning] = useState(false);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = useCallback((event: PointerEvent) => {
    const element = containerRef.current;
    if (!element || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    setIsPanning(true);
  }, []);
  const onPointerMove = useCallback((event: PointerEvent) => {
    const start = pan.current;
    const element = containerRef.current;
    if (!start || !element) return;
    element.scrollLeft = start.left - (event.clientX - start.x);
    element.scrollTop = start.top - (event.clientY - start.y);
  }, []);
  const onPointerUp = useCallback((event: PointerEvent) => {
    if (!pan.current) return;
    pan.current = null;
    setIsPanning(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);
  return useMemo(
    () => ({ isPanning, onPointerDown, onPointerMove, onPointerUp }),
    [isPanning, onPointerDown, onPointerMove, onPointerUp],
  );
}

interface Size {
  w: number;
  h: number;
}

function fitScale(natural: Size, container: HTMLElement | null, fit: PanZoomFit): number {
  const width = container?.clientWidth || natural.w;
  if (fit === "width") return clamp(width / natural.w, MIN_WIDTH_FIT, 1);
  const height = container?.clientHeight || natural.h;
  return clamp(Math.min(width / natural.w, height / natural.h), MIN_SCALE, MAX_CONTAIN_FIT);
}

/** The injected SVG's natural size, from its `viewBox`; re-read for each new diagram. */
function useDiagramMeasurement(
  svg: string,
  contentRef: RefObject<HTMLDivElement | null>,
): Size | null {
  const [natural, setNatural] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const box = contentRef.current?.querySelector("svg")?.viewBox?.baseVal;
    setNatural(box && box.width && box.height ? { w: box.width, h: box.height } : null);
  }, [contentRef, svg]);
  return natural;
}

function useWheelZoom(
  containerRef: RefObject<HTMLDivElement | null>,
  zoomAt: (anchorX: number, anchorY: number, factor: number) => void,
): void {
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      // Trackpad pinch arrives as a ctrl/meta-modified wheel; plain scroll
      // falls through to the viewport's native scrolling.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.01));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [containerRef, zoomAt]);
}

/**
 * Zoom + pan for an injected SVG, built on native scrolling.
 *
 * The content wrapper is given the diagram's *scaled* pixel size (read from the
 * SVG `viewBox`), so the viewport gets real scrollbars and plain two-finger
 * scrolling pans both axes. On top of that:
 * - Trackpad pinch (a `ctrl`/`meta`-modified `wheel`) zooms around the pointer.
 *   The listener is attached natively with `{ passive: false }` because React
 *   routes `onWheel` through a passive listener, so `preventDefault()` on the
 *   synthetic event is ignored.
 * - Cmd/Ctrl + drag pans by adjusting scroll offset (pointer capture keeps the
 *   drag alive when the cursor leaves the viewport).
 *
 * `svg` is passed in only so a new diagram re-measures and re-fits.
 */
export function usePanZoom(svg: string, fit: PanZoomFit = "width"): PanZoom {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  // Scroll offset to apply after a zoom commits, to keep a point anchored.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const natural = useDiagramMeasurement(svg, contentRef);
  // Re-reads the viewport on every call, so `reset` fits a resized window again.
  const computeFit = useCallback(
    () => (natural ? fitScale(natural, containerRef.current, fit) : 1),
    [natural, fit],
  );
  // Fit each newly measured diagram before it paints.
  useLayoutEffect(() => setScale(computeFit()), [computeFit]);
  const { isPanning, onPointerDown, onPointerMove, onPointerUp } = usePanHandlers(containerRef);

  // Apply the anchored scroll offset once the new scale has laid out.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
  }, [scale]);

  const zoomAt = useCallback((anchorX: number, anchorY: number, factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    setScale((prev) => {
      const next = clamp(prev * factor, MIN_SCALE, MAX_SCALE);
      if (next === prev) return prev;
      const k = next / prev;
      pendingScroll.current = {
        left: (el.scrollLeft + anchorX) * k - anchorX,
        top: (el.scrollTop + anchorY) * k - anchorY,
      };
      return next;
    });
  }, []);

  useWheelZoom(containerRef, zoomAt);

  const zoomByCenter = useCallback(
    (factor: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      zoomAt((rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2, factor);
    },
    [zoomAt],
  );

  const zoomIn = useCallback(() => zoomByCenter(BUTTON_STEP), [zoomByCenter]);
  const zoomOut = useCallback(() => zoomByCenter(1 / BUTTON_STEP), [zoomByCenter]);
  const reset = useCallback(() => {
    // Reset scroll imperatively: setScale is a no-op when already at fit, so a
    // pending-scroll approach wouldn't fire in that case.
    const el = containerRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
    setScale(computeFit());
  }, [computeFit]);

  const contentStyle = useMemo<React.CSSProperties>(
    () =>
      // `margin: auto` in the flex viewport centers a diagram smaller than the
      // viewport and falls back to 0 when it overflows, so nothing is clipped.
      natural
        ? { width: natural.w * scale, height: natural.h * scale, margin: "auto", flexShrink: 0 }
        : { width: "100%" },
    [natural, scale],
  );

  return useMemo<PanZoom>(
    () => ({
      containerRef,
      contentRef,
      contentStyle,
      scale,
      isPanning,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      zoomIn,
      zoomOut,
      reset,
    }),
    [
      contentStyle,
      scale,
      isPanning,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      zoomIn,
      zoomOut,
      reset,
    ],
  );
}
