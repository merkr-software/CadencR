import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  useWorkspaceActivity,
  whileActive,
  type WorkspaceActivity,
} from "@/components/workspace-pool/workspace-activity";
import { scheduleIdleAfter } from "@/lib/schedule-idle";
import type { TabKind } from "@/stores/feature-layout-schema";

/**
 * How long a workspace kept mounted but hidden (`WorkspacePool`) keeps its side
 * panels. Past it they unmount, and the editors, language servers, terminals,
 * diffs and polls in them stop costing anything; the transcript and composer
 * stay, so going back is still instant.
 */
export const HIDDEN_SIDE_TABS_GRACE_MS = 30_000;
/** How long the close may then wait for an idle main thread. */
const CLOSE_IDLE_TIMEOUT_MS = 5_000;

/**
 * Run `callback` once the browser has painted the frame that follows this
 * call: a frame callback, then a task behind that frame's rendering. Returns
 * its cancel function.
 */
function afterNextPaint(callback: () => void): () => void {
  let timer: number | undefined;
  const frame = requestAnimationFrame(() => {
    timer = window.setTimeout(callback, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

interface DeferredWorkState {
  resetKey: string;
  ready: boolean;
}

interface UseAgentFirstNonAgentWorkOptions {
  enabled: boolean;
  immediate: boolean;
  resetKey: string;
  /**
   * Asked when a hidden workspace's close is due: `false` keeps the side tabs
   * (they hold work that would be lost) for another grace period.
   */
  canClose?: () => boolean;
}

const ALWAYS = (): boolean => true;

interface GateInputs {
  /** The gate as last committed. */
  open: boolean;
  immediate: boolean;
  canClose: () => boolean;
}

const NO_OP = (): void => {};

/**
 * Opens and closes the gate as its workspace is shown and hidden. Shown: open
 * at once for an `immediate` tab, else one paint later; a gate still open is
 * left alone, unless a close is in flight. Hidden: closed after
 * `HIDDEN_SIDE_TABS_GRACE_MS`, at idle time in a transition, unless it is
 * shown first or `canClose` says no (then one grace period later).
 */
function followWorkspace(
  activity: WorkspaceActivity,
  resetKey: string,
  setState: Dispatch<SetStateAction<DeferredWorkState>>,
  latest: { current: GateInputs },
): () => void {
  const open = (): void =>
    setState((current) =>
      current.resetKey === resetKey && current.ready ? current : { resetKey, ready: true },
    );
  let cancelClose = NO_OP;
  let closeDispatched = false;
  // Asked when it is due: work that would be lost keeps the tabs for another
  // grace period. A transition, so it never lands in a switch; a show that
  // comes before it commits calls `open()` after it (see below), which wins.
  const close = (): void => {
    if (!latest.current.canClose()) {
      cancelClose = closeAfterGrace();
      return;
    }
    closeDispatched = true;
    startTransition(() =>
      setState((current) => (current.ready ? { ...current, ready: false } : current)),
    );
  };
  function closeAfterGrace(): () => void {
    return scheduleIdleAfter(HIDDEN_SIDE_TABS_GRACE_MS, close, { timeout: CLOSE_IDLE_TIMEOUT_MS });
  }
  const stopFollowing = whileActive(activity, () => {
    cancelClose();
    cancelClose = NO_OP;
    let cancelOpen = NO_OP;
    // Still open after a close was dispatched: that close may not have
    // committed yet. `open()` now is applied after it and keeps the gate open.
    // Open with no close in flight, nothing at all: even an update that
    // changes nothing can cost the workspace a render.
    const closeInFlight = closeDispatched && latest.current.open;
    closeDispatched = false;
    if (closeInFlight) open();
    else if (!latest.current.open) {
      if (latest.current.immediate) open();
      else cancelOpen = afterNextPaint(open);
    }
    return () => {
      cancelOpen();
      cancelClose = closeAfterGrace();
    };
  });
  // Set up while hidden (its options changed): the gate still closes in time.
  if (!activity.isActive() && latest.current.open) cancelClose = closeAfterGrace();
  return () => {
    stopFollowing();
    cancelClose();
  };
}

/**
 * Whether everything that is not the agent conversation may start: the side
 * panels' content and the queries only they need.
 *
 * The conversation paints first, by construction rather than by a delay: this
 * opens one paint after the workspace is on screen. `immediate` (a non-agent
 * tab is focused or requested) opens it at once, but only while the workspace
 * is on screen: a workspace mounted hidden ahead of a click (`WorkspacePool`)
 * opens nothing until it is shown, then opens in that same commit. Once open it
 * stays open, until the workspace has been hidden for
 * `HIDDEN_SIDE_TABS_GRACE_MS`; shown after that, it opens again like a first
 * open. Outside a pool (embedded cards) a workspace is always on screen.
 */
export function useAgentFirstNonAgentWork({
  enabled,
  immediate,
  resetKey,
  canClose = ALWAYS,
}: UseAgentFirstNonAgentWorkOptions): boolean {
  const activity = useWorkspaceActivity();
  const [state, setState] = useState<DeferredWorkState>(() => ({
    resetKey,
    ready: enabled && immediate && activity.isActive(),
  }));
  const readyForCurrentSession = state.resetKey === resetKey && state.ready;
  // Read by the activity listener, which runs in the commit that shows the
  // workspace, ahead of any render of it.
  const latest = useRef<GateInputs>({ open: readyForCurrentSession, immediate, canClose });
  useLayoutEffect(() => {
    latest.current = { open: readyForCurrentSession, immediate, canClose };
  }, [canClose, immediate, readyForCurrentSession]);

  useEffect((): (() => void) | void => {
    if (!enabled) return undefined;
    return followWorkspace(activity, resetKey, setState, latest);
  }, [activity, enabled, resetKey]);

  // An immediate tab opened on screen keeps the gate open once it loses focus.
  useEffect(() => {
    if (!enabled || !immediate || !activity.isActive()) return;
    setState((current) =>
      current.resetKey === resetKey && current.ready ? current : { resetKey, ready: true },
    );
  }, [activity, enabled, immediate, resetKey]);

  // The activity is read, not subscribed to: showing or hiding re-renders nothing.
  return enabled && (readyForCurrentSession || (immediate && activity.isActive()));
}

/**
 * Priority order in which non-agent tabs are progressively enabled once the
 * agent has painted. Editor first, then git, terminal, browser, preview — the order the
 * user is most likely watching for in a split layout, and it staggers the
 * expensive panels (editor/diff) so no single frame hydrates two at once.
 */
const STAGGER_ORDER: readonly Exclude<TabKind, "agent">[] = [
  "editor",
  "git",
  "terminal",
  "browser",
  "preview",
];

export type NonAgentTabReadiness = Record<Exclude<TabKind, "agent">, boolean>;

interface StaggerState {
  resetKey: string;
  stage: number;
}

interface UseStaggeredTabReadinessOptions {
  /** Gate signal — non-agent work may begin (the agent has painted). */
  enabled: boolean;
  /** A non-agent tab the user explicitly focused/requested; ready instantly. */
  immediateTab: TabKind | null;
  /** Resets the stagger when the conversation changes. */
  resetKey: string;
}

/**
 * Reveal non-agent tab content in priority order rather than all at once.
 *
 * Only *visible* tabs ever mount (the layout shell mounts inactive tabs
 * lazily), so this staggering matters in split layouts where several non-agent
 * tabs are visible alongside the agent on open: instead of every panel
 * hydrating in the same frame, they come online one per painted frame, each in
 * a task of its own so input is handled between two of them. The tab the user
 * explicitly opened is exempt — it loads the moment the gate opens.
 *
 * The stagger waits while its workspace is hidden and resumes when it is
 * shown. A gate that closes (`useAgentFirstNonAgentWork`) starts the next
 * opening from the first tab again.
 */
export function useStaggeredTabReadiness({
  enabled,
  immediateTab,
  resetKey,
}: UseStaggeredTabReadinessOptions): NonAgentTabReadiness {
  const activity = useWorkspaceActivity();
  // `stage` = number of STAGGER_ORDER tabs revealed so far. Pairing it with the
  // resetKey *in state* (rather than a ref) lets us discard a previous
  // conversation's stage synchronously on switch — see the gate below — so no
  // tab is reported ready for the new conversation for even a single frame.
  const [state, setState] = useState<StaggerState>(() => ({ resetKey, stage: 0 }));
  const stage = enabled && state.resetKey === resetKey ? state.stage : 0;

  useEffect((): (() => void) | void => {
    setState((current) => {
      if (current.resetKey !== resetKey) return { resetKey, stage: 0 };
      // A gate that closed in a hidden workspace starts its next opening over.
      // One closed on screen (an embedded card back on its agent) keeps it.
      const closedWhileHidden = !enabled && current.stage > 0 && !activity.isActive();
      return closedWhileHidden ? { resetKey, stage: 0 } : current;
    });
  }, [activity, enabled, resetKey]);

  // One step per painted frame: the next tab is revealed once the previous
  // one's commit is on screen.
  useEffect((): (() => void) | void => {
    if (!enabled || stage >= STAGGER_ORDER.length) return undefined;
    return whileActive(activity, () =>
      afterNextPaint(() => {
        setState((current) =>
          current.resetKey === resetKey
            ? { resetKey, stage: Math.max(current.stage, stage + 1) }
            : current,
        );
      }),
    );
  }, [activity, enabled, resetKey, stage]);

  return useMemo<NonAgentTabReadiness>(() => {
    const ready = (kind: Exclude<TabKind, "agent">, index: number): boolean =>
      enabled && (kind === immediateTab || stage > index);
    return {
      editor: ready("editor", 0),
      git: ready("git", 1),
      terminal: ready("terminal", 2),
      browser: ready("browser", 3),
      preview: ready("preview", 4),
    };
  }, [enabled, immediateTab, stage]);
}
