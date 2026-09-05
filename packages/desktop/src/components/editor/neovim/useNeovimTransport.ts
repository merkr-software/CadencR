import { useMemo, useRef } from "react";
import type { TerminalTransport } from "celeritty";
import { createTerminalTransportBridge } from "@/components/terminal-core/terminal-transport-bridge";

interface NeovimSocketHandle {
  write: (bytes: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
}

export interface NeovimTransportBridge {
  transport: TerminalTransport;
  /** Call from the socket's `onData`/`onAttached` callback to feed the terminal. */
  deliverData: (bytes: Uint8Array) => void;
  deliverSnapshot: (bytes: Uint8Array) => void;
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
  const socketRef = useRef(socket);
  socketRef.current = socket;
  return useMemo(
    () =>
      createTerminalTransportBridge({
        write: (bytes) => socketRef.current.write(bytes),
        resize: (columns, rows) => socketRef.current.resize(columns, rows),
      }),
    [],
  );
}
