import { translateUi } from "@/lib/i18n/ui";
import type { TerminalOutputOptions, TerminalTransport } from "celeritty";

export interface ByteTerminalSocket {
  write: (bytes: Uint8Array) => void;
  resize: (columns: number, rows: number) => void;
}

/** A terminal may finish loading well after its PTY starts producing output. */
export function createTerminalTransportBridge(socket: ByteTerminalSocket) {
  const dataListeners = new Set<(bytes: Uint8Array, options?: TerminalOutputOptions) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  let pending: Array<{ bytes: Uint8Array; options?: TerminalOutputOptions }> = [];
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
    for (const { bytes, options } of buffered) {
      for (const callback of dataListeners) callback(bytes, options);
    }
  };

  const deliverData = (bytes: Uint8Array, options?: TerminalOutputOptions): void => {
    if (closed || bytes.byteLength === 0) return;
    if (dataListeners.size === 0 || pending.length > 0) {
      // Never silently trim a terminal stream mid escape sequence. Fail visibly
      // if initialization stalls; a later reconnect can replay bounded scrollback.
      if (pendingBytes + bytes.byteLength > 1024 * 1024 || pending.length >= 4096) {
        deliverClose(
          translateUi(
            "workspace.tools.terminalTransportBridge.terminalOutputBufferFullWhileRendererWas",
            "Terminal output buffer full while renderer was unavailable. Reopen the terminal to reconnect.",
          ),
        );
        return;
      }
      pending.push({ bytes: bytes.slice(), options });
      pendingBytes += bytes.byteLength;
      return;
    }
    for (const callback of dataListeners) callback(bytes, options);
  };

  const transport: TerminalTransport = {
    write: (bytes) => socket.write(bytes),
    resize: (columns, rows) => socket.resize(columns, rows),
    onData(callback) {
      dataListeners.add(callback);
      // Let attachment finish before draining buffered startup output and closure.
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
      const replay = { replyToQueries: false };
      deliverData(new TextEncoder().encode("\x1bc"), replay);
      deliverData(bytes, replay);
    },
    deliverClose,
  };
}
