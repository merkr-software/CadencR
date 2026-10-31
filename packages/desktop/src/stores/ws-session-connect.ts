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
import {
  createSessionEntry,
  type SessionEntry,
  updateSession,
  WS_RECONNECTING_CODE,
} from "./ws-session-types";
import { isTurnActive, transitionTurn } from "./ws-turn-lifecycle";
import { resyncMessagesOnReconnect } from "./ws-session-resync";
import { handleSocketMessage, type SocketHandlerDeps } from "./ws-session-socket-handler";

interface ConnectSessionDeps {
  ctx: StoreAccessors;
  socketDeps: SocketHandlerDeps;
  sourceKey: (sessionId: string) => string;
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
  return (
    context.connection !== null &&
    context.deps.ctx.transport.get(context.sessionId)?.conn === context.connection
  );
}

function handleConnectionOpen(context: SessionConnectionContext): void {
  if (!isCurrentConnection(context)) return;
  const { ctx, reinitOnReconnect, flushOutboundQueue } = context.deps;
  const { get, set } = ctx;
  resetReconnectState(context.reconnectKey);
  set(updateSession(get(), context.sessionId, { isConnected: true, isConnecting: false }));
  useConnectionStatusStore.getState().reportSource(context.reconnectKey, "connected");
  // Rebind this viewer to the service-owned session before delivering prompts
  // and responses queued while the socket was down.
  reinitOnReconnect(context.sessionId);
  flushOutboundQueue(context.sessionId);
  // Catch up on agent output streamed while the client was disconnected.
  void resyncMessagesOnReconnect(ctx, context.sessionId);
}

/**
 * An init already on the wire is lost with the socket: dropping its id lets a
 * still-queued prompt re-run it once the transport is back. One still parked
 * in the outbound queue is replayed on reconnect, so it stays in flight.
 */
export function initRequestIdAfterDrop(
  session: SessionEntry | undefined,
  outboundQueue: readonly { id: string }[],
): string | null {
  const id = session?.initRequestId ?? null;
  return id !== null && outboundQueue.some((envelope) => envelope.id === id) ? id : null;
}

function handleConnectionClose(
  context: SessionConnectionContext,
  intentional: boolean,
  event: CloseEvent,
): void {
  if (!isCurrentConnection(context) || intentional) return;
  const { ctx } = context.deps;
  const { get, set } = ctx;
  // Apply buffered tokens before the connection error so transcript order is stable.
  flushStreamDeltas(ctx, context.sessionId);
  const session = get().sessions[context.sessionId];
  ctx.transport.rejectPendingRequests(context.sessionId);
  const transport = ctx.transport.ensure(context.sessionId);
  transport.conn = null;
  const wasRunning = session != null && isTurnActive(session.lifecycle);
  const alreadyReportedReconnect = session?.blocks.at(-1)?.errorCode === WS_RECONNECTING_CODE;
  const closedDerived =
    wasRunning && !alreadyReportedReconnect
      ? appendErrorBlockPatch(session, "Connection lost while streaming. Reconnecting…", {
          code: WS_RECONNECTING_CODE,
          idPrefix: "ws-err-close",
        })
      : { blocks: session?.blocks ?? [] };
  const retryAfterMs = event.code === 1013 ? WS_RATE_LIMIT_RETRY_MS : null;
  if (retryAfterMs != null && !isRateLimited()) notifyRateLimited(retryAfterMs);
  set(
    updateSession(get(), context.sessionId, {
      isConnected: false,
      isConnecting: false,
      initRequestId: initRequestIdAfterDrop(session, transport.outboundQueue),
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
  const { ctx } = context.deps;
  const { get, set } = ctx;
  flushStreamDeltas(ctx, context.sessionId);
  const session = get().sessions[context.sessionId];
  ctx.transport.rejectPendingRequests(context.sessionId);
  const transport = ctx.transport.ensure(context.sessionId);
  transport.conn = null;
  set(
    updateSession(get(), context.sessionId, {
      isConnected: false,
      isConnecting: false,
      initRequestId: initRequestIdAfterDrop(session, transport.outboundQueue),
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
  const transport = ctx.transport.ensure(sessionId);
  if (transport.conn && (transport.conn.isOpen() || transport.conn.isConnecting())) {
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
  transport.conn = conn;

  set({
    sessions: {
      ...get().sessions,
      [sessionId]: {
        ...entry,
        isConnected: false,
        isConnecting: true,
        streamingState: existing?.streamingState ?? entry.streamingState,
      },
    },
  });
}
