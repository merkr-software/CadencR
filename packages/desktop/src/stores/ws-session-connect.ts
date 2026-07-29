import { createWsConnection, type WsConnection } from "@/lib/ws-connection";
import { getWsProtocols, getWsUrl } from "@/lib/ws-url";
import {
  isRateLimited,
  notifyRateLimited,
  registerReconnector,
  resetReconnectState,
  scheduleReconnect,
  WS_RATE_LIMIT_RETRY_MS,
} from "@/lib/ws-reconnect";
import {
  reportManualReconnectRequired,
  useConnectionStatusStore,
} from "@/stores/connection-status-store";
import { flushStreamDeltas } from "./ws-delta-coalescer";
import type { StoreAccessors } from "./ws-envelope-handler";
import { appendErrorBlockPatch } from "./ws-session-store-helpers";
import { createSessionEntry, type SessionEntry, updateSession } from "./ws-session-types";
import { isTurnActive, transitionTurn } from "./ws-turn-lifecycle";
import { resyncMessagesOnReconnect } from "./ws-session-resync";
import { handleSocketMessage, type SocketHandlerDeps } from "./ws-session-socket-handler";

interface ConnectSessionDeps {
  ctx: StoreAccessors;
  socketDeps: SocketHandlerDeps;
  sourceKey: (sessionId: string) => string;
  rejectPendingRequests: (session: SessionEntry) => void;
  forceReconnectSession: (sessionId: string) => void;
  reinitOnReconnect: (sessionId: string) => void;
  flushOutboundQueue: (sessionId: string) => void;
}

interface SessionConnectionContext {
  deps: ConnectSessionDeps;
  sessionId: string;
  reconnectKey: string;
  connection: WsConnection | null;
}

function isCurrentConnection(context: SessionConnectionContext): boolean {
  const { get } = context.deps.ctx;
  return get().sessions[context.sessionId]?.conn === context.connection;
}

function handleConnectionOpen(context: SessionConnectionContext): void {
  if (!isCurrentConnection(context)) return;
  const { ctx, reinitOnReconnect, flushOutboundQueue } = context.deps;
  const { get, set } = ctx;
  resetReconnectState(context.reconnectKey);
  set(updateSession(get(), context.sessionId, { isConnected: true }));
  useConnectionStatusStore.getState().reportSource(context.reconnectKey, "connected");
  // The backend's session map is per-connection, so replay init before
  // delivering prompts and responses queued while the socket was down.
  reinitOnReconnect(context.sessionId);
  flushOutboundQueue(context.sessionId);
  // Catch up on agent output streamed while the client was disconnected.
  void resyncMessagesOnReconnect(ctx, context.sessionId);
}

function handleConnectionClose(
  context: SessionConnectionContext,
  intentional: boolean,
  event: CloseEvent,
): void {
  if (!isCurrentConnection(context) || intentional) return;
  const { ctx, rejectPendingRequests } = context.deps;
  const { get, set } = ctx;
  // Apply buffered tokens before the connection error so transcript order is stable.
  flushStreamDeltas(ctx, context.sessionId);
  const session = get().sessions[context.sessionId];
  if (session) rejectPendingRequests(session);
  const wasRunning = session != null && isTurnActive(session.lifecycle);
  const alreadyReportedReconnect = session?.blocks.at(-1)?.errorCode === "WS_RECONNECTING";
  const closedDerived =
    wasRunning && !alreadyReportedReconnect
      ? appendErrorBlockPatch(session, "Connection lost while streaming. Reconnecting…", {
          code: "WS_RECONNECTING",
          idPrefix: "ws-err-close",
        })
      : { blocks: session?.blocks ?? [] };
  const retryAfterMs = event.code === 1013 ? WS_RATE_LIMIT_RETRY_MS : null;
  if (retryAfterMs != null && !isRateLimited()) notifyRateLimited(retryAfterMs);
  set(
    updateSession(get(), context.sessionId, {
      conn: null,
      isConnected: false,
      // Session IDs are stable across transport hiccups; onOpen replays init.
      lifecycle: transitionTurn(session?.lifecycle ?? createSessionEntry().lifecycle, {
        type: "connection_lost",
      }),
      ...closedDerived,
    }),
  );
  useConnectionStatusStore
    .getState()
    .reportSource(
      context.reconnectKey,
      "reconnecting",
      retryAfterMs == null
        ? `Session WebSocket closed (${event.code})`
        : `Session WebSocket rate limited; retrying in ${Math.ceil(retryAfterMs / 1000)}s`,
    );
  if (event.code && event.code !== 1000) {
    console.warn("Session WebSocket closed unexpectedly", {
      code: event.code,
      reason: event.reason || "no reason",
      sessionId: context.sessionId,
    });
  }
  scheduleReconnect(context.reconnectKey, () => get().connect(context.sessionId), {
    minimumDelayMs: event.code === 1006 ? WS_RATE_LIMIT_RETRY_MS : (retryAfterMs ?? undefined),
  });
}

function handleConnectionError(context: SessionConnectionContext, intentional: boolean): void {
  if (!isCurrentConnection(context) || intentional) return;
  const { ctx, rejectPendingRequests } = context.deps;
  const { get, set } = ctx;
  flushStreamDeltas(ctx, context.sessionId);
  const session = get().sessions[context.sessionId];
  if (session) rejectPendingRequests(session);
  set(
    updateSession(get(), context.sessionId, {
      conn: null,
      isConnected: false,
      // Session IDs are stable across transport hiccups; onOpen replays init.
      lifecycle: transitionTurn(session?.lifecycle ?? createSessionEntry().lifecycle, {
        type: "turn_errored",
      }),
    }),
  );
  useConnectionStatusStore
    .getState()
    .reportSource(context.reconnectKey, "reconnecting", "Session WebSocket error");
  // A blocked transport can prevent the backend's 1013 frame from reaching
  // the browser, which then reports only an error/1006. Preserve the same
  // bounded retry floor instead of immediately feeding another connection.
  scheduleReconnect(context.reconnectKey, () => get().connect(context.sessionId), {
    minimumDelayMs: WS_RATE_LIMIT_RETRY_MS,
  });
}

function createSessionConnection(context: SessionConnectionContext): WsConnection {
  return createWsConnection({
    url: getWsUrl(),
    protocols: getWsProtocols(),
    onOpen: () => handleConnectionOpen(context),
    onClose: (intentional, event) => handleConnectionClose(context, intentional, event),
    onError: (intentional) => handleConnectionError(context, intentional),
    onMessage: (data) => {
      if (!isCurrentConnection(context)) return;
      handleSocketMessage(context.deps.socketDeps, context.sessionId, data);
    },
  });
}

export function connectSession(deps: ConnectSessionDeps, sessionId: string): void {
  const { ctx, sourceKey, forceReconnectSession } = deps;
  const { get, set } = ctx;
  const existing = get().sessions[sessionId];
  if (existing?.conn && (existing.conn.isOpen() || existing.conn.isConnecting())) {
    return;
  }

  const entry = existing ?? createSessionEntry();
  const reconnectKey = sourceKey(sessionId);
  registerReconnector(reconnectKey, () => forceReconnectSession(sessionId), {
    onManualRequired: reportManualReconnectRequired,
  });
  // A replaced mobile socket can remain registered while its close is in
  // flight, so every callback verifies it still owns the shared store entry.
  const context: SessionConnectionContext = {
    deps,
    sessionId,
    reconnectKey,
    connection: null,
  };
  const conn = createSessionConnection(context);
  context.connection = conn;

  set({
    sessions: {
      ...get().sessions,
      [sessionId]: {
        ...entry,
        conn,
        streamingState: existing?.streamingState ?? entry.streamingState,
      },
    },
  });
}
