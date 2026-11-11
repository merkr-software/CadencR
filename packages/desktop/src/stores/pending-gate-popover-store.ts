import { create } from "zustand";
import type { SidebarSurface } from "@/stores/sidebar-surface-store";

/**
 * Where a quick reply shows: next to a row of one sidebar surface (the same
 * conversation can render in the rail, "For me" and the tree at once), or the
 * bottom sheet that phones, and a desktop with no row on screen, use.
 */
export type GatePopoverSurface = SidebarSurface | "sheet";

/**
 * "auto": opened by a new request. It behaves like a notification card and
 * outlives outside clicks. "user": opened by a click, tap, shortcut or the
 * queue's arrows; it takes focus, and an outside click closes it. "hover":
 * opened by pointing at the icon; closed by an outside click like "user", but
 * it never takes focus, and, like "auto", it is no hand-off that moves on to
 * the next request after an answer.
 */
export type GatePopoverOrigin = "auto" | "user" | "hover";

export interface OpenGatePopover {
  featureId: number;
  surface: GatePopoverSurface;
  origin: GatePopoverOrigin;
  /** A display options preview sample: nothing live backs it. */
  preview: boolean;
}

interface PendingGatePopoverState {
  /** The one quick reply on screen: at most one, whatever the surface. */
  open: OpenGatePopover | null;
  /** Requests the user closed: they never auto-open again, remounts included. */
  dismissedRequestIds: ReadonlySet<string>;
  /** Requests that turned out to be plans, which get no quick reply. */
  planRequestIds: ReadonlySet<string>;
  openGate: (target: Omit<OpenGatePopover, "preview"> & { preview?: boolean }) => void;
  /** Closes the quick reply and, given the request it showed, remembers it was dismissed. */
  closeGate: (dismissedRequestId?: string | null) => void;
  /** Closes the quick reply on `featureId`/`surface` without dismissing its request. */
  releaseGate: (featureId: number, surface: GatePopoverSurface) => void;
  markPlanRequest: (requestId: string, isPlan: boolean) => void;
}

/** Old dismissals can't matter: request ids rotate. Bounds the set's growth. */
const MAX_REMEMBERED_IDS = 200;

function withMember(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (set.has(id)) return set;
  const next = new Set(set).add(id);
  if (next.size > MAX_REMEMBERED_IDS) {
    const oldest = next.values().next().value;
    if (oldest !== undefined) next.delete(oldest);
  }
  return next;
}

/** What had focus when the user opened a quick reply: where focus goes back on close. */
let focusBeforeUserOpen: HTMLElement | null = null;

function rememberFocus(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  focusBeforeUserOpen = active instanceof HTMLElement && active !== document.body ? active : null;
}

/** The element to return focus to once a user-opened quick reply closes; consumed once. */
export function takeFocusBeforeUserOpen(): HTMLElement | null {
  const target = focusBeforeUserOpen;
  focusBeforeUserOpen = null;
  return target;
}

export const usePendingGatePopoverStore = create<PendingGatePopoverState>((set) => ({
  open: null,
  dismissedRequestIds: new Set(),
  planRequestIds: new Set(),
  openGate: ({ featureId, surface, origin, preview = false }) =>
    set((state) => {
      const current = state.open;
      if (origin === "user" && current?.origin !== "user") rememberFocus();
      if (
        current?.featureId === featureId &&
        current.surface === surface &&
        current.origin === origin &&
        current.preview === preview
      ) {
        return state;
      }
      return { open: { featureId, surface, origin, preview } };
    }),
  closeGate: (dismissedRequestId) =>
    set((state) => {
      const dismissed = dismissedRequestId
        ? withMember(state.dismissedRequestIds, dismissedRequestId)
        : state.dismissedRequestIds;
      if (state.open === null && dismissed === state.dismissedRequestIds) return state;
      return { open: null, dismissedRequestIds: dismissed };
    }),
  releaseGate: (featureId, surface) =>
    set((state) =>
      state.open?.featureId === featureId && state.open.surface === surface
        ? { open: null }
        : state,
    ),
  markPlanRequest: (requestId, isPlan) =>
    set((state) => {
      if (state.planRequestIds.has(requestId) === isPlan) return state;
      if (isPlan) return { planRequestIds: withMember(state.planRequestIds, requestId) };
      const next = new Set(state.planRequestIds);
      next.delete(requestId);
      return { planRequestIds: next };
    }),
}));

/** The origin of the quick reply open on this row's surface, else null. */
export function useGatePopoverOriginOn(
  featureId: number,
  surface: GatePopoverSurface,
): GatePopoverOrigin | null {
  return usePendingGatePopoverStore((state) =>
    state.open?.featureId === featureId && state.open.surface === surface
      ? state.open.origin
      : null,
  );
}

/**
 * Whether a new request may take the screen: nothing is open, or only an
 * automatic or hovered one (the user's own, focused, is never replaced).
 */
export function useCanAutoOpenGate(): boolean {
  return usePendingGatePopoverStore((state) => state.open === null || state.open.origin !== "user");
}

/** Names a request for dismissal; one without an id is named by its conversation. */
export function gateRequestKey(featureId: number, requestId: string | null): string {
  return requestId ?? `feature:${featureId}`;
}
