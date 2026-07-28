import {
  createDestroy,
  createSessionInit,
  type SessionConfig,
  type WsEnvelope,
} from "@/lib/ws-envelope";
import { clearReconnect, unregisterReconnector } from "@/lib/ws-reconnect";
import { useConnectionStatusStore } from "@/stores/connection-status-store";
import { discardStreamDeltas } from "./ws-delta-coalescer";
import type { StoreAccessors } from "./ws-envelope-handler";
import type { SessionEntry, WsSessionStore } from "./ws-session-types";
import { updateSession } from "./ws-session-types";

type TransportActions = Pick<WsSessionStore, "disconnect" | "send" | "sendRequest" | "initSession">;

interface TransportActionDeps {
  ctx: StoreAccessors;
  sendRaw: (sessionId: string, envelope: WsEnvelope) => void;
  sourceKey: (sessionId: string) => string;
  rejectPendingRequests: (session: SessionEntry) => void;
}

export function createWsSessionTransportActions(deps: TransportActionDeps): TransportActions {
  const { ctx, sendRaw, sourceKey, rejectPendingRequests } = deps;
  const { get, set } = ctx;
  return {
    disconnect(sessionId: string) {
      clearReconnect(sourceKey(sessionId));
      unregisterReconnector(sourceKey(sessionId));
      useConnectionStatusStore.getState().clearSource(sourceKey(sessionId));
      discardStreamDeltas(sessionId);
      const session = get().sessions[sessionId];
      // Deliberate teardown: queued envelopes must not outlive it. Without
      // this, a disconnect while the socket is already down early-returns
      // below (conn is null), the entry survives, and a later connect() would
      // flush stale envelopes (e.g. an old prompt) into a session the user
      // had closed. In-place splice because the queue is mutated in place by
      // design (see SessionEntry.outboundQueue).
      session?.outboundQueue.splice(0);
      // The deliberate close() below skips onClose's pending-request sweep
      // (it early-returns on `intentional`), so resolve in-flight requests now
      // rather than leaving permission/worktree calls hanging until the timeout.
      if (session) rejectPendingRequests(session);
      if (session?.conn) {
        if (session.serverSessionId) {
          session.conn.sendJson(createDestroy(session.serverSessionId));
        }
        session.conn.close();
      }

      const { [sessionId]: _, ...rest } = get().sessions;
      set({ sessions: rest });
    },

    send: sendRaw,

    sendRequest(sessionId: string, envelope: WsEnvelope): Promise<unknown> {
      return new Promise((resolve) => {
        const session = get().sessions[sessionId];
        if (!session) {
          resolve(null);
          return;
        }
        // A non-OPEN socket is not an instant failure: sendRaw queues the
        // envelope and the reconnect flush usually lands well inside the
        // timeout window. The timer (and the close handler's pending-request
        // sweep) still bound the wait.
        const timer = setTimeout(() => {
          session.pendingWsRequests.delete(envelope.id);
          // Drop the still-queued envelope too. Otherwise a reconnect after the
          // timeout flushes a request the caller already gave up on — e.g. a
          // permission response the user was told "timed out" would silently
          // reach the backend on the next onOpen.
          const queued = session.outboundQueue.indexOf(envelope);
          if (queued !== -1) session.outboundQueue.splice(queued, 1);
          resolve(null);
        }, 10_000);
        session.pendingWsRequests.set(envelope.id, (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
        sendRaw(sessionId, envelope);
      });
    },

    initSession(sessionId: string, config: SessionConfig) {
      const sessionPatch: Partial<SessionEntry> = {};
      if (config.cwd) {
        sessionPatch.cwd = config.cwd;
      }
      if (config.featureId) {
        sessionPatch.featureId = config.featureId;
      }
      if (config.thinkingEffort) {
        sessionPatch.currentThinkingEffort = config.thinkingEffort;
      }
      if (Object.keys(sessionPatch).length > 0) {
        set(updateSession(get(), sessionId, sessionPatch));
      }
      sendRaw(sessionId, createSessionInit(config));
    },
  };
}
