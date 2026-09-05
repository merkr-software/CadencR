import { useMemo } from "react";
import type { TerminalTransport } from "celeritty";

interface NeovimSocketHandle {
  write: (bytes: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
}

export interface NeovimTransportBridge {
  transport: TerminalTransport;
  /** Call from the socket's `onData`/`onAttached` callback to feed the terminal. */
  deliverData: (bytes: Uint8Array) => void;
  /** Call from the socket's `onError` callback to signal closure. */
  deliverClose: (reason?: string) => void;
}

/**
 * Presents `useNeovimWebSocket` as a `TerminalTransport`.
 *
 * Simpler than the shell terminal's adapter (`useCelerittyTransport`): one
 * Neovim session per feature, no `pty_id` reattachment, and — unlike the
 * shell socket — this hook already carries bytes both ways, so there is no
 * string encoding step and no UTF-8 corruption risk to note.
 *
 * `connect`/`onData`/`onAttached`/`onError` are callbacks fixed at hook-call
 * time, not a subscription registry — the opposite direction from
 * `TerminalTransport.onData`. `deliverData`/`deliverClose` are the bridge:
 * the controller wires the socket's fixed callbacks to call them, fanning out
 * to whatever `Terminal.attach()` registered via `transport.onData()`.
 */
export function useNeovimTransport(socket: NeovimSocketHandle): NeovimTransportBridge {
  return useMemo((): NeovimTransportBridge => {
    const dataListeners = new Set<(bytes: Uint8Array) => void>();
    const closeListeners = new Set<(reason?: string) => void>();

    const transport: TerminalTransport = {
      write(bytes: Uint8Array) {
        socket.write(bytes);
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
      deliverData: (bytes: Uint8Array) => {
        for (const cb of dataListeners) cb(bytes);
      },
      deliverClose: (reason?: string) => {
        for (const cb of closeListeners) cb(reason);
      },
    };
  }, [socket]);
}
