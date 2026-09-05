import type { TerminalTransport } from "celeritty";

export interface ByteTerminalSocket {
  write: (bytes: Uint8Array) => void;
  resize: (columns: number, rows: number) => void;
}

/** A terminal may finish loading well after its PTY starts producing output. */
export function createTerminalTransportBridge(socket: ByteTerminalSocket) {
  const dataListeners = new Set<(bytes: Uint8Array) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let closed: { reason?: string } | undefined;

  const deliverClose = (reason?: string): void => {
    closed = { reason };
    for (const callback of closeListeners) {
      if (pending.length > 0) {
        queueMicrotask(() => {
          if (closeListeners.has(callback)) callback(reason);
        });
      } else {
        callback(reason);
      }
    }
  };

  const flushPending = (): void => {
    if (dataListeners.size === 0) return;
    const buffered = pending;
    pending = [];
    pendingBytes = 0;
    for (const bytes of buffered) {
      for (const callback of dataListeners) callback(bytes);
    }
  };

  const deliverData = (bytes: Uint8Array): void => {
    if (closed || bytes.byteLength === 0) return;
    if (dataListeners.size === 0 || pending.length > 0) {
      // Never silently trim a terminal stream mid escape sequence. Fail visibly
      // if initialization stalls; a later reconnect can replay bounded scrollback.
      if (pendingBytes + bytes.byteLength > 1024 * 1024 || pending.length >= 4096) {
        deliverClose(
          "Terminal output buffer full while renderer was unavailable. Reopen the terminal to reconnect.",
        );
        return;
      }
      pending.push(bytes.slice());
      pendingBytes += bytes.byteLength;
      return;
    }
    for (const callback of dataListeners) callback(bytes);
  };

  const transport: TerminalTransport = {
    write: (bytes) => socket.write(bytes),
    resize: (columns, rows) => socket.resize(columns, rows),
    onData(callback) {
      dataListeners.add(callback);
      // attach() installs its outbound parser-response listener after onData.
      // Let attachment finish before replaying startup terminal queries.
      queueMicrotask(flushPending);
      return () => {
        dataListeners.delete(callback);
      };
    },
    onClose(callback) {
      closeListeners.add(callback);
      if (closed)
        queueMicrotask(() => {
          if (closed && closeListeners.has(callback)) callback(closed.reason);
        });
      return () => {
        closeListeners.delete(callback);
      };
    },
  };

  return {
    transport,
    deliverData,
    deliverSnapshot(bytes: Uint8Array) {
      // Reconnect snapshots include output we already rendered. Replace it,
      // resetting parser/mode state as well as the visible screen before replay.
      pending = [];
      pendingBytes = 0;
      closed = undefined;
      deliverData(new TextEncoder().encode("\x1bc"));
      deliverData(bytes);
    },
    deliverClose,
  };
}
