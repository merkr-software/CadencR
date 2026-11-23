import { useMemo, useSyncExternalStore } from "react";
import {
  useWorkspaceActivity,
  type WorkspaceActivity,
} from "@/components/workspace-pool/workspace-activity";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { SessionEntry } from "@/stores/ws-session-types";

/**
 * How often a hidden workspace looks at its session. Slow enough that several
 * agents streaming in hidden workspaces cost next to nothing, fast enough that
 * a workspace is nearly current the moment it is shown.
 */
export const BACKGROUND_SESSION_SAMPLE_MS = 750;

interface SessionSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionEntry | undefined;
}

interface SessionSourceLifecycle {
  /** The source got its first listener. */
  onActive?: () => void;
  /** The source lost its last listener. */
  onIdle?: () => void;
}

/**
 * The store slice for the visible workspace; for a hidden one, the entry it
 * had when it was hidden, refreshed every `BACKGROUND_SESSION_SAMPLE_MS`.
 *
 * However many listeners it has, a source holds one store subscription and,
 * while hidden, one interval: they start with its first listener and stop with
 * its last, and every listener is notified of the same sample.
 */
export function createSessionSource(
  activity: WorkspaceActivity,
  sessionId: string,
  lifecycle: SessionSourceLifecycle = {},
): SessionSource {
  const read = (): SessionEntry | undefined => useWsSessionStore.getState().sessions[sessionId];
  let held = read();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const start = (): (() => void) => {
    let timer: number | null = null;
    const stopSampling = (): void => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const sample = (): void => {
      const next = read();
      if (next === held) return;
      held = next;
      notify();
    };
    const syncSampling = (): void => {
      if (activity.isActive()) stopSampling();
      else timer ??= window.setInterval(sample, BACKGROUND_SESSION_SAMPLE_MS);
    };
    const unsubscribeStore = useWsSessionStore.subscribe(() => {
      if (activity.isActive()) notify();
    });
    const unsubscribeActivity = activity.subscribe(() => {
      syncSampling();
      // Shown: the live entry may have moved on. Hidden: `held` is unchanged,
      // so React compares equal snapshots and renders nothing.
      notify();
    });
    syncSampling();
    return () => {
      stopSampling();
      unsubscribeStore();
      unsubscribeActivity();
    };
  };
  let stop: (() => void) | null = null;
  return {
    getSnapshot() {
      if (activity.isActive()) held = read();
      return held;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (stop === null) {
        stop = start();
        lifecycle.onActive?.();
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        stop?.();
        stop = null;
        lifecycle.onIdle?.();
      };
    },
  };
}

/** One source per workspace and session, shared by every consumer in that workspace. */
const sharedSources = new WeakMap<WorkspaceActivity, Map<string, SessionSource>>();

/**
 * The shared source for `sessionId` in this workspace. It stays registered
 * while it has listeners (and from its creation, so consumers rendering
 * together find it), and is forgotten once its last listener is gone.
 */
function workspaceSessionSource(activity: WorkspaceActivity, sessionId: string): SessionSource {
  let bySession = sharedSources.get(activity);
  if (bySession === undefined) {
    bySession = new Map();
    sharedSources.set(activity, bySession);
  }
  const existing = bySession.get(sessionId);
  if (existing !== undefined) return existing;
  const registry = bySession;
  const source: SessionSource = createSessionSource(activity, sessionId, {
    onActive: () => {
      if (!registry.has(sessionId)) registry.set(sessionId, source);
    },
    onIdle: () => {
      if (registry.get(sessionId) === source) registry.delete(sessionId);
    },
  });
  registry.set(sessionId, source);
  return source;
}

/**
 * A workspace's session entry: the live store slice while the workspace is on
 * screen, a periodic sample of it while it is kept mounted but hidden.
 *
 * A session entry changes with every stream delta. Rendering each one in a
 * workspace nobody is looking at would make every hidden agent cost as much as
 * the visible one. Showing the workspace reads the live slice again, so it is
 * never shown stale, and a session that did not change while hidden re-renders
 * nothing at all on either transition. Every consumer of one session in one
 * workspace shares a single sampler, so they render together, on one sample.
 */
export function useWorkspaceSession(sessionId: string): SessionEntry | undefined {
  const activity = useWorkspaceActivity();
  const source = useMemo(() => workspaceSessionSource(activity, sessionId), [activity, sessionId]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
