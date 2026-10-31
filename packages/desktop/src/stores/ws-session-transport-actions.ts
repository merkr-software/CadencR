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

type TransportActions = Pick<
  WsSessionStore,
  "disconnect" | "release" | "send" | "sendRequest" | "initSession"
>;

interface TransportActionDeps {
  ctx: StoreAccessors;
  sendRaw: (sessionId: string, envelope: WsEnvelope) => void;
  sourceKey: (sessionId: string) => string;
}

export function createWsSessionTransportActions(deps: TransportActionDeps): TransportActions {
  const { ctx, sendRaw, sourceKey } = deps;
  const { get, set } = ctx;

  function closeSession(sessionId: string, stopRuntime: boolean): void {
    clearReconnect(sourceKey(sessionId));
    unregisterReconnector(sourceKey(sessionId));
    useConnectionStatusStore.getState().clearSource(sourceKey(sessionId));
    discardStreamDeltas(ctx, sessionId);
    const session = get().sessions[sessionId];
    const transport = ctx.transport.get(sessionId);
    if (stopRuntime && session?.serverSessionId) {
      transport?.conn?.sendJson(createDestroy(session.serverSessionId));
    }
    ctx.transport.remove(sessionId);

    const { [sessionId]: _, ...rest } = get().sessions;
    set({ sessions: rest });
  }

  return {
    disconnect: (sessionId: string) => closeSession(sessionId, true),
    release: (sessionId: string) => closeSession(sessionId, false),

    send: sendRaw,

    sendRequest(sessionId: string, envelope: WsEnvelope): Promise<unknown> {
      return new Promise((resolve) => {
        const session = get().sessions[sessionId];
        if (!session) {
          resolve(null);
          return;
        }
        const transport = ctx.transport.ensure(sessionId);
        // A non-OPEN socket is not an instant failure: sendRaw queues the
        // envelope and the reconnect flush usually lands well inside the
        // timeout window. The timer (and the close handler's pending-request
        // sweep) still bound the wait.
        const timer = setTimeout(() => {
          transport.pendingWsRequests.delete(envelope.id);
          // Drop the still-queued envelope too. Otherwise a reconnect after the
          // timeout flushes a request the caller already gave up on — e.g. a
          // permission response the user was told "timed out" would silently
          // reach the backend on the next onOpen.
          const queued = transport.outboundQueue.indexOf(envelope);
          if (queued !== -1) transport.outboundQueue.splice(queued, 1);
          resolve(null);
        }, 10_000);
        transport.pendingWsRequests.set(envelope.id, (payload) => {
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
      // Selection arrives via the `initialized` envelope — no optimistic write.
      if (config.thinkingEffort) {
        sessionPatch.currentThinkingEffort = config.thinkingEffort;
      }
      const envelope = createSessionInit(config);
      sessionPatch.initRequestId = envelope.id;
      set(updateSession(get(), sessionId, sessionPatch));
      sendRaw(sessionId, envelope);
    },
  };
}
