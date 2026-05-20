/**
 * Single source of truth for agent status on the frontend.
 *
 * The store mirrors the per-session entries the backend pushes on
 * `app/session_status.*` envelopes. Every UI surface that displays
 * "agent is working / asking / idle" reads from here:
 *
 * - the sidebar (`ProjectFeatureRow`) via `useFeatureStatus(featureId)`
 *   which aggregates per-session entries on the fly;
 * - the conversation badge (`AgentSession`) and the input bar's
 *   "disabled while running" check (`AgentPromptBar`) via
 *   `useSessionStatus(sessionId)`;
 * - the unified-agents sidebar button counter (`UnifiedAgentsSidebarLink`)
 *   and the unified-agents grid header counter (`UnifiedAgentsView`)
 *   via `useLiveWorkingCount(sessionDbIds)`;
 * - the unified-agents "Recent" filter (`UnifiedAgentsViewData`) via
 *   `useLiveActiveSessionIds()`.
 *
 * `ws-session-store.sessions[id].lifecycle` is a separate WS-driven
 * concept (turn-level state machine) used for cross-feature concerns
 * like `powerSaveBlocker`, app-close confirmation, and "Stop all
 * agents". It is NOT the live status — only this store is.
 *
 * Wire-format contract with the backend (`domain::session_status`):
 *
 * - `session_status.update` carries a monotonic global `seq`. We reject
 *   any update whose seq is <= the seq we already applied for that
 *   session — that closes the "old event arrives after new one" race.
 * - `session_status.snapshot` carries the global counter at the moment
 *   the backend built it. We merge per-session: an entry is only
 *   overwritten if its current seq is <= the snapshot's seq, so a fresh
 *   live update can't be wiped by a lag-recovery snapshot.
 *
 * Reducers and validators live in `./session-status-handlers` to keep
 * this file focused on the WS lifecycle and Zustand wiring.
 *
 * Conforms to `frontend-performance.md`: every consumer reads via a
 * narrow selector and never subscribes to the whole store.
 */
import { create } from "zustand";
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import { createEnvelope, parseEnvelope } from "@/lib/ws-envelope";
import { getWsProtocols, getWsUrl } from "@/lib/ws-url";
import {
  reportManualReconnectRequired,
  useConnectionStatusStore,
} from "@/stores/connection-status-store";
import {
  registerReconnector,
  resetReconnectState,
  scheduleReconnect,
  unregisterReconnector,
} from "@/lib/ws-reconnect";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { updateSession, type SessionEntry, type WsSessionStore } from "@/stores/ws-session-types";
import { transitionTurn, type TurnLifecycle } from "@/stores/ws-turn-lifecycle";
import { startTurnTiming } from "@/stores/ws-turn-timing";
import {
  applySnapshot,
  applyUpdate,
  handleAppEnvelope,
  notifyTransition,
} from "@/stores/session-status-handlers";

const APP_WS_SOURCE = "app-ws";

export type { LiveAgentStatus, PendingKind };

/** Per-session entry as received from the backend. */
export interface SessionStatusEntry {
  status: LiveAgentStatus;
  /** Only populated when `status === "question"`. `null` for agent/idle. */
  kind: PendingKind | null;
  featureId: number;
  seq: number;
}

interface SessionStatusState {
  ws: WebSocket | null;
  isConnected: boolean;
  /** Per-session entries keyed by `session_id` (the DB primary key). */
  bySession: Record<number, SessionStatusEntry>;
  connect: () => void;
  disconnect: () => void;
}

type IntentionalCloseWebSocket = WebSocket & {
  __intentionalClose?: () => void;
};

export const useSessionStatusStore = create<SessionStatusState>((set, get) => {
  function dispatchEnvelope(
    domain: string,
    action: string,
    payload: Record<string, unknown>,
  ): void {
    if (handleAppEnvelope(domain, action, payload)) return;
    if (domain !== "app") return;
    if (action === "session_status.snapshot") {
      const previous = get().bySession;
      const bySession = applySnapshot(previous, payload);
      set({ bySession });
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
  }

  return {
    ws: null,
    isConnected: false,
    bySession: {},

    connect() {
      // Register so the connection watchdog can force-reconnect us on
      // wake/online without us having to wait for a TCP-level close.
      registerReconnector(
        APP_WS_SOURCE,
        () => {
          const live = get().ws;
          if (live && live.readyState !== WebSocket.CLOSED) {
            (live as IntentionalCloseWebSocket).__intentionalClose?.();
            live.close();
          }
          set({ ws: null, isConnected: false });
          get().connect();
        },
        { onManualRequired: reportManualReconnectRequired },
      );

      const existing = get().ws;
      if (
        existing &&
        (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      const protocols = getWsProtocols();
      const ws = new WebSocket(getWsUrl(), protocols.length ? protocols : undefined);
      // `intentionalClose` flips to true in `disconnect()` *before* we call
      // `ws.close()`. The close handler then knows not to schedule a
      // reconnect and not to scribble on the current `store.ws` (which may
      // already be a freshly-created replacement — see Strict Mode race).
      let intentionalClose = false;

      ws.addEventListener("open", () => {
        resetReconnectState(APP_WS_SOURCE);
        // Preserve `bySession` so sidebar icons don't blink during the
        // 100–300 ms window before the snapshot arrives. `applySnapshot`
        // reconciles per-session via the seq, so any stale entries
        // self-correct (older entries get overwritten; newer ones survive).
        set({ isConnected: true });
        useConnectionStatusStore.getState().reportSource(APP_WS_SOURCE, "connected");
        // The watchdog already calls `probeHealth()` from `forceReconnectAll`
        // on wake, and the periodic 15 s poll covers the standalone case.
        // Reporting `connected` here is sufficient to clear the indicator.
        ws.send(JSON.stringify(createEnvelope("app", "subscribe.session_status", {})));
      });

      // Guard against React Strict Mode double-mount races: a closing
      // socket may fire `close` after `connect()` has already replaced
      // `store.ws` with a new instance. Both store mutations are gated
      // by an instance check (`get().ws === ws`).
      ws.addEventListener("close", () => {
        if (get().ws === ws) {
          set({ isConnected: false, ws: null });
        }
        if (!intentionalClose) {
          useConnectionStatusStore
            .getState()
            .reportSource(APP_WS_SOURCE, "reconnecting", "App WebSocket dropped");
          scheduleReconnect(APP_WS_SOURCE, () => get().connect());
        } else {
          useConnectionStatusStore.getState().clearSource(APP_WS_SOURCE);
        }
      });

      ws.addEventListener("error", () => {
        if (get().ws === ws) set({ isConnected: false });
        if (!intentionalClose) {
          useConnectionStatusStore
            .getState()
            .reportSource(APP_WS_SOURCE, "reconnecting", "App WebSocket error");
        }
      });

      ws.addEventListener("message", (event) => {
        let envelope: ReturnType<typeof parseEnvelope>;
        try {
          envelope = parseEnvelope(event.data as string);
        } catch {
          return; // unparseable — skip
        }
        try {
          dispatchEnvelope(
            envelope.domain,
            envelope.action,
            envelope.payload as Record<string, unknown>,
          );
        } catch (err) {
          console.error("[session-status] dispatchEnvelope error:", err);
        }
      });

      (ws as IntentionalCloseWebSocket).__intentionalClose = () => {
        intentionalClose = true;
      };

      set({ ws });
    },

    disconnect() {
      unregisterReconnector(APP_WS_SOURCE);
      useConnectionStatusStore.getState().clearSource(APP_WS_SOURCE);
      const ws = get().ws;
      if (ws) {
        (ws as IntentionalCloseWebSocket).__intentionalClose?.();
        ws.close();
      }
      set({ ws: null, isConnected: false });
    },
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
    const patch = lifecyclePatchFromStatus(session, entry, previous[sessionDbId]?.status);
    if (!patch) continue;
    updated = { ...updated, ...updateSession(updated, sessionId, patch) };
    changed = true;
  }
  if (changed) useWsSessionStore.setState(updated);
}

function syncWsLifecycle(
  sessionDbId: number,
  entry: Pick<SessionStatusEntry, "status" | "kind">,
  previousStatus?: LiveAgentStatus,
): void {
  const store = useWsSessionStore.getState();
  const match = Object.entries(store.sessions).find(
    ([, session]) => session.sessionDbId === sessionDbId,
  );
  if (!match) return;
  const [sessionId, session] = match;
  const patch = lifecyclePatchFromStatus(session, entry, previousStatus);
  if (!patch) return;
  useWsSessionStore.setState(updateSession(store, sessionId, patch));
}

type LifecyclePatch =
  | Pick<SessionEntry, "lifecycle">
  | Pick<SessionEntry, "lifecycle" | "turnTiming">;

function lifecyclePatchFromStatus(
  session: SessionEntry,
  entry: Pick<SessionStatusEntry, "status" | "kind">,
  previousStatus?: LiveAgentStatus,
): LifecyclePatch | null {
  const lifecycle = lifecycleFromStatus(session.lifecycle, entry.status, entry.kind);
  const resetStaleActiveTiming =
    lifecycle === session.lifecycle &&
    (session.turnTiming.startedAt == null || session.blocks.length === 0) &&
    enteredAgentFromIdle(previousStatus, entry.status);
  if (lifecycle === session.lifecycle && !resetStaleActiveTiming) return null;
  return {
    lifecycle,
    ...(resetStaleActiveTiming ? { turnTiming: startTurnTiming(Date.now()) } : {}),
  };
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
