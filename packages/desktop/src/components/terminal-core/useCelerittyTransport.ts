import { useMemo, useRef } from "react";
import type { TerminalTransport } from "celeritty";
import { createTerminalTransportBridge } from "./terminal-transport-bridge";

interface TerminalSocketHandle {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

export interface CelerittyTransportBridge {
  transport: TerminalTransport;
  /** Call from the socket's `onData` callback to forward bytes to whoever attached. */
  deliverData: (data: string) => void;
  deliverSnapshot: (data: string) => void;
  /** Call from the socket's `onExit`/`onError` callback to signal closure. */
  deliverClose: (reason?: string) => void;
}

/**
 * Presents the shell terminal's WebSocket hook as a `TerminalTransport`.
 *
 * The hook does considerably more than four methods: `connect`/`kill`, PTY
 * reattachment by id, exit codes, scrollback replay on reconnect, stall
 * recovery. None of that is the component's business — the controller calls
 * `connect`/`kill` itself at the right lifecycle points, and this file wraps
 * only the four methods `TerminalTransport` needs.
 *
 * `useTerminalWebSocket`'s `onData`/`onExit`/`onError` are callbacks fixed at
 * hook-call time, not a subscription registry — the opposite direction from
 * `TerminalTransport.onData`, which the *terminal* calls to register its own
 * listener. `deliverData`/`deliverClose` are the bridge: the controller wires
 * the socket's fixed callbacks to call them, and they fan out to whatever
 * `Terminal.attach()` registered via `transport.onData()`.
 *
 * The backend incrementally decodes UTF-8 across PTY read boundaries; encoding
 * its complete string messages here preserves those code points.
 */
export function useCelerittyTransport(socket: TerminalSocketHandle): CelerittyTransportBridge {
  const socketRef = useRef(socket);
  socketRef.current = socket;
  return useMemo((): CelerittyTransportBridge => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bridge = createTerminalTransportBridge({
      write: (bytes) => socketRef.current.write(decoder.decode(bytes)),
      resize: (columns, rows) => socketRef.current.resize(columns, rows),
    });
    return {
      ...bridge,
      deliverData: (data) => bridge.deliverData(encoder.encode(data)),
      deliverSnapshot: (data) => bridge.deliverSnapshot(encoder.encode(data)),
    };
  }, []);
}
