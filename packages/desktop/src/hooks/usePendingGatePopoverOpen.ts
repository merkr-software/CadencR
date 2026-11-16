import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useUsesGateSheet } from "@/hooks/useUsesGateSheet";
import { useSidebarSample } from "@/lib/sidebar-sample-context";
import {
  gateRequestKey,
  useCanAutoOpenGate,
  useGatePopoverOriginOn,
  usePendingGatePopoverStore,
  type GatePopoverOrigin,
  type GatePopoverSurface,
} from "@/stores/pending-gate-popover-store";
import {
  useFeaturePendingRequestId,
  useNewestQuickReplyFeatureId,
} from "@/stores/pending-gate-popover-selectors";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { isFeatureWaiting } from "@/stores/session-status-selectors";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { SidebarSurfaceContext } from "@/stores/sidebar-surface-store";

interface HoverHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

interface UsePendingGatePopoverOpenOptions {
  /** The conversation is the one open: its request is answered there, not from the sidebar. */
  isActive: boolean;
  /** The request is loaded and is not a plan: only then may it open by itself. */
  gateReady: boolean;
}

interface UsePendingGatePopoverOpenResult {
  /** This row's popover is the one open. */
  open: boolean;
  origin: GatePopoverOrigin | null;
  /** Names the request the popover shows, so closing it remembers it. */
  requestKey: string;
  /** The user's click, tap or the popover's own dismissal (X, Escape, outside click). */
  onOpenChange: (open: boolean) => void;
  close: () => void;
  /** Spread on the trigger and the content in "hover" mode; undefined otherwise. */
  hoverHandlers: HoverHandlers | undefined;
}

/** Hover intent: crossing the list doesn't open every popover on the way. */
const HOVER_OPEN_DELAY_MS = 150;
/** Time to travel from the trigger to the popover before it closes. */
const HOVER_CLOSE_DELAY_MS = 250;

/**
 * Open/close rules for a sidebar row's quick reply. The one open popover lives
 * in `pending-gate-popover-store`; a row shows it when the store names its
 * conversation and its surface.
 * - "auto" mode: the newest request opens on the surface that owns it, unless
 *   the user closed that request before, the conversation is open already, or
 *   the user has a popover of their own open. It never takes focus.
 * - "hover" opens on pointing at the icon (never taking focus), "click" on a
 *   click; both leave the newest request alone.
 * - On a phone the icon opens the bottom sheet instead, never a popover.
 * - Navigating into the conversation closes its popover.
 */
export function usePendingGatePopoverOpen(
  featureId: number,
  allowAutoOpen: boolean,
  { isActive, gateReady }: UsePendingGatePopoverOpenOptions,
): UsePendingGatePopoverOpenResult {
  const surface = useContext(SidebarSurfaceContext);
  const sample = useSidebarSample();
  const preview = sample !== null;
  const isMobile = useIsMobile();
  const usesSheet = useUsesGateSheet();
  const mode = useSidebarOption("gatePopover");
  const liveMostRecentFeatureId = useNewestQuickReplyFeatureId();
  const liveRequestId = useFeaturePendingRequestId(featureId);
  // The display options preview stages its own "newest request".
  const mostRecentFeatureId = sample ? sample.mostRecentPendingFeatureId : liveMostRecentFeatureId;
  const requestId = sample ? sample.pendingRequestId : liveRequestId;
  const requestKey = gateRequestKey(featureId, requestId);

  const origin = useGatePopoverOriginOn(featureId, surface);
  const dismissed = usePendingGatePopoverStore((s) => s.dismissedRequestIds.has(requestKey));
  const canAutoOpen = useCanAutoOpenGate();
  const shouldAutoOpen =
    allowAutoOpen &&
    mode === "auto" &&
    gateReady &&
    mostRecentFeatureId === featureId &&
    !dismissed &&
    canAutoOpen;

  useEffect(() => {
    if (!shouldAutoOpen) return;
    usePendingGatePopoverStore.getState().openGate({ featureId, surface, origin: "auto", preview });
  }, [shouldAutoOpen, featureId, surface, preview]);

  useCloseOnNavigate(featureId, isActive, requestKey);
  useReleaseOnUnmount(featureId, surface, preview);

  const sheetOrSurface: GatePopoverSurface = usesSheet ? "sheet" : surface;
  const onOpenChange = useCallback(
    (next: boolean) => {
      const store = usePendingGatePopoverStore.getState();
      if (next) store.openGate({ featureId, surface: sheetOrSurface, origin: "user", preview });
      else store.closeGate(requestKey);
    },
    [featureId, sheetOrSurface, preview, requestKey],
  );
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const hoverHandlers = useHoverOpen(featureId, surface, preview, mode === "hover" && !isMobile);
  return useMemo(
    () => ({ open: origin !== null, origin, requestKey, onOpenChange, close, hoverHandlers }),
    [origin, requestKey, onOpenChange, close, hoverHandlers],
  );
}

/**
 * Navigating into a conversation closes its quick reply (the request is
 * answered there now). Only the move counts: opening it by hand from the
 * active row stays possible afterwards.
 */
function useCloseOnNavigate(featureId: number, isActive: boolean, requestKey: string): void {
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (wasActive || !isActive) return;
    const store = usePendingGatePopoverStore.getState();
    if (store.open?.featureId === featureId) store.closeGate(requestKey);
  }, [featureId, isActive, requestKey]);
}

/**
 * A row leaving the screen (a folded project, a filter, a scroll) takes its
 * open popover along, so no state is left open with nothing showing it. A
 * request that was answered is the host's to move on from, not ours.
 */
function useReleaseOnUnmount(
  featureId: number,
  surface: GatePopoverSurface,
  preview: boolean,
): void {
  useEffect(
    () => () => {
      const store = usePendingGatePopoverStore.getState();
      if (store.open?.featureId !== featureId) return;
      // A preview sample has no live status: the host never moves it on.
      const stillWaiting =
        preview || isFeatureWaiting(useSessionStatusStore.getState().bySession, featureId);
      if (stillWaiting) store.releaseGate(featureId, surface);
    },
    [featureId, surface, preview],
  );
}

/**
 * Opens after a short hover on the trigger and closes once the pointer has
 * left both the trigger and the popover (both spread the same handlers).
 */
function useHoverOpen(
  featureId: number,
  surface: GatePopoverSurface,
  preview: boolean,
  enabled: boolean,
): HoverHandlers | undefined {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Leaving hover mode (or unmounting) drops a pending open or close.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [enabled],
  );
  return useMemo(() => {
    if (!enabled) return undefined;
    const schedule = (open: boolean, delay: number): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const store = usePendingGatePopoverStore.getState();
        // The pointer never takes over, nor closes, a quick reply the user opened.
        if (store.open?.origin === "user") return;
        if (open) store.openGate({ featureId, surface, origin: "hover", preview });
        else if (store.open?.origin === "hover") store.releaseGate(featureId, surface);
      }, delay);
    };
    return {
      onPointerEnter: () => schedule(true, HOVER_OPEN_DELAY_MS),
      onPointerLeave: () => schedule(false, HOVER_CLOSE_DELAY_MS),
    };
  }, [enabled, featureId, surface, preview]);
}
