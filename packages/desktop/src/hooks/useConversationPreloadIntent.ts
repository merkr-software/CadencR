import { useEffect } from "react";
import { getListProjectsQueryKey, type Project } from "@/api/generated";
import { prefetchAgentSession } from "@/components/lazy/agent-session-chunk";
import { requestWorkspacePrewarm } from "@/components/workspace-pool/workspace-prewarm";
import { preloadConversation } from "@/lib/conversation-preload";
import { queryClient } from "@/lib/queryClient";
import { idleCallbacksAvailable, scheduleIdle } from "@/lib/schedule-idle";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { ROW_SWIPE_INTENT_PX, ROW_SWIPE_TRAY_SELECTOR } from "@/hooks/useRowSwipe";
import { useSessionStatusStore } from "@/stores/session-status-store";

/** A sidebar row that opens a conversation (`ProjectFeatureRow`, `PinnedConversationRow`). */
const CONVERSATION_ROW_SELECTOR = '[data-nav-type="feature"][data-nav-id]';

/** How long after start-up (and between passes) the visible rows are preloaded. */
const SWEEP_START_DELAY_MS = 1_500;
const SWEEP_INTERVAL_MS = 20_000;
/** At most this many visible rows are preloaded per pass. */
export const SWEEP_MAX_ROWS = 30;
/** A visible idle conversation's snapshot is refetched after this long (just under its max age). */
export const IDLE_SNAPSHOT_REFRESH_MS = 4 * 60_000;
/** A press is about to become a click: any snapshot older than this is refetched. */
export const PRESS_SNAPSHOT_REFRESH_MS = 1_000;

/**
 * A press about to open a conversation: its snapshot is refreshed when older
 * than `PRESS_SNAPSHOT_REFRESH_MS`, and the conversation view's chunk is
 * fetched (the phone layout boots without it). For the sidebar rows here and
 * the phone inbox's cards.
 */
export function preloadPressedConversation(featureId: number): void {
  void prefetchAgentSession();
  void preloadConversation(featureId, PRESS_SNAPSHOT_REFRESH_MS);
}

function rowFeatureId(row: Element): number | null {
  const featureId = Number(row.getAttribute("data-nav-id"));
  return Number.isInteger(featureId) && featureId > 0 ? featureId : null;
}

/** Controls inside a row (pin, archive, ports) act on it without opening it. */
const ROW_CONTROL_SELECTOR = "button, a, input, [role='menuitem']";

/** A plain primary press on the row itself: the gesture that opens the conversation. */
function opensConversation(event: PointerEvent, row: Element): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const control =
    event.target instanceof Element ? event.target.closest(ROW_CONTROL_SELECTOR) : null;
  return control === null || !row.contains(control);
}

/**
 * Ask the workspace pool to mount the pressed row's workspace now, hidden
 * (`WorkspacePool` hydrates what was preloaded for it first): the click a
 * moment later only has to show it. The route the row navigates to is rebuilt
 * here from the same sources the row uses. No tab is requested: a press that
 * never becomes a click must not change the pressed conversation's layout.
 */
function prewarmPressedRow(row: Element, featureId: number): void {
  const projectId = Number(row.getAttribute("data-nav-project-id"));
  const project = queryClient
    .getQueryData<Project[]>(getListProjectsQueryKey())
    ?.find((candidate) => candidate.id === projectId);
  if (!project) return;
  requestWorkspacePrewarm({
    sessionId: wsSessionIdFromFeature(featureId),
    cwd: project.path,
    featureId,
    projectId,
    focusTab: undefined,
  });
}

/**
 * A touch on a row that swipes (`useRowSwipe`) may be a swipe rather than a
 * tap: its preload waits for the finger to lift where it went down. A swipe
 * or a scroll (cancelled pointer) drops it.
 */
function preloadOnTap(press: PointerEvent, featureId: number): void {
  const settle = (event: PointerEvent): void => {
    if (event.pointerId !== press.pointerId) return;
    document.removeEventListener("pointerup", settle, true);
    document.removeEventListener("pointercancel", settle, true);
    const moved = Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY);
    if (event.type === "pointerup" && moved < ROW_SWIPE_INTENT_PX) {
      preloadPressedConversation(featureId);
    }
  };
  document.addEventListener("pointerup", settle, true);
  document.addEventListener("pointercancel", settle, true);
}

/**
 * A press on a sidebar row. A plain primary mouse press mounts the row's
 * workspace and refreshes its snapshot (once the workspace hydrated it the
 * refresh skips the history request by itself; without one, the request starts
 * and the mounting workspace's loader shares it). A touch or pen press only
 * preloads: a touch scroll starts on a row too. On a row that swipes it waits
 * for a tap, and a press in the row's swipe tray runs an action, never opens
 * it. Any other mouse press does nothing: hovering the row already preloaded it.
 */
function onRowPress(event: PointerEvent): void {
  if (!(event.target instanceof Element)) return;
  const row = event.target.closest(CONVERSATION_ROW_SELECTOR);
  const featureId = row ? rowFeatureId(row) : null;
  if (row === null || featureId === null) return;
  if (event.pointerType !== "mouse") {
    if (event.target.closest(ROW_SWIPE_TRAY_SELECTOR) !== null) return;
    if (row.hasAttribute("data-row-swipe-row")) preloadOnTap(event, featureId);
    else preloadPressedConversation(featureId);
    return;
  }
  if (!opensConversation(event, row)) return;
  prewarmPressedRow(row, featureId);
  preloadPressedConversation(featureId);
}

function runningFeatureIds(): Set<number> {
  const running = new Set<number>();
  for (const entry of Object.values(useSessionStatusStore.getState().bySession)) {
    if (entry.status !== "idle") running.add(entry.featureId);
  }
  return running;
}

/** A row the user can see: in the viewport, and not in an inert subtree (a collapsed sidebar). */
function isVisibleRow(row: Element): boolean {
  if (!row.isConnected || row.closest("[inert]") !== null) return false;
  const box = row.getBoundingClientRect();
  return (
    box.height > 0 &&
    box.bottom > 0 &&
    box.top < window.innerHeight &&
    box.right > 0 &&
    box.left < window.innerWidth
  );
}

interface SweepAgents {
  /** Working now: skipped, their snapshot would be stale as soon as it lands. */
  running: ReadonlySet<number>;
  /** Working at the previous pass, idle now: refreshed whatever their snapshot's age. */
  stopped: ReadonlySet<number>;
}

/**
 * Preload the conversations of the visible rows, one per idle period, at most
 * `SWEEP_MAX_ROWS`. Calls `onDone` once the pass has gone through every row.
 * Returns its cancel function.
 */
function sweepVisibleRows({ running, stopped }: SweepAgents, onDone: () => void): () => void {
  const candidates = [...document.querySelectorAll(CONVERSATION_ROW_SELECTOR)];
  const seen = new Set<number>();
  let cursor = 0;
  let preloaded = 0;
  let cancelled = false;
  let cancel = (): void => {};
  /** The next visible row worth preloading, its visibility read in this idle period. */
  const nextFeatureId = (): number | null => {
    while (cursor < candidates.length) {
      const row = candidates[cursor];
      cursor += 1;
      const featureId = rowFeatureId(row);
      if (featureId === null || seen.has(featureId) || running.has(featureId)) continue;
      // A conversation can have several rows (pinned and in its project): any visible one counts.
      if (!isVisibleRow(row)) continue;
      seen.add(featureId);
      return featureId;
    }
    return null;
  };
  const step = (): void => {
    if (cancelled) return;
    const featureId = preloaded < SWEEP_MAX_ROWS ? nextFeatureId() : null;
    if (featureId === null) {
      onDone();
      return;
    }
    preloaded += 1;
    // Wait for the current row's prefetches to settle before scheduling the
    // next idle slice so the sweep never floods the loopback HTTP/1.1 pool.
    void preloadConversation(
      featureId,
      stopped.has(featureId) ? 0 : IDLE_SNAPSHOT_REFRESH_MS,
    ).finally(() => {
      if (!cancelled) cancel = scheduleIdle(step);
    });
  };
  cancel = scheduleIdle(step);
  return () => {
    cancelled = true;
    cancel();
  };
}

/**
 * Preloads the visible rows while the app is idle, every `SWEEP_INTERVAL_MS`.
 * A pass still going when the next one is due is left to finish; that next one
 * is skipped. Only where the browser reports idle periods: the sweep never
 * runs in busy time.
 */
function useIdleSweep(): void {
  useEffect(() => {
    if (!idleCallbacksAvailable()) return undefined;
    let wasRunning: ReadonlySet<number> = new Set();
    let cancelPass: (() => void) | null = null;
    const sweep = (): void => {
      if (document.hidden || cancelPass !== null) return;
      const running = runningFeatureIds();
      const stopped = new Set([...wasRunning].filter((featureId) => !running.has(featureId)));
      wasRunning = running;
      cancelPass = sweepVisibleRows({ running, stopped }, () => {
        cancelPass = null;
      });
    };
    const first = window.setTimeout(sweep, SWEEP_START_DELAY_MS);
    const timer = window.setInterval(sweep, SWEEP_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      cancelPass?.();
    };
  }, []);
}

/**
 * Keeps the conversations the user can reach in one gesture ready to open:
 * the visible sidebar rows are preloaded while the app is idle (skipping
 * conversations whose agent is working), and a row is refreshed and its
 * workspace mounted the moment a mouse presses it, a click's duration ahead of
 * the navigation. Hover and keyboard focus are wired on the rows themselves
 * (`useFeaturePrefetch`).
 */
export function useConversationPreloadIntent(): void {
  useEffect(() => {
    document.addEventListener("pointerdown", onRowPress, { capture: true, passive: true });
    return () => document.removeEventListener("pointerdown", onRowPress, { capture: true });
  }, []);
  useIdleSweep();
}
