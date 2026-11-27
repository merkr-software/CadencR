import { useEffect, useRef } from "react";

/** Zoom by `factor` around a point given in the element's own coordinates. */
export type ZoomAt = (anchorX: number, anchorY: number, factor: number) => void;

interface PinchBaseline {
  distance: number;
  left: number;
  top: number;
}

/** The zoom gathered since the last frame: factors multiplied, the latest anchor. */
interface PendingZoom {
  factor: number;
  x: number;
  y: number;
}

function distance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** A baseline for exactly two fingers; anything else is no pinch. */
function pinchBaseline(element: HTMLElement, touches: TouchList): PinchBaseline | null {
  const [a, b] = [touches[0], touches[1]];
  if (touches.length !== 2 || !a || !b) return null;
  // The box is read once per change of fingers, never per move.
  const rect = element.getBoundingClientRect();
  return { distance: distance(a, b), left: rect.left, top: rect.top };
}

/**
 * Two-finger pinch on `element`, reported to `zoomAt` at most once per
 * animation frame (the moves since the last frame multiplied into one
 * factor) around the fingers' midpoint. The baseline restarts whenever the
 * number of fingers changes, so a third finger, or one lifted and put back,
 * never jumps the zoom. One finger is left to the browser: the element pans
 * natively, so give it `touch-action: pan-x pan-y`, which also keeps the
 * browser from zooming the whole page on a pinch. Safari's own `gesture*`
 * events are cancelled inside the element for the same reason. Listeners are
 * non-passive only so a pinch can cancel the scroll it would otherwise start.
 * Pass the element from a callback ref: a new element is bound again.
 */
export function useTouchPinch(element: HTMLElement | null, zoomAt: ZoomAt, enabled = true): void {
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;

  useEffect(() => {
    if (!enabled || !element) return;
    let pinch: PinchBaseline | null = null;
    let pending: PendingZoom | null = null;
    let frame = 0;

    const flush = (): void => {
      frame = 0;
      const zoom = pending;
      pending = null;
      if (zoom && zoom.factor !== 1) zoomAtRef.current(zoom.x, zoom.y, zoom.factor);
    };
    const onFingersChange = (event: TouchEvent): void => {
      pinch = pinchBaseline(element, event.touches);
    };
    const onTouchMove = (event: TouchEvent): void => {
      const [a, b] = [event.touches[0], event.touches[1]];
      if (!pinch || event.touches.length !== 2 || !a || !b) return;
      event.preventDefault();
      const next = distance(a, b);
      if (pinch.distance <= 0 || next <= 0) return;
      const factor = next / pinch.distance;
      pinch.distance = next;
      pending = {
        factor: (pending?.factor ?? 1) * factor,
        x: (a.clientX + b.clientX) / 2 - pinch.left,
        y: (a.clientY + b.clientY) / 2 - pinch.top,
      };
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const cancelGesture = (event: Event): void => event.preventDefault();

    element.addEventListener("touchstart", onFingersChange, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onFingersChange, { passive: true });
    element.addEventListener("touchcancel", onFingersChange, { passive: true });
    element.addEventListener("gesturestart", cancelGesture);
    element.addEventListener("gesturechange", cancelGesture);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("touchstart", onFingersChange);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onFingersChange);
      element.removeEventListener("touchcancel", onFingersChange);
      element.removeEventListener("gesturestart", cancelGesture);
      element.removeEventListener("gesturechange", cancelGesture);
    };
  }, [element, enabled]);
}
