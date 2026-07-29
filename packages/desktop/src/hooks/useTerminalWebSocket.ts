import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { createWsConnection, type WsConnection } from "@/lib/ws-connection";
import { getTerminalWsUrl, getWsProtocols } from "@/lib/ws-url";
import {
  scheduleReconnect,
  registerReconnector,
  unregisterReconnector,
  resetReconnectState,
  forceReconnect,
  WS_RATE_LIMIT_RETRY_MS,
} from "@/lib/ws-reconnect";
import {
  reportManualReconnectRequired,
  useConnectionStatusStore,
} from "@/stores/connection-status-store";

// -- Silent-failure visibility --
//
// `WsConnection.send` returns `false` when the underlying socket isn't OPEN
// (mid-reconnect, CLOSING, etc). Every caller in this file used to drop that
// signal on the floor, which is the leading suspect for the "terminal goes
// unresponsive and only the X button works" bug: the user types, the WS is
// silently in a non-OPEN state, and the keystrokes go nowhere. We surface
// drops via sonner — sonner dedupes by `id` so a stream of keystrokes
// against a frozen WS produces one toast, not a flood.
const TERMINAL_DROPPED_TOAST_ID = "terminal-write-dropped";

// Debounce window for the "drop → force reconnect" recovery loop. A single
// stuck WS will drop every keystroke until it self-closes — without a
// debounce we'd kick off a new connection on every key. 3 s gives the
// freshly-opened socket enough time to either succeed (writes start landing
// again) or fail (`onClose` schedules the next attempt with backoff).
const FORCE_RECONNECT_COOLDOWN_MS = 3000;

// Dev-only freeze toggle. Lets us reproduce the unresponsive state
// deterministically: from DevTools run `window.__cadencrTerminal.freeze()`,
// then type in the terminal — `write()` short-circuits the same way it does
// in the wild when the WS is wedged. `unfreeze()` restores normal behaviour.
// Gated on `import.meta.env.DEV` so the global never ships to users.
const devFrozen = { current: false };
if (typeof window !== "undefined" && import.meta.env.DEV) {
  type DevTerminalGlobal = { freeze: () => void; unfreeze: () => void };
  const w = window as Window & { __cadencrTerminal?: DevTerminalGlobal };
  if (!w.__cadencrTerminal) {
    w.__cadencrTerminal = {
      freeze: () => {
        devFrozen.current = true;
        console.warn("[cadencr] terminal WS frozen — writes will be dropped");
      },
      unfreeze: () => {
        devFrozen.current = false;
        console.warn("[cadencr] terminal WS unfrozen");
      },
    };
  }
}

// -- Message types matching Rust backend protocol --

interface TerminalMessageData {
  type: "data";
  data: string;
}

interface TerminalMessageReady {
  type: "ready";
  pty_id: string;
  cwd: string;
}

interface TerminalMessageExit {
  type: "exit";
  code: number;
}

interface TerminalMessageReconnected {
  type: "reconnected";
  scrollback: string;
  alive: boolean;
  cwd: string | null;
}

interface TerminalMessageError {
  type: "error";
  message: string;
}

type TerminalMessage =
  | TerminalMessageData
  | TerminalMessageReady
  | TerminalMessageExit
  | TerminalMessageReconnected
  | TerminalMessageError;

export interface UseTerminalWebSocketOptions {
  featureId?: number;
  projectId?: number;
  ptyId?: string;
  /**
   * Explicit cwd to spawn the PTY in. The backend validates it against the
   * feature's worktree/project path and uses it verbatim when valid; otherwise
   * it falls back to its own DB lookup. Lets the UI pin a fresh PTY to the
   * directory it just observed (e.g. on "Restart here") without depending on
   * a second snapshot read.
   */
  requestedCwd?: string;
  onData: (data: string) => void;
  onExit: (code: number) => void;
  onReady: (ptyId: string, cwd: string) => void;
  onReconnected: (scrollback: string, alive: boolean, cwd: string | null) => void;
  onError: (message: string) => void;
}

interface UseTerminalWebSocketReturn {
  /** Initiate the WebSocket connection. Call after terminal is fitted to pass accurate dimensions. */
  connect: (cols: number, rows: number) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  isConnected: boolean;
}

interface BuildOptions {
  featureId?: number;
  projectId?: number;
  ptyId?: string;
  requestedCwd?: string;
}

function buildWsUrl(options: BuildOptions, cols?: number, rows?: number): string {
  const params = new URLSearchParams();
  if (options.featureId != null) params.set("feature_id", String(options.featureId));

  if (options.ptyId) {
    params.set("pty_id", options.ptyId);
  } else {
    if (options.projectId != null) params.set("project_id", String(options.projectId));
    if (cols != null) params.set("cols", String(cols));
    if (rows != null) params.set("rows", String(rows));
    if (options.requestedCwd) params.set("cwd", options.requestedCwd);
  }

  return `${getTerminalWsUrl()}?${params.toString()}`;
}

interface TerminalConnectionRefs {
  connRef: { current: WsConnection | null };
  dimsRef: { current: { cols: number; rows: number } | null };
  lastForcedAtRef: { current: number };
  latestPtyIdRef: { current: string | undefined };
  optionsRef: { current: UseTerminalWebSocketOptions };
}

function handleTerminalMessage(data: string, refs: TerminalConnectionRefs): void {
  try {
    const message = JSON.parse(data) as TerminalMessage;
    const callbacks = refs.optionsRef.current;
    switch (message.type) {
      case "data":
        callbacks.onData(message.data);
        break;
      case "ready":
        refs.latestPtyIdRef.current = message.pty_id;
        callbacks.onReady(message.pty_id, message.cwd);
        break;
      case "exit":
        callbacks.onExit(message.code);
        break;
      case "reconnected":
        callbacks.onReconnected(message.scrollback, message.alive, message.cwd);
        if (!message.alive) refs.latestPtyIdRef.current = undefined;
        break;
      case "error":
        callbacks.onError(message.message);
        break;
    }
  } catch {
    refs.optionsRef.current.onError("Failed to parse terminal message");
  }
}

function useTerminalConnector(
  options: UseTerminalWebSocketOptions,
  setIsConnected: (connected: boolean) => void,
) {
  const refs: TerminalConnectionRefs = {
    connRef: useRef<WsConnection | null>(null),
    dimsRef: useRef<{ cols: number; rows: number } | null>(null),
    lastForcedAtRef: useRef(0),
    latestPtyIdRef: useRef<string | undefined>(options.ptyId),
    optionsRef: useRef(options),
  };
  refs.optionsRef.current = options;
  const reconnectKey = useRef(`terminal:${crypto.randomUUID()}`).current;
  const doConnect = useCallback(
    (cols: number, rows: number) => {
      refs.dimsRef.current = { cols, rows };
      refs.connRef.current?.close(1000, "reconnect");
      const buildOptions: BuildOptions = {
        featureId: refs.optionsRef.current.featureId,
        projectId: refs.optionsRef.current.projectId,
        requestedCwd: refs.optionsRef.current.requestedCwd,
        ptyId: refs.latestPtyIdRef.current,
      };
      const reconnect = (): void => {
        const dimensions = refs.dimsRef.current;
        if (dimensions) doConnect(dimensions.cols, dimensions.rows);
      };
      refs.connRef.current = createWsConnection({
        url: buildWsUrl(buildOptions, cols, rows),
        protocols: getWsProtocols(),
        onOpen: () => {
          setIsConnected(true);
          resetReconnectState(reconnectKey);
          refs.lastForcedAtRef.current = 0;
          toast.dismiss(TERMINAL_DROPPED_TOAST_ID);
          useConnectionStatusStore.getState().reportSource(reconnectKey, "connected");
        },
        onMessage: (data) => handleTerminalMessage(data, refs),
        onError: (intentional) => {
          if (intentional) return;
          useConnectionStatusStore
            .getState()
            .reportSource(reconnectKey, "reconnecting", "Terminal WebSocket error");
        },
        onClose: (intentional, event) => {
          setIsConnected(false);
          if (intentional) return;
          refs.optionsRef.current.onError("Connection lost. Reconnecting…");
          useConnectionStatusStore
            .getState()
            .reportSource(reconnectKey, "reconnecting", "Terminal WebSocket dropped");
          scheduleReconnect(reconnectKey, reconnect, {
            minimumDelayMs:
              event.code === 1006 || event.code === 1013 ? WS_RATE_LIMIT_RETRY_MS : undefined,
          });
        },
      });
    },
    [reconnectKey, setIsConnected],
  );
  return useMemo(() => ({ doConnect, reconnectKey, refs }), [doConnect, reconnectKey]);
}

type TerminalConnector = ReturnType<typeof useTerminalConnector>;

function reportDroppedWrite(data: string, connector: TerminalConnector): void {
  const { connRef, lastForcedAtRef } = connector.refs;
  const connection = connRef.current;
  console.warn("[terminal] dropped write", {
    bytes: data.length,
    isOpen: connection?.isOpen() ?? false,
    isConnecting: connection?.isConnecting() ?? false,
    devFrozen: devFrozen.current,
  });
  toast.error("Terminal disconnected — your input was dropped. Reconnecting…", {
    id: TERMINAL_DROPPED_TOAST_ID,
  });
  const now = Date.now();
  if (now - lastForcedAtRef.current < FORCE_RECONNECT_COOLDOWN_MS) return;
  lastForcedAtRef.current = now;
  useConnectionStatusStore
    .getState()
    .reportSource(connector.reconnectKey, "reconnecting", "Terminal write stalled");
  forceReconnect(connector.reconnectKey);
}

function useTerminalSocketActions(connector: TerminalConnector) {
  const { doConnect, reconnectKey, refs } = connector;
  const connect = useCallback(
    (cols: number, rows: number) => {
      doConnect(cols, rows);
      registerReconnector(
        reconnectKey,
        () => {
          const dimensions = refs.dimsRef.current;
          if (dimensions) doConnect(dimensions.cols, dimensions.rows);
        },
        { onManualRequired: reportManualReconnectRequired },
      );
    },
    [doConnect, reconnectKey, refs.dimsRef],
  );
  useEffect(
    () => () => {
      refs.connRef.current?.close(1000, "unmount");
      unregisterReconnector(reconnectKey);
      useConnectionStatusStore.getState().clearSource(reconnectKey);
    },
    [reconnectKey, refs.connRef],
  );
  const write = useCallback(
    (data: string) => {
      const connection = refs.connRef.current;
      if (devFrozen.current || !connection || !connection.sendJson({ type: "write", data })) {
        reportDroppedWrite(data, connector);
      }
    },
    [connector, refs.connRef],
  );
  const resize = useCallback(
    (cols: number, rows: number) => {
      refs.dimsRef.current = { cols, rows };
      const connection = refs.connRef.current;
      if (
        devFrozen.current ||
        !connection ||
        !connection.sendJson({ type: "resize", cols, rows })
      ) {
        console.warn("[terminal] dropped resize", { cols, rows });
      }
    },
    [refs.connRef, refs.dimsRef],
  );
  const kill = useCallback(() => {
    const connection = refs.connRef.current;
    if (devFrozen.current || !connection || !connection.sendJson({ type: "kill" })) {
      console.warn("[terminal] dropped kill");
    }
  }, [refs.connRef]);
  return useMemo(() => ({ connect, kill, resize, write }), [connect, kill, resize, write]);
}

export function useTerminalWebSocket(
  options: UseTerminalWebSocketOptions,
): UseTerminalWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const connector = useTerminalConnector(options, setIsConnected);
  const actions = useTerminalSocketActions(connector);
  return useMemo(() => ({ ...actions, isConnected }), [actions, isConnected]);
}
