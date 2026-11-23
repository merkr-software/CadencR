import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Whether the conversation workspace a component lives in is the one on
 * screen. The workspace pool keeps recently opened workspaces mounted and
 * hidden so reopening one is a repaint instead of a mount; this is how their
 * descendants know to stand down (no shortcuts, no palette actions, a slower
 * read of the live session).
 *
 * It is a tiny store rather than a boolean in context on purpose: a boolean
 * would re-render every consumer in two whole workspaces at each switch, which
 * is exactly the work the pool exists to avoid. Handlers read `isActive()` when
 * their event fires; the few places that must react subscribe.
 */
export interface WorkspaceActivity {
  isActive(): boolean;
  /** Called after every change, with the new value readable from `isActive()`. */
  subscribe(listener: () => void): () => void;
}

export interface WorkspaceActivityController extends WorkspaceActivity {
  set(active: boolean): void;
}

export function createWorkspaceActivity(initial: boolean): WorkspaceActivityController {
  let active = initial;
  const listeners = new Set<() => void>();
  return {
    isActive: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      if (next === active) return;
      active = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Outside a pool a workspace is mounted on its own, so it is always the active one. */
const ALWAYS_ACTIVE: WorkspaceActivity = {
  isActive: () => true,
  subscribe: () => () => {},
};

const WorkspaceActivityContext = createContext<WorkspaceActivity>(ALWAYS_ACTIVE);

export const WorkspaceActivityProvider = WorkspaceActivityContext.Provider;

/** The activity store itself: identity-stable, never re-renders the caller. */
export function useWorkspaceActivity(): WorkspaceActivity {
  return useContext(WorkspaceActivityContext);
}

/**
 * The current value, re-rendering the caller in the very commit that shows or
 * hides its workspace. Only for what must not lag a switch by a frame (a native
 * view on screen); prefer `useWorkspaceActivity`, or `useSettledWorkspaceActive`.
 */
export function useWorkspaceActive(): boolean {
  const activity = useContext(WorkspaceActivityContext);
  return useSyncExternalStore(activity.subscribe, activity.isActive);
}

/**
 * The current value for slow consumers (a poll's interval, a deferred query):
 * it follows the activity in a transition, so the re-render it causes never
 * lands in the commit that switches conversations.
 */
export function useSettledWorkspaceActive(): boolean {
  const activity = useContext(WorkspaceActivityContext);
  const [active, setActive] = useState(activity.isActive);
  useEffect(() => {
    const follow = (): void => startTransition(() => setActive(activity.isActive()));
    follow();
    return activity.subscribe(follow);
  }, [activity]);
  return active;
}

/**
 * Run something only while the workspace is on screen: `start` is called when
 * it is (or becomes) active, the function `start` returns when it is hidden,
 * and `start` again each time it is shown. The returned cleanup stops following
 * the workspace and stops what is running.
 */
export function whileActive(activity: WorkspaceActivity, start: () => () => void): () => void {
  let stop: (() => void) | null = null;
  const halt = (): void => {
    const running = stop;
    stop = null;
    running?.();
  };
  const sync = (): void => {
    if (activity.isActive()) stop ??= start();
    else halt();
  };
  sync();
  const unsubscribe = activity.subscribe(sync);
  return () => {
    unsubscribe();
    halt();
  };
}
