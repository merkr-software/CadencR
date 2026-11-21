import type { TabKind } from "@/stores/feature-layout-schema";

/** What the `ws-session` route asks to show: one conversation's workspace. */
export interface WorkspaceTarget {
  sessionId: string;
  cwd: string;
  featureId: number;
  projectId: number;
  /**
   * A tab to bring forward. A request, not part of the workspace's identity:
   * the workspace reads it once, when it mounts, and `WorkspacePool` applies
   * it on every later activation.
   */
  focusTab: TabKind | undefined;
}

export interface WorkspacePoolState {
  /**
   * Mounted workspaces, in mount order. The order never changes for a mounted
   * entry: reordering keyed children makes React move their DOM nodes, which
   * resets scroll positions and re-lays-out a whole workspace.
   */
  entries: readonly WorkspaceTarget[];
  /**
   * Session ids of the workspaces that were shown, most recently shown first.
   * `recency[0]` is the active one.
   */
  recency: readonly string[];
  /**
   * The workspace mounted ahead of a click and not shown yet (at most one). It
   * is outside `recency`: it neither counts toward the limit nor gets trimmed,
   * so a press that never became a click cannot evict a workspace the user saw.
   */
  prewarmed: string | null;
}

export const EMPTY_WORKSPACE_POOL: WorkspacePoolState = {
  entries: [],
  recency: [],
  prewarmed: null,
};

/**
 * How many shown workspaces stay mounted, the visible one included. Each
 * hidden one keeps its session and DOM alive, so this trades memory and
 * background work against how many conversations reopen instantly.
 */
export const WORKSPACE_POOL_LIMIT = 5;

/** Same workspace, same route params. `focusTab` is a request and does not count. */
function sameTarget(a: WorkspaceTarget, b: WorkspaceTarget): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.cwd === b.cwd &&
    a.featureId === b.featureId &&
    a.projectId === b.projectId
  );
}

function withoutEntry(state: WorkspacePoolState, sessionId: string): WorkspacePoolState {
  return {
    entries: state.entries.filter((entry) => entry.sessionId !== sessionId),
    recency: state.recency.filter((id) => id !== sessionId),
    prewarmed: state.prewarmed === sessionId ? null : state.prewarmed,
  };
}

/**
 * Show `target`: mount it if it is new, refresh its route params if they
 * changed, and move it to the front of the recency list (a prewarmed one joins
 * it there). An entry whose route params did not change is kept as is, so its
 * workspace does not re-render. Returns `state` itself when nothing changes,
 * so callers can compare by identity.
 */
export function activateWorkspace(
  state: WorkspacePoolState,
  target: WorkspaceTarget,
): WorkspacePoolState {
  const index = state.entries.findIndex((entry) => entry.sessionId === target.sessionId);
  const existing = index === -1 ? undefined : state.entries[index];
  const isFront = state.recency[0] === target.sessionId;
  const unchanged = existing !== undefined && sameTarget(existing, target);
  if (unchanged && isFront) return state;

  const entries =
    existing === undefined
      ? [...state.entries, target]
      : unchanged
        ? state.entries
        : state.entries.map((entry, i) => (i === index ? target : entry));
  const recency = isFront
    ? state.recency
    : [target.sessionId, ...state.recency.filter((id) => id !== target.sessionId)];
  const prewarmed = state.prewarmed === target.sessionId ? null : state.prewarmed;
  return { entries, recency, prewarmed };
}

/**
 * Mount `target` hidden, ahead of it being shown. A workspace that is already
 * mounted is left alone; a previous prewarm that was not shown is dropped.
 */
export function prewarmWorkspace(
  state: WorkspacePoolState,
  target: WorkspaceTarget,
): WorkspacePoolState {
  if (state.entries.some((entry) => entry.sessionId === target.sessionId)) return state;
  const base = state.prewarmed === null ? state : withoutEntry(state, state.prewarmed);
  return {
    entries: [...base.entries, target],
    recency: base.recency,
    prewarmed: target.sessionId,
  };
}

/** Unmount a prewarmed workspace that was never shown. A no-op once it was. */
export function dropPrewarm(state: WorkspacePoolState, sessionId: string): WorkspacePoolState {
  return state.prewarmed === sessionId ? withoutEntry(state, sessionId) : state;
}

/**
 * Unmount the least recently shown workspaces beyond `limit`. Never the active
 * one, and never the pending prewarm.
 */
export function trimWorkspacePool(state: WorkspacePoolState, limit: number): WorkspacePoolState {
  const keep = Math.max(1, limit);
  if (state.recency.length <= keep) return state;
  const kept = new Set(state.recency.slice(0, keep));
  if (state.prewarmed !== null) kept.add(state.prewarmed);
  return {
    entries: state.entries.filter((entry) => kept.has(entry.sessionId)),
    recency: state.recency.filter((id) => kept.has(id)),
    prewarmed: state.prewarmed,
  };
}

/** Unmount one workspace (its conversation was deleted or archived). */
export function dropWorkspace(state: WorkspacePoolState, sessionId: string): WorkspacePoolState {
  if (!state.entries.some((entry) => entry.sessionId === sessionId)) return state;
  return withoutEntry(state, sessionId);
}
