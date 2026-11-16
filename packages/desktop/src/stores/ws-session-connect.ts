import type { WsConnection } from "@/lib/ws-connection";
import { getWsProtocols, getWsUrl } from "@/lib/ws-url";
import {
  openLifecycleSocket,
  registerSocketRetry,
  WS_CLOSE_NORMAL,
  type SocketDrop,
} from "@/lib/ws-lifecycle";
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
import { abandonInFlight } from "./ws-session-commands";
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
}

/** Open and current: replayed init and queued commands follow (see `createSessionConnection`). */
function markConnected(context: SessionConnectionContext): void {
  const { get, set } = context.deps.ctx;
  set(updateSession(get(), context.sessionId, { isConnected: true, isConnecting: false }));
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

/**
 * The socket dropped (the lifecycle reports the first error or close only,
 * and schedules the retry after this). A browser reports a service that went
 * away as an error then a 1006 close: either way this is a lost connection,
 * never a turn error — the turn goes on server-side and the reconnect resyncs it.
 */
function handleConnectionDrop(context: SessionConnectionContext, drop: SocketDrop): void {
  const { ctx } = context.deps;
  const { get, set } = ctx;
  // Apply buffered tokens before the connection error so transcript order is stable.
  flushStreamDeltas(ctx, context.sessionId);
  const session = get().sessions[context.sessionId];
  abandonInFlight(ctx, context.sessionId);
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
  set(
    updateSession(get(), context.sessionId, {
      isConnected: false,
      isConnecting: false,
      initRequestId: initRequestIdAfterDrop(session, transport.outboundQueue),
      // Session IDs are stable across transport hiccups; the reopen replays init.
      lifecycle: transitionTurn(session?.lifecycle ?? createSessionEntry().lifecycle, {
        type: "connection_lost",
      }),
      ...closedDerived,
    }),
  );
  if (drop.code !== WS_CLOSE_NORMAL) {
    console.warn("Session WebSocket dropped unexpectedly", {
      cause: drop.cause,
      code: drop.code,
      sessionId: context.sessionId,
    });
  }
}

function createSessionConnection(context: SessionConnectionContext): WsConnection {
  const { ctx, socketDeps, reinitOnReconnect, flushOutboundQueue } = context.deps;
  const { sessionId } = context;
  return openLifecycleSocket({
    key: context.reconnectKey,
    url: getWsUrl(),
    protocols: getWsProtocols(),
    statusLabel: "Session WebSocket",
    // A replaced mobile socket can remain registered while its close is in
    // flight, so every callback verifies it still owns the shared store entry.
    isCurrent: (connection) => ctx.transport.get(sessionId)?.conn === connection,
    onConnected: () => markConnected(context),
    // Rebind this viewer to the service-owned session before delivering
    // prompts and responses queued while the socket was down.
    replay: () => {
      reinitOnReconnect(sessionId);
      flushOutboundQueue(sessionId);
    },
    // Catch up on agent output streamed while the client was disconnected.
    resync: () => void resyncMessagesOnReconnect(ctx, sessionId),
    onMessage: (data) => handleSocketMessage(socketDeps, sessionId, data),
    onDrop: (drop) => handleConnectionDrop(context, drop),
    reconnect: () => ctx.get().connect(sessionId),
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
  registerSocketRetry(reconnectKey, () => forceReconnectSession(sessionId));
  const context: SessionConnectionContext = { deps, sessionId, reconnectKey };
  transport.conn = createSessionConnection(context);

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
