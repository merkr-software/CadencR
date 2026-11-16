import { useLayoutEffect, useRef, type RefObject } from "react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";

// The window has one set of lights, so every mounted anchor reports here and
// the latest one laid out wins. Flushing once per microtask turns a route
// change (old header's cleanup, new header's mount) into a single move.
const centers = new Map<object, number | null>();
let sent: number | null = null;
let flushQueued = false;
// A header that unmounts while still active is a page change, and the next
// page's header may still be loading (lazy route): wait for it rather than
// sending the lights home and back.
const UNMOUNT_SETTLE_MS = 250;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  flushQueued = false;
  if (settleTimer !== undefined) return;
  let next: number | null = null;
  for (const center of centers.values()) if (center !== null) next = center;
  if (next === sent) return;
  sent = next;
  desktopBridge.setTrafficLightsCenter(next).catch((error: unknown) => {
    toast.error(`Could not move the window controls: ${apiErrorMessage(error, String(error))}`);
  });
}

function report(anchor: object, center: number | null | undefined, settle = false): void {
  if (center === undefined) centers.delete(anchor);
  else centers.set(anchor, center);
  clearTimeout(settleTimer);
  settleTimer = settle
    ? setTimeout(() => {
        settleTimer = undefined;
        flush();
      }, UNMOUNT_SETTLE_MS)
    : undefined;
  if (settle || flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

/**
 * While `active`, centers the macOS traffic lights on `ref`'s vertical center,
 * so they share a centerline with the header row it sits in whatever that
 * row's height (page, theme, a title with a subtitle). The header keeps its
 * expanded height; the lights move to it, not the other way round. Re-measures
 * when the row resizes, and restores the system position once no anchor is
 * active. An anchor with no layout box (a hidden page) never places them.
 */
export function useTrafficLightsAnchor(ref: RefObject<HTMLElement | null>, active: boolean): void {
  const activeRef = useRef(active);
  activeRef.current = active;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const anchor = {};
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      const laidOut = element.getClientRects().length > 0;
      report(anchor, laidOut ? rect.top + rect.height / 2 : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element.parentElement ?? element);
    return () => {
      observer.disconnect();
      // Still active here means unmounting, not the sidebar expanding.
      report(anchor, undefined, activeRef.current);
    };
  }, [active, ref]);
}
