import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { hydratePreloadedConversation } from "@/lib/conversation-preload";
import { scheduleIdle, scheduleIdleAfter } from "@/lib/schedule-idle";
import {
  activateFeatureTab,
  getFocusedTab,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { subscribeWorkspacePrewarm } from "./workspace-prewarm";
import {
  WORKSPACE_POOL_LIMIT,
  dropPrewarm,
  dropWorkspace,
  prewarmWorkspace,
  trimWorkspacePool,
  type WorkspacePoolState,
  type WorkspaceTarget,
} from "./workspace-pool-state";

type SetPool = (update: (state: WorkspacePoolState) => WorkspacePoolState) => void;

/** How long the pool may wait for an idle main thread before unmounting anyway. */
const UNMOUNT_DEADLINE_MS = 2_000;

/**
 * How long a workspace mounted on a press waits for the click that shows it. A
 * press that became a drag, or was released elsewhere, is dropped after this.
 */
export const PREWARM_HOLD_MS = 2_000;

/** Unmounting a workspace is real work: it waits for an idle main thread. */
export function useTrimWhenIdle(pool: WorkspacePoolState, setState: SetPool): void {
  const overflow = pool.recency.length > WORKSPACE_POOL_LIMIT;
  useEffect(() => {
    if (!overflow) return undefined;
    return scheduleIdle(
      () =>
        startTransition(() => setState((state) => trimWorkspacePool(state, WORKSPACE_POOL_LIMIT))),
      { timeout: UNMOUNT_DEADLINE_MS },
    );
  }, [overflow, setState]);
}

/**
 * Mounts the workspace a pressed sidebar row asks for (`requestWorkspacePrewarm`),
 * hidden, and drops it if no click shows it within `PREWARM_HOLD_MS`.
 *
 * What was preloaded for it goes into the stores right away, so it mounts with
 * its transcript; the mount itself is a transition, so it does not run inside
 * the press. A click that comes first mounts it synchronously as it shows it.
 */
export function usePrewarmRequests(prewarmed: string | null, setState: SetPool): void {
  useEffect(
    () =>
      subscribeWorkspacePrewarm((target) => {
        hydratePreloadedConversation(target.featureId);
        startTransition(() => setState((state) => prewarmWorkspace(state, target)));
      }),
    [setState],
  );
  useEffect(() => {
    if (prewarmed === null) return undefined;
    return scheduleIdleAfter(
      PREWARM_HOLD_MS,
      () => startTransition(() => setState((state) => dropPrewarm(state, prewarmed))),
      { timeout: UNMOUNT_DEADLINE_MS },
    );
  }, [prewarmed, setState]);
}

/**
 * A conversation that is deleted or archived has its session removed from the
 * store. Its hidden workspace must go with it, or it would sit on a dead
 * session and reload a conversation that no longer exists.
 */
export function useDropClosedWorkspaces(
  pool: WorkspacePoolState,
  activeId: string | null,
  setState: SetPool,
): void {
  const latest = useRef({ entries: pool.entries, activeId });
  useLayoutEffect(() => {
    latest.current = { entries: pool.entries, activeId };
  });
  // A workspace creates its session entry in its first effect: only an entry
  // that was seen and is gone means "closed", never one that is not there yet.
  const [connected] = useState(() => new Set<string>());
  useEffect(() => {
    const dropClosed = (sessions: Record<string, unknown>): void => {
      // A workspace that left the pool starts over if it comes back: until its
      // new mount creates the entry, a missing one does not mean "closed".
      const mounted = new Set(latest.current.entries.map((entry) => entry.sessionId));
      for (const sessionId of connected) if (!mounted.has(sessionId)) connected.delete(sessionId);
      const closed: string[] = [];
      for (const { sessionId } of latest.current.entries) {
        if (sessionId in sessions) connected.add(sessionId);
        else if (connected.has(sessionId) && sessionId !== latest.current.activeId) {
          closed.push(sessionId);
        }
      }
      if (closed.length === 0) return;
      for (const sessionId of closed) connected.delete(sessionId);
      setState((state) => closed.reduce(dropWorkspace, state));
    };
    // The workspace just hidden may have been closed while it was on screen.
    dropClosed(useWsSessionStore.getState().sessions);
    return useWsSessionStore.subscribe((store, previous) => {
      if (store.sessions !== previous.sessions) dropClosed(store.sessions);
    });
  }, [activeId, connected, setState]);
}

/**
 * Applies the tab a navigation asks for (`WorkspaceTarget.focusTab`, usually
 * the one focused in the conversation being left) each time a workspace is
 * shown. The workspace reads the request only when it mounts; a workspace
 * that was already mounted gets it from here, without its entry changing.
 * A layout that is not in the store yet gets it as soon as it arrives.
 */
export function useApplyFocusRequest(target: WorkspaceTarget | null): void {
  const sessionId = target?.sessionId;
  const featureId = target?.featureId;
  const focusTab = target?.focusTab;
  useLayoutEffect(() => {
    if (featureId === undefined || focusTab === undefined) return undefined;
    const apply = (): boolean => {
      const layout = useFeatureLayoutStore.getState().features[featureId];
      if (layout === undefined) return false;
      if (getFocusedTab(layout) !== focusTab) activateFeatureTab(featureId, focusTab);
      return true;
    };
    if (apply()) return undefined;
    let waiting = true;
    const unsubscribe = useFeatureLayoutStore.subscribe(() => {
      if (!waiting || !apply()) return;
      waiting = false;
      unsubscribe();
    });
    return () => {
      waiting = false;
      unsubscribe();
    };
  }, [sessionId, featureId, focusTab]);
}

/** Floating layers Radix portals to `<body>`: popovers, menus, non-modal dialogs. */
const OPEN_LAYER_SELECTOR =
  "[data-radix-popper-content-wrapper], [role='dialog'][data-state='open'], [role='menu'][data-state='open']";

/**
 * The control a floating layer opened from, while that layer is open. Popup
 * triggers only (popover, dialog, menu, select and context-menu triggers carry
 * `aria-haspopup`): a disclosure control (`aria-expanded` alone, a tool summary
 * or a fold button) opens no layer.
 */
const OPEN_TRIGGER_SELECTOR =
  "[aria-haspopup][aria-expanded='true'], [aria-haspopup][data-state='open']";

function slotOwnsOpenLayer(root: HTMLElement | null, sessionId: string): boolean {
  if (root === null || document.querySelector(OPEN_LAYER_SELECTOR) === null) return false;
  const slot = Array.from(root.children).find(
    (child) => child.getAttribute("data-workspace-session") === sessionId,
  );
  return slot?.querySelector(OPEN_TRIGGER_SELECTOR) != null;
}

/**
 * A whole primary-button press on `<body>`: `pointerdown`, then `click`. Layers
 * that dismiss on the pointerdown are gone when the click arrives; those that
 * defer their outside press (`deferPointerDownOutside`: Radix popovers and
 * dialogs) only arm a listener on the pointerdown and dismiss on the click.
 */
function replayOutsidePress(): void {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

/**
 * A popover or menu left open in the workspace being hidden is portaled to
 * `<body>`: it would float over the next conversation while acting on the
 * previous one. A switch made with the pointer already dismissed it (the press
 * was outside it); one made from the keyboard or programmatically did not, so
 * a whole outside press (`replayOutsidePress`) is replayed for the layers to
 * dismiss themselves.
 *
 * Only when a layer is open and the slot just hidden (`data-workspace-session`)
 * holds the open popup trigger it came from: a layer of the app shell or the
 * sidebar (a root dialog, a popover being typed in) stays open across a switch.
 */
export function useDismissLayersOnSwitch(
  activeId: string | null,
  rootRef: RefObject<HTMLElement | null>,
): void {
  const previousIdRef = useRef(activeId);
  useLayoutEffect(() => {
    const hiddenId = previousIdRef.current;
    if (hiddenId === activeId) return;
    previousIdRef.current = activeId;
    if (hiddenId !== null && slotOwnsOpenLayer(rootRef.current, hiddenId)) replayOutsidePress();
  }, [activeId, rootRef]);
}
