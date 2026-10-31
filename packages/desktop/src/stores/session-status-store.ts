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
 * Reducers and validators live in `./session-status-reducers` to keep
 * this file focused on the WS lifecycle and Zustand wiring.
 *
 * Every consumer reads via a narrow selector.
 */
import { create, type StoreApi } from "zustand";
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import { observeServerClock } from "@/lib/server-clock";
import { applySnapshot, applyUpdate, snapshotCursor } from "./session-status-reducers";
import { createAppWsConnection } from "./session-status-connection";

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
  /** Changes on every confirmed connection, including a batched drop/reconnect. */
  connectionEpoch: number;
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
  subscribeFileWatcher: (projectId: number, featureId?: number) => void;
  subscribeGitStatus: (featureId: number) => () => void;
}

type SessionStatusSet = StoreApi<SessionStatusState>["setState"];
type SessionStatusGet = StoreApi<SessionStatusState>["getState"];
export type EnvelopeDispatcher = (
  domain: string,
  action: string,
  payload: Record<string, unknown>,
) => void;

/** Required app composition, invoked only for confirmed backend envelopes. */
export interface SessionStatusEffects {
  handleEnvelope: EnvelopeDispatcher;
  snapshotApplied: (
    previous: Record<number, SessionStatusEntry>,
    next: Record<number, SessionStatusEntry>,
    previousEpoch: number | null,
    epoch: number | null,
  ) => void;
  updateApplied: (
    previous: Record<number, SessionStatusEntry>,
    result: ReturnType<typeof applyUpdate>,
  ) => void;
}

let installedEffects: { effects: SessionStatusEffects } | null = null;

export function installSessionStatusEffects(effects: SessionStatusEffects): () => void {
  if (installedEffects) throw new Error("Session status integration is already installed");
  const registration = { effects };
  installedEffects = registration;
  return () => {
    if (installedEffects === registration) installedEffects = null;
  };
}

function requireEffects(): SessionStatusEffects {
  if (!installedEffects)
    throw new Error("Session status integration must be installed before connecting");
  return installedEffects.effects;
}

function createEnvelopeDispatcher(
  set: SessionStatusSet,
  get: SessionStatusGet,
): EnvelopeDispatcher {
  return (domain, action, payload): void => {
    if (domain !== "app" || !action.startsWith("session_status.")) {
      requireEffects().handleEnvelope(domain, action, payload);
      return;
    }
    if (action === "session_status.snapshot") {
      observeServerClock(payload.server_now_ms);
      const { bySession: previous, epoch: previousEpoch } = get();
      const bySession = applySnapshot(previous, payload, previousEpoch);
      const { seq: snapshotSeq, epoch } = snapshotCursor(payload);
      set({ bySession, hasSnapshot: true, epoch, snapshotSeq });
      requireEffects().snapshotApplied(previous, bySession, previousEpoch, epoch);
    } else if (action === "session_status.update") {
      observeServerClock(payload.server_now_ms);
      const previous = get().bySession;
      const result = applyUpdate(previous, payload, get().snapshotSeq);
      if (result.next) set({ bySession: result.next });
      requireEffects().updateApplied(previous, result);
    }
  };
}

export const useSessionStatusStore = create<SessionStatusState>((set, get) => {
  const dispatchEnvelope = createEnvelopeDispatcher(set, get);
  const connection = createAppWsConnection(set, get, dispatchEnvelope);
  return {
    ...connection,
    connectionEpoch: 0,
    isConnected: false,
    hasSnapshot: false,
    epoch: null,
    snapshotSeq: 0,
    bySession: {},
    connect: () => {
      requireEffects();
      connection.connect();
    },
  };
});
