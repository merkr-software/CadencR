import { reconcileQuestionDrafts } from "./question-drafts";
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
 * - The backend keeps one live status book; every update is a transition of
 *   it and every snapshot a read of it, so the snapshot a device receives is
 *   exactly what connected devices were sent.
 * - `session_status.update` carries a monotonic global `seq`. We reject
 *   any update whose seq is <= the seq we already applied for that
 *   session, or <= the last snapshot's seq (already folded in) — that
 *   closes the "old event arrives after new one" race.
 * - `session_status.snapshot` carries the global counter at the moment
 *   the backend built it. We merge per-session: an entry is only
 *   overwritten if its current seq is <= the snapshot's seq, so a fresh
 *   live update can't be wiped by a lag-recovery snapshot.
 * - A snapshot carries the server process `epoch`. `seq` restarts with every
 *   process, so a snapshot from a new epoch replaces everything instead of
 *   being merged against the old process's seqs.
 * - Both carry `server_now_ms`, from which `server-clock` estimates this
 *   device's skew: `turnStartedAtMs` stays on the server clock here, and is
 *   converted where a timer is anchored to it.
 * Reducers and validators live in `./session-status-handlers` to keep
 * this file focused on the WS lifecycle and Zustand wiring.
 *
 * Every consumer reads via a narrow selector.
 */
import { create, type StoreApi } from "zustand";
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { updateSession, type WsSessionStore } from "@/stores/ws-session-types";
import { liveSessionEnv } from "@/stores/ws-session-update";
import { liveStatusPatch, type LiveStatusChange } from "@/stores/session-state-reducer";
import { registerTurnStartResolver } from "@/stores/server-turn-start";
import { observeServerClock, serverToLocalMs } from "@/lib/server-clock";
import {
  applySnapshot,
  applyUpdate,
  handleAppEnvelope,
  notifyTransition,
  snapshotCursor,
} from "@/stores/session-status-handlers";
import { handleAppSocketError } from "./app-socket-errors";
import { createAppWsConnect, createAppWsDisconnect } from "@/stores/session-status-connection";
import { revealAgentDocument } from "@/lib/auto-layout/agent-document-activity";

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
   * Server-stamped turn start (epoch ms, server clock) of the running turn,
   * kept through gates: the single source of truth every device anchors its
   * elapsed timer to. `null` only for a gate restored across a server restart
   * (the timer then falls back to local time).
   */
  turnStartedAtMs?: number | null;
}
export interface SessionStatusState {
  ws: WebSocket | null;
  isConnected: boolean;
  hasSnapshot: boolean;
  /** Server process of the last snapshot; `seq`s only compare within one. */
  epoch: number | null;
  /** Seq of the last snapshot: every update up to it is already folded in. */
  snapshotSeq: number;
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
    if (domain === "editor" && action === "file_tree.changed") {
      revealAgentDocument(payload, get().bySession);
    }
    if (handleAppSocketError(domain, action, payload)) return;
    if (handleAppEnvelope(domain, action, payload)) return;
    if (domain !== "app") return;
    if (action === "session_status.snapshot") {
      observeServerClock(payload.server_now_ms);
      const { bySession: previous, epoch: previousEpoch } = get();
      const { bySession, transitions } = applySnapshot(previous, payload, previousEpoch);
      const { seq: snapshotSeq, epoch } = snapshotCursor(payload);
      set({ bySession, hasSnapshot: true, epoch, snapshotSeq });
      reconcileQuestionDrafts(previous, bySession);
      syncWsLifecycles(previous, bySession);
      for (const transition of transitions) {
        notifyTransition(transition.featureId, transition.prevStatus, transition.nextStatus);
      }
      return;
    }
    if (action === "session_status.update") {
      observeServerClock(payload.server_now_ms);
      const previous = get().bySession;
      const result = applyUpdate(previous, payload, get().snapshotSeq);
      if (result.next) {
        set({ bySession: result.next });
        reconcileQuestionDrafts(previous, result.next);
      }
      if (
        result.entry &&
        result.sessionId != null &&
        (result.next || result.entry.status !== "idle")
      ) {
        syncWsLifecycle(result.sessionId, result.entry, previous[result.sessionId]);
      }
      if (result.featureId != null && result.nextStatus) {
        notifyTransition(result.featureId, result.prevStatus, result.nextStatus, result.failed);
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
    epoch: null,
    snapshotSeq: 0,
    bySession: {},
    connect: createAppWsConnect(set, get, dispatchEnvelope),
    disconnect: createAppWsDisconnect(set, get),
  };
});

registerTurnStartResolver((sessionDbId) => {
  const startedAt = useSessionStatusStore.getState().bySession[sessionDbId]?.turnStartedAtMs;
  return startedAt == null ? null : serverToLocalMs(startedAt);
});

const IDLE_ENTRY: LiveStatusChange = { status: "idle", kind: null };

/**
 * Bring every open conversation in line with a snapshot — including the ones
 * it dropped: the backend lists only non-idle sessions, so one that was busy
 * and is now absent went idle (its turn ended while this device was
 * disconnected, or the server restarted) and must not keep "Working".
 */
function syncWsLifecycles(
  previous: Record<number, SessionStatusEntry>,
  next: Record<number, SessionStatusEntry>,
): void {
  const store = useWsSessionStore.getState();
  let updated: WsSessionStore = store;
  let changed = false;
  for (const [sessionId, session] of Object.entries(store.sessions)) {
    if (session.sessionDbId == null) continue;
    const wasBusy = (previous[session.sessionDbId]?.status ?? "idle") !== "idle";
    const entry = next[session.sessionDbId] ?? (wasBusy ? IDLE_ENTRY : null);
    const current = updated.sessions[sessionId];
    if (!entry || !current) continue;
    const patch = liveStatusPatch(current, entry, previous[session.sessionDbId], liveSessionEnv());
    if (!patch) continue;
    updated = { ...updated, ...updateSession(updated, sessionId, patch) };
    changed = true;
  }
  if (changed) useWsSessionStore.setState(updated);
}

function syncWsLifecycle(
  sessionDbId: number,
  entry: LiveStatusChange,
  previous?: SessionStatusEntry,
): void {
  const store = useWsSessionStore.getState();
  const match = Object.entries(store.sessions).find(
    ([, session]) => session.sessionDbId === sessionDbId,
  );
  if (!match) return;
  const [sessionId, session] = match;
  const patch = liveStatusPatch(session, entry, previous, liveSessionEnv());
  if (!patch) return;
  useWsSessionStore.setState(updateSession(store, sessionId, patch));
}
