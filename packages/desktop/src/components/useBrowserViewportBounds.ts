import { useCallback, useRef } from "react";

import {
  useWorkspaceActivity,
  type WorkspaceActivity,
} from "@/components/workspace-pool/workspace-activity";
import { desktopBridge } from "@/lib/desktop-bridge";
import { subscribeZoomApplied } from "@/lib/zoom-coordinator";

interface ViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boundsFromElement(node: HTMLDivElement): ViewportBounds {
  const rect = node.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

function sameBounds(a: ViewportBounds | null, b: ViewportBounds): boolean {
  return a?.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

const NO_BOUNDS: ViewportBounds = { x: 0, y: 0, width: 0, height: 0 };

interface BoundsTrackerOptions {
  onBounds: (bounds: ViewportBounds) => void;
  /**
   * The workspace the placeholder lives in. One kept mounted but hidden
   * (`WorkspacePool`) keeps its layout, so the placeholder keeps its size: its
   * native view would stay on screen, over the workspace that is shown. While
   * hidden it reports no bounds, exactly as an unmounted placeholder does.
   */
  activity?: WorkspaceActivity;
}

export interface BrowserViewportBoundsTracker {
  attach: (node: HTMLDivElement | null) => void;
  dispose: () => void;
}

export function createBrowserViewportBoundsTracker(
  options: BoundsTrackerOptions,
): BrowserViewportBoundsTracker {
  let nodeRef: HTMLDivElement | null = null;
  let observer: ResizeObserver | null = null;
  let unsubscribeZoomApplied: (() => void) | null = null;
  let unsubscribeActivity: (() => void) | null = null;
  let frame: number | null = null;
  let lastBounds: ViewportBounds | null = null;

  const cancelFrame = (): void => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };
  const shown = (): boolean => options.activity?.isActive() ?? true;
  const sync = (): void => {
    frame = null;
    const node = nodeRef;
    if (!node) return;
    const nextBounds = shown() ? boundsFromElement(node) : NO_BOUNDS;
    if (sameBounds(lastBounds, nextBounds)) return;
    lastBounds = nextBounds;
    options.onBounds(nextBounds);
  };
  const scheduleSync = (): void => {
    if (frame !== null) return;
    frame = requestAnimationFrame(sync);
  };
  const resyncBounds = (): void => {
    lastBounds = null;
    scheduleSync();
  };
  const removeViewListeners = (): void => {
    const view = nodeRef?.ownerDocument.defaultView;
    view?.removeEventListener("resize", scheduleSync);
    view?.removeEventListener("scroll", scheduleSync, true);
    unsubscribeZoomApplied?.();
    unsubscribeZoomApplied = null;
    unsubscribeActivity?.();
    unsubscribeActivity = null;
  };
  const disconnect = (): void => {
    observer?.disconnect();
    observer = null;
    removeViewListeners();
    cancelFrame();
  };
  const attach = (node: HTMLDivElement | null): void => {
    disconnect();
    nodeRef = node;
    lastBounds = null;
    if (!node) {
      options.onBounds(NO_BOUNDS);
      return;
    }
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(scheduleSync);
      observer.observe(node);
    }
    scheduleSync();
    const view = node.ownerDocument.defaultView;
    view?.addEventListener("resize", scheduleSync);
    view?.addEventListener("scroll", scheduleSync, true);
    unsubscribeZoomApplied = subscribeZoomApplied(resyncBounds);
    // Hidden: gone in the same task as the switch, not a frame later, so the
    // view never shows over the next workspace. Shown: measured on the frame.
    unsubscribeActivity =
      options.activity?.subscribe(() => {
        if (shown()) {
          resyncBounds();
          return;
        }
        cancelFrame();
        sync();
      }) ?? null;
  };
  const dispose = (): void => {
    disconnect();
  };

  return { attach, dispose };
}

export function useBrowserViewportBounds(
  scopeId: number,
  onError: (error: unknown) => void,
): (node: HTMLDivElement | null) => void {
  const trackerRef = useRef<BrowserViewportBoundsTracker | null>(null);
  const activity = useWorkspaceActivity();

  return useCallback(
    (node: HTMLDivElement | null): void => {
      trackerRef.current?.dispose();
      trackerRef.current = createBrowserViewportBoundsTracker({
        activity,
        onBounds: (bounds) => {
          void desktopBridge.setBrowserBounds(bounds, scopeId).catch(onError);
        },
      });
      trackerRef.current.attach(node);
    },
    [activity, onError, scopeId],
  );
}
