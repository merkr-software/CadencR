/**
 * The lifecycle every long-lived backend WebSocket shares: the agent session
 * socket, the app socket (session status and app events) and a custom tab's
 * plugin stream socket. Each keeps its own connection and protocol; this owns
 * what used to be written three times, and had drifted apart:
 *
 * - **Open:** reset the backoff, report the source connected, then let the
 *   owner mark itself connected, *replay* what the server forgot with the old
 *   socket (init, subscriptions, queued commands) and only then *resync* what
 *   was missed meanwhile. Same order for every socket.
 * - **Drop:** only the first `error` or `close` of the current socket counts
 *   (a browser reports an abnormal drop as both); a stale or intentionally
 *   closed socket is ignored. One retry policy reads the close code: `1013`
 *   (service overloaded) holds every socket off for `WS_RATE_LIMIT_RETRY_MS`;
 *   `1006` or an error (a blocked transport may have eaten that `1013`) waits
 *   at least as long; anything else backs off from one second. Close codes
 *   that mean something to one socket only (`1008`: a revoked plugin grant)
 *   reach its `onDrop`.
 * - **Manual retry:** a socket that reports to the connection status registers
 *   its forced reconnect, so "Retry now" and the wake watchdog reach it, and
 *   reports when automatic retries give up.
 */

import {
  reportManualReconnectRequired,
  useConnectionStatusStore,
} from "@/stores/connection-status-store";
import { createWsConnection, type WebSocketFactory, type WsConnection } from "./ws-connection";
import {
  isRateLimited,
  notifyRateLimited,
  registerReconnector,
  resetReconnectState,
  scheduleReconnect,
  unregisterReconnector,
  WS_RATE_LIMIT_RETRY_MS,
} from "./ws-reconnect";

/** Closed on purpose: nothing went wrong. */
export const WS_CLOSE_NORMAL = 1000;
/** The service is overloaded: retry later. */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;
/** No close frame: the transport failed, or the upgrade was refused. */
export const WS_CLOSE_ABNORMAL = 1006;
/** The service refused what the socket carries (plugin grant revoked or expired). */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

export interface SocketDrop {
  cause: "error" | "close";
  /** The close code; null when an error came first. */
  code: number | null;
  /** The socket opened before it dropped; false means the upgrade failed. */
  opened: boolean;
}

export interface LifecycleSocketOptions {
  /** Reconnect registry key: backoff, manual retry and status source. */
  key: string;
  url: string;
  protocols?: string[];
  createSocket?: WebSocketFactory;
  /**
   * Connection-status source label ("Session WebSocket"). Omitted for a socket
   * that does not speak for backend reachability: it is neither reported nor
   * paused for a manual retry.
   */
  statusLabel?: string;
  /** Whether `connection` is still the one its owner holds. */
  isCurrent: (connection: WsConnection) => boolean;
  /** Open and current: record it before anything is sent. */
  onConnected?: (connection: WsConnection) => void;
  /** Re-send what the service lost with the previous socket. */
  replay?: (connection: WsConnection) => void;
  /** Catch up on what happened while disconnected; runs after `replay`. */
  resync?: (connection: WsConnection) => void;
  onMessage: (data: string) => void;
  /** First error or close of the current socket; the retry is scheduled once it returns. */
  onDrop: (drop: SocketDrop) => void;
  /** Reconnects after a drop. */
  reconnect: () => void;
  /** Whether a drop is worth retrying (default: always). */
  shouldRetry?: () => boolean;
}

/** Minimum wait before retrying this socket (the shared 1013 hold is recorded apart). */
function retryFloorMs(drop: SocketDrop): number | undefined {
  if (drop.code === WS_CLOSE_TRY_AGAIN_LATER) return WS_RATE_LIMIT_RETRY_MS;
  if (drop.cause === "error" || drop.code === WS_CLOSE_ABNORMAL) return WS_RATE_LIMIT_RETRY_MS;
  return undefined;
}

function dropReason(label: string, drop: SocketDrop): string {
  if (drop.cause === "error") return `${label} error`;
  if (drop.code === WS_CLOSE_TRY_AGAIN_LATER) {
    return `${label} rate limited; retrying in ${Math.ceil(WS_RATE_LIMIT_RETRY_MS / 1000)}s`;
  }
  return `${label} closed (${drop.code})`;
}

function scheduleRetry(options: LifecycleSocketOptions, drop: SocketDrop): void {
  const label = options.statusLabel;
  if (label !== undefined) {
    useConnectionStatusStore
      .getState()
      .reportSource(options.key, "reconnecting", dropReason(label, drop));
  }
  if (options.shouldRetry && !options.shouldRetry()) return;
  scheduleReconnect(options.key, options.reconnect, {
    minimumDelayMs: retryFloorMs(drop),
    onManualRequired: label === undefined ? undefined : reportManualReconnectRequired,
  });
}

function handleDrop(options: LifecycleSocketOptions, drop: SocketDrop): void {
  // One overloaded service: every socket holds off, not just this one.
  if (drop.code === WS_CLOSE_TRY_AGAIN_LATER && !isRateLimited()) {
    notifyRateLimited(WS_RATE_LIMIT_RETRY_MS);
  }
  try {
    options.onDrop(drop);
  } finally {
    // An owner that failed to tear down still gets its retry; the error
    // itself propagates to the socket event's handler.
    scheduleRetry(options, drop);
  }
}

/** Opens one socket of a reconnecting connection; its owner keeps the result as current. */
export function openLifecycleSocket(options: LifecycleSocketOptions): WsConnection {
  let opened = false;
  let dropped = false;
  const drop = (connection: WsConnection, next: SocketDrop): void => {
    if (dropped || !options.isCurrent(connection)) return;
    dropped = true;
    handleDrop(options, next);
  };
  const connection: WsConnection = createWsConnection({
    url: options.url,
    protocols: options.protocols,
    createSocket: options.createSocket,
    onOpen: () => {
      if (dropped || !options.isCurrent(connection)) return;
      opened = true;
      resetReconnectState(options.key);
      if (options.statusLabel !== undefined) {
        useConnectionStatusStore.getState().reportSource(options.key, "connected");
      }
      options.onConnected?.(connection);
      options.replay?.(connection);
      options.resync?.(connection);
    },
    onMessage: (data) => {
      if (options.isCurrent(connection)) options.onMessage(data);
    },
    onError: (intentional) => {
      if (!intentional) drop(connection, { cause: "error", code: null, opened });
    },
    onClose: (intentional, event) => {
      if (!intentional) drop(connection, { cause: "close", code: event.code, opened });
    },
  });
  return connection;
}

/**
 * Lets "Retry now" and the wake watchdog force a reconnect of this socket, and
 * reports when its automatic retries give up.
 */
export function registerSocketRetry(key: string, forceReconnect: () => void): void {
  registerReconnector(key, forceReconnect, { onManualRequired: reportManualReconnectRequired });
}

/** The socket is gone for good: no retry, no status source left behind. */
export function retireSocket(key: string): void {
  unregisterReconnector(key);
  useConnectionStatusStore.getState().clearSource(key);
}
