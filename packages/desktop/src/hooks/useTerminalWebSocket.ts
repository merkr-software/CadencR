import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { createWsConnection, type WsConnection } from "@/lib/ws-connection";
import { getTerminalWsUrl, getWsProtocols } from "@/lib/ws-url";
import {
  scheduleReconnect,
  registerReconnector,
  unregisterReconnector,
  resetReconnectState,
  forceReconnect,
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

  if (options.ptyId) {
    params.set("pty_id", options.ptyId);
  } else {
    if (options.featureId != null) params.set("feature_id", String(options.featureId));
    if (options.projectId != null) params.set("project_id", String(options.projectId));
    if (cols != null) params.set("cols", String(cols));
    if (rows != null) params.set("rows", String(rows));
    if (options.requestedCwd) params.set("cwd", options.requestedCwd);
  }

  return `${getTerminalWsUrl()}?${params.toString()}`;
}

export function useTerminalWebSocket(
  options: UseTerminalWebSocketOptions,
): UseTerminalWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const connRef = useRef<WsConnection | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Latest known PTY id. Seeded from `options.ptyId` (when reconnecting to
  // a known PTY) and overwritten when the backend sends `ready` /
  // `reconnected`. The reconnector reads this so it always reattaches
  // to the live PTY rather than spawning a fresh shell on every blip.
  const latestPtyIdRef = useRef<string | undefined>(options.ptyId);
  // Last fitted dimensions — needed when reconnecting without a known
  // PTY (fresh fallback, e.g. after a >300s grace expiry the backend
  // may still need cols/rows to spawn a new shell).
  const dimsRef = useRef<{ cols: number; rows: number } | null>(null);

  // Stable per-instance key for the ws-reconnect registry. Random suffix
  // because the same featureId could host multiple terminal panes.
  const reconnectKey = useRef(`terminal:${crypto.randomUUID()}`).current;

  // Last wall-clock time we kicked off a force-reconnect from `write()`.
  // Used to debounce the recovery loop: a stuck WS drops every keystroke,
  // we only want one reconnection attempt per `FORCE_RECONNECT_COOLDOWN_MS`.
  const lastForcedAtRef = useRef(0);

  const doConnect = useCallback(
    (cols: number, rows: number) => {
      dimsRef.current = { cols, rows };

      // Tear down previous connection if any.
      connRef.current?.close(1000, "reconnect");

      // Always prefer the latest known PTY id over the prop — `optionsRef`
      // may still be holding the original `existingPtyId`, but a freshly-
      // spawned PTY's id lives only in `latestPtyIdRef`.
      const buildOpts: BuildOptions = {
        featureId: optionsRef.current.featureId,
        projectId: optionsRef.current.projectId,
        requestedCwd: optionsRef.current.requestedCwd,
        ptyId: latestPtyIdRef.current,
      };

      const conn = createWsConnection({
        url: buildWsUrl(buildOpts, cols, rows),
        protocols: getWsProtocols(),
        onOpen: () => {
          setIsConnected(true);
          resetReconnectState(reconnectKey);
          // Clear the force-reconnect debounce so a *later* stall triggers
          // immediate recovery rather than waiting out the cooldown window
          // we started during the prior failure.
          lastForcedAtRef.current = 0;
          // Dismiss the drop toast (if any) so the user sees the recovery
          // succeed rather than being left staring at "Reconnecting…".
          toast.dismiss(TERMINAL_DROPPED_TOAST_ID);
          useConnectionStatusStore.getState().reportSource(reconnectKey, "connected");
        },
        onMessage: (data) => {
          try {
            const msg = JSON.parse(data) as TerminalMessage;
            const cb = optionsRef.current;
            switch (msg.type) {
              case "data":
                cb.onData(msg.data);
                break;
              case "ready":
                latestPtyIdRef.current = msg.pty_id;
                cb.onReady(msg.pty_id, msg.cwd);
                break;
              case "exit":
                cb.onExit(msg.code);
                break;
              case "reconnected":
                cb.onReconnected(msg.scrollback, msg.alive, msg.cwd);
                if (!msg.alive) {
                  // PTY is gone (>300s grace). Drop the stored id so any
                  // future reconnect would spawn fresh rather than
                  // hammering an empty handle.
                  latestPtyIdRef.current = undefined;
                }
                break;
              case "error":
                cb.onError(msg.message);
                break;
            }
          } catch {
            optionsRef.current.onError("Failed to parse terminal message");
          }
        },
        onError: (intentional) => {
          // `intentional` is true when our own `close()` flipped the flag —
          // covers both explicit reconnect and unmount cleanup, so no
          // separate "unmounted" guard is needed here.
          if (intentional) return;
          useConnectionStatusStore
            .getState()
            .reportSource(reconnectKey, "reconnecting", "Terminal WebSocket error");
        },
        onClose: (intentional) => {
          setIsConnected(false);
          if (intentional) return;
          // Surface to the user inside the xterm buffer + global indicator,
          // then schedule a backoff reconnect. The backend keeps PTYs
          // alive for 300s so most reconnects within that window will
          // resume cleanly via the `?pty_id=` path.
          optionsRef.current.onError("Connection lost. Reconnecting…");
          useConnectionStatusStore
            .getState()
            .reportSource(reconnectKey, "reconnecting", "Terminal WebSocket dropped");
          scheduleReconnect(reconnectKey, () => {
            const dims = dimsRef.current;
            if (dims) doConnect(dims.cols, dims.rows);
          });
        },
      });

      connRef.current = conn;
    },
    [reconnectKey],
  );

  const connect = useCallback(
    (cols: number, rows: number) => {
      doConnect(cols, rows);
      // Register so the watchdog can force this terminal to reconnect on
      // wake/online without waiting for TCP-level close detection.
      registerReconnector(
        reconnectKey,
        () => {
          const dims = dimsRef.current;
          if (dims) doConnect(dims.cols, dims.rows);
        },
        { onManualRequired: reportManualReconnectRequired },
      );
    },
    [doConnect, reconnectKey],
  );

  // Clean up WebSocket + reconnect registry on unmount. The WS connection
  // itself flips `intentional=true` inside `close()`, which gates the
  // close/error callbacks from running stale React state — so no
  // separate "is the hook still mounted" guard is needed.
  useEffect(() => {
    return () => {
      connRef.current?.close(1000, "unmount");
      unregisterReconnector(reconnectKey);
      useConnectionStatusStore.getState().clearSource(reconnectKey);
    };
  }, [reconnectKey]);

  const write = useCallback(
    (data: string) => {
      const conn = connRef.current;
      if (devFrozen.current || !conn || !conn.sendJson({ type: "write", data })) {
        // Silent drop — surface to the user (deduped by toast id) and log
        // with the connection state for diagnostics. Without this, the terminal
        // looks frozen for no visible reason.
        console.warn("[terminal] dropped write", {
          bytes: data.length,
          isOpen: conn?.isOpen() ?? false,
          isConnecting: conn?.isConnecting() ?? false,
          devFrozen: devFrozen.current,
        });
        toast.error("Terminal disconnected — your input was dropped. Reconnecting…", {
          id: TERMINAL_DROPPED_TOAST_ID,
        });
        // Self-heal: force the reconnector to run *now* instead of waiting
        // for `onClose` to fire (which can take forever when the socket is
        // wedged in `CLOSING` or `OPEN` over dead TCP — exactly the bug the
        // user hit, and exactly what `window.__cadencrTerminal.freeze()`
        // reproduces). The reconnect re-uses the latest known `pty_id` so
        // the user reattaches to their live shell rather than spawning a
        // fresh one (the backend keeps PTYs for 300 s after disconnect).
        // Debounced so a flurry of keystrokes triggers one reconnect, not
        // a parade.
        const now = Date.now();
        if (now - lastForcedAtRef.current >= FORCE_RECONNECT_COOLDOWN_MS) {
          lastForcedAtRef.current = now;
          useConnectionStatusStore
            .getState()
            .reportSource(reconnectKey, "reconnecting", "Terminal write stalled");
          forceReconnect(reconnectKey);
        }
      }
    },
    [reconnectKey],
  );

  const resize = useCallback((cols: number, rows: number) => {
    dimsRef.current = { cols, rows };
    const conn = connRef.current;
    if (devFrozen.current || !conn || !conn.sendJson({ type: "resize", cols, rows })) {
      console.warn("[terminal] dropped resize", { cols, rows });
    }
  }, []);

  const kill = useCallback(() => {
    const conn = connRef.current;
    if (devFrozen.current || !conn || !conn.sendJson({ type: "kill" })) {
      console.warn("[terminal] dropped kill");
    }
  }, []);

  return { connect, write, resize, kill, isConnected };
}
