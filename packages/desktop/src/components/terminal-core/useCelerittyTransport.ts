import { useMemo } from "react";
import type { TerminalTransport } from "celeritty";

interface TerminalSocketHandle {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

export interface CelerittyTransportBridge {
  transport: TerminalTransport;
  /** Call from the socket's `onData` callback to forward bytes to whoever attached. */
  deliverData: (data: string) => void;
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
 * Encoding: the socket carries `data` as a string; `TerminalTransport` is
 * bytes both ways. Converting here is lossy for output that is not valid
 * UTF-8 — the same corruption `PROTOCOL.md` describes (a multi-byte sequence
 * split across a socket message becomes `U+FFFD`). Pre-existing in CadencR,
 * not introduced here. Followup: change `/api/terminal/ws` to carry binary
 * frames, matching the protocol celeritty's own reference transport uses.
 */
export function useCelerittyTransport(socket: TerminalSocketHandle): CelerittyTransportBridge {
  return useMemo((): CelerittyTransportBridge => {
    const dataListeners = new Set<(bytes: Uint8Array) => void>();
    const closeListeners = new Set<(reason?: string) => void>();

    const transport: TerminalTransport = {
      write(bytes: Uint8Array) {
        socket.write(new TextDecoder().decode(bytes));
      },
      resize(columns: number, rows: number) {
        socket.resize(columns, rows);
      },
      onData(cb: (bytes: Uint8Array) => void) {
        dataListeners.add(cb);
        return () => {
          dataListeners.delete(cb);
        };
      },
      onClose(cb: (reason?: string) => void) {
        closeListeners.add(cb);
        return () => {
          closeListeners.delete(cb);
        };
      },
    };

    return {
      transport,
      deliverData: (data: string) => {
        const bytes = new TextEncoder().encode(data);
        for (const cb of dataListeners) cb(bytes);
      },
      deliverClose: (reason?: string) => {
        for (const cb of closeListeners) cb(reason);
      },
    };
    // socket.write/resize close over the latest useTerminalWebSocket return
    // value; recreating this bridge only when `socket` itself changes
    // identity keeps `transport` stable across renders, which
    // `Terminal.attach` depends on to avoid detaching and reattaching.
  }, [socket]);
}
