/**
 * Single source of truth for agent status on the frontend.
 *
 * Mirrors per-session `app/session_status.*` envelopes. Every UI surface
 * displaying "agent is working / asking / idle" reads from here:
 * - the sidebar (`ProjectFeatureRow`) via `useFeatureStatus(featureId)`
 *   which aggregates per-session entries on the fly;
 * - the conversation badge (`AgentSession`) and the input bar's
 *   "disabled while running" check (`AgentPromptBar`) via
 *   `useSessionStatus(sessionId)`;
 * - unified-agent counters and filters via their narrow selectors.
 *
 * `ws-session-store.sessions[id].lifecycle` is a separate WS-driven
 * concept (turn-level state machine) used for cross-feature concerns
 * like `powerSaveBlocker`, app-close confirmation, and "Stop all
 * agents". It is NOT the live status — only this store is.
 *
 * Wire-format contract with the backend (`domain::session_status`):
 * - `session_status.update` carries a monotonic global `seq`. We reject
 *   any update whose seq is <= the seq we already applied for that
 *   session — that closes the "old event arrives after new one" race.
 * - `session_status.snapshot` carries the global counter at the moment
 *   the backend built it. We merge per-session: an entry is only
 *   overwritten if its current seq is <= the snapshot's seq, so a fresh
 *   live update can't be wiped by a lag-recovery snapshot.
 * Reducers and validators live in `./session-status-handlers` to keep
 * this file focused on the WS lifecycle and Zustand wiring.
 *
 * Every consumer reads via a narrow selector.
 */
import { create, type StoreApi } from "zustand";
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { updateSession, type SessionEntry, type WsSessionStore } from "@/stores/ws-session-types";
import { transitionTurn, type TurnLifecycle } from "@/stores/ws-turn-lifecycle";
import { anchorTurnTiming } from "@/stores/ws-turn-timing";
import { buildClearedGatePatch } from "@/stores/ws-gate-state";
import {
  applySnapshot,
  applyUpdate,
  handleAppEnvelope,
  notifyTransition,
} from "@/stores/session-status-handlers";
import { createAppWsConnect, createAppWsDisconnect } from "@/stores/session-status-connection";

export type { LiveAgentStatus, PendingKind };

/** Per-session entry as received from the backend. */
export interface SessionStatusEntry {
  status: LiveAgentStatus;
  /** Only populated when `status === "question"`. `null` for agent/idle. */
  kind: PendingKind | null;
  requestId?: string | null;
  featureId: number;
  seq: number;
  /**
   * Server-stamped turn start (epoch ms) for a running turn, the single
   * source of truth the elapsed timer is anchored to so every device renders
   * the same value. `null`/absent when not running or not provided (the timer
   * then falls back to local time).
   */
  turnStartedAtMs?: number | null;
}
export interface SessionStatusState {
  ws: WebSocket | null;
  isConnected: boolean;
  hasSnapshot: boolean;
  /** Per-session entries keyed by `session_id` (the DB primary key). */
  bySession: Record<number, SessionStatusEntry>;
  connect: () => void;
  disconnect: () => void;
}

type SessionStatusSet = StoreApi<SessionStatusState>["setState"];
type SessionStatusGet = StoreApi<SessionStatusState>["getState"];
export type EnvelopeDispatcher = (
  domain: string,
  action: string,
  payload: Record<string, unknown>,
) => void;

function createEnvelopeDispatcher(
  set: SessionStatusSet,
  get: SessionStatusGet,
): EnvelopeDispatcher {
  return (domain, action, payload): void => {
    if (handleAppEnvelope(domain, action, payload)) return;
    if (domain !== "app") return;
    if (action === "session_status.snapshot") {
      const previous = get().bySession;
      const bySession = applySnapshot(previous, payload);
      set({ bySession, hasSnapshot: true });
      syncWsLifecycles(previous, bySession);
      return;
    }
    if (action === "session_status.update") {
      const result = applyUpdate(get().bySession, payload);
      if (result.next) set({ bySession: result.next });
      if (
        result.entry &&
        result.sessionId != null &&
        (result.next || result.entry.status !== "idle")
      ) {
        syncWsLifecycle(result.sessionId, result.entry, result.prevStatus);
      }
      if (result.featureId != null && result.nextStatus) {
        notifyTransition(result.featureId, result.prevStatus, result.nextStatus);
      }
    }
  };
}

export const useSessionStatusStore = create<SessionStatusState>((set, get) => {
  const dispatchEnvelope = createEnvelopeDispatcher(set, get);
  return {
    ws: null,
    isConnected: false,
    hasSnapshot: false,
    bySession: {},
    connect: createAppWsConnect(set, get, dispatchEnvelope),
    disconnect: createAppWsDisconnect(set, get),
  };
});

function syncWsLifecycles(
  previous: Record<number, SessionStatusEntry>,
  next: Record<number, SessionStatusEntry>,
): void {
  const store = useWsSessionStore.getState();
  const sessionIdsByDbId = new Map<number, string>();
  for (const [sessionId, session] of Object.entries(store.sessions)) {
    if (session.sessionDbId != null) sessionIdsByDbId.set(session.sessionDbId, sessionId);
  }

  let updated: WsSessionStore = store;
  let changed = false;
  for (const [rawId, entry] of Object.entries(next)) {
    const sessionDbId = Number(rawId);
    const sessionId = sessionIdsByDbId.get(sessionDbId);
    if (!sessionId) continue;
    const session = updated.sessions[sessionId];
    if (!session) continue;
    const patch = statusSyncPatch(session, entry, previous[sessionDbId]?.status);
    if (!patch) continue;
    updated = { ...updated, ...updateSession(updated, sessionId, patch) };
    changed = true;
  }
  if (changed) useWsSessionStore.setState(updated);
}

function syncWsLifecycle(
  sessionDbId: number,
  entry: Pick<SessionStatusEntry, "status" | "kind" | "turnStartedAtMs">,
  previousStatus?: LiveAgentStatus,
): void {
  const store = useWsSessionStore.getState();
  const match = Object.entries(store.sessions).find(
    ([, session]) => session.sessionDbId === sessionDbId,
  );
  if (!match) return;
  const [sessionId, session] = match;
  const patch = statusSyncPatch(session, entry, previousStatus);
  if (!patch) return;
  useWsSessionStore.setState(updateSession(store, sessionId, patch));
}

/**
 * Build the full ws-session patch for a status change: the lifecycle/timing
 * patch plus a gate clear when the session leaves the "question" state.
 *
 * A gate (permission/plan/question) is answered on whichever device the user
 * is holding; the backend then broadcasts the session out of "question" to
 * every client. Clearing the gate here makes it disappear on the *other*
 * devices too (the answering device already cleared its own). Keyed on the
 * app-socket's own prev→next transition, so it never races a freshly-arrived
 * gate on the per-feature socket.
 */
function statusSyncPatch(
  session: SessionEntry,
  entry: Pick<SessionStatusEntry, "status" | "kind" | "turnStartedAtMs">,
  previousStatus?: LiveAgentStatus,
): Partial<SessionEntry> | null {
  const lifecyclePatch = lifecyclePatchFromStatus(session, entry, previousStatus);
  const gatePatch =
    previousStatus === "question" && entry.status !== "question"
      ? buildClearedGatePatch(session)
      : null;
  if (!lifecyclePatch && !gatePatch) return null;
  return { ...gatePatch, ...lifecyclePatch };
}

type LifecyclePatch =
  | Pick<SessionEntry, "lifecycle">
  | Pick<SessionEntry, "lifecycle" | "turnTiming">;

function lifecyclePatchFromStatus(
  session: SessionEntry,
  entry: Pick<SessionStatusEntry, "status" | "kind" | "turnStartedAtMs">,
  previousStatus?: LiveAgentStatus,
): LifecyclePatch | null {
  const lifecycle = lifecycleFromStatus(session.lifecycle, entry.status, entry.kind);
  const lifecycleChanged = lifecycle !== session.lifecycle;

  // A second device observing a turn start via the global status: the
  // lifecycle flips idle→active here. Anchor `startedAt` to the server stamp
  // so every device shows the same elapsed time; the accrual segment opens
  // at the local clock so a turn observed hours late doesn't book its whole
  // unobserved span into one bucket. (When the server didn't supply a stamp
  // we fall through to `updateSession`'s local-clock default.)
  const startsFreshTurn =
    lifecycleChanged &&
    !isInProgressLifecycle(session.lifecycle) &&
    isInProgressLifecycle(lifecycle) &&
    entry.turnStartedAtMs != null;

  // Lifecycle unchanged but timing went stale (e.g. mid-turn snapshot): start
  // it, anchored to the server start when available.
  const resetStaleActiveTiming =
    !lifecycleChanged &&
    (session.turnTiming.startedAt == null || session.blocks.length === 0) &&
    enteredAgentFromIdle(previousStatus, entry.status);

  if (!lifecycleChanged && !resetStaleActiveTiming) return null;
  if (startsFreshTurn) {
    return { lifecycle, turnTiming: anchorTurnTiming(entry.turnStartedAtMs as number) };
  }
  if (resetStaleActiveTiming) {
    return { lifecycle, turnTiming: anchorTurnTiming(entry.turnStartedAtMs ?? Date.now()) };
  }
  return { lifecycle };
}

function isInProgressLifecycle(lifecycle: TurnLifecycle): boolean {
  return lifecycle.phase === "active" || lifecycle.phase === "paused";
}

function enteredAgentFromIdle(
  previousStatus: LiveAgentStatus | undefined,
  nextStatus: LiveAgentStatus,
): boolean {
  return nextStatus === "agent" && (previousStatus == null || previousStatus === "idle");
}

function lifecycleFromStatus(
  lifecycle: TurnLifecycle,
  status: LiveAgentStatus,
  kind: PendingKind | null,
): TurnLifecycle {
  if (status === "agent") return transitionTurn(lifecycle, { type: "stream_activity" });
  if (status === "question") {
    return transitionTurn(lifecycle, {
      type: kind === "question" ? "question_requested" : "permission_requested",
    });
  }
  if (status === "idle" && (lifecycle.phase === "active" || lifecycle.phase === "paused")) {
    return transitionTurn(lifecycle, {
      type: "turn_ended",
      reason: "completed",
    });
  }
  return lifecycle;
}
