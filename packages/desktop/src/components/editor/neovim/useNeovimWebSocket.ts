import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { createWsConnection, type WsConnection } from "@/lib/ws-connection";
import { getNeovimWsUrl, getWsProtocols } from "@/lib/ws-url";
import {
  scheduleReconnect,
  registerReconnector,
  unregisterReconnector,
  resetReconnectState,
} from "@/lib/ws-reconnect";
import { useConnectionStatusStore } from "@/stores/connection-status-store";

const WRITE_DROPPED_TOAST_ID = "neovim-write-dropped";

const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("data"), data: z.string() }),
  z.object({ type: z.literal("attached"), scrollback: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
type ServerMessage = z.infer<typeof serverMessageSchema>;

export interface UseNeovimWebSocketOptions {
  featureId: number;
  /** Raw PTY output, decoded from the wire text into bytes for the engine. */
  onData: (bytes: Uint8Array) => void;
  /** Buffered output sent once per (re)connection — the backend keeps one session per feature. */
  onAttached: (scrollback: Uint8Array) => void;
  onError: (message: string) => void;
}

export interface UseNeovimWebSocketReturn {
  connect: () => void;
  write: (bytes: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  detach: () => void;
  isConnected: boolean;
  lastError: string | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function handleMessage(
  raw: string,
  optionsRef: { current: UseNeovimWebSocketOptions },
  lastErrorSetter: React.Dispatch<React.SetStateAction<string | null>>,
  onAttached: () => void,
): void {
  let message: ServerMessage;
  try {
    message = serverMessageSchema.parse(JSON.parse(raw));
  } catch {
    lastErrorSetter("Failed to parse neovim message");
    optionsRef.current.onError("Failed to parse neovim message");
    return;
  }
  switch (message.type) {
    case "data":
      optionsRef.current.onData(encoder.encode(message.data));
      break;
    case "attached":
      onAttached();
      optionsRef.current.onAttached(encoder.encode(message.scrollback));
      break;
    case "error":
      lastErrorSetter(message.message);
      optionsRef.current.onError(message.message);
      break;
  }
}

function useNeovimWriter(
  connRef: { current: WsConnection | null },
  optionsRef: { current: UseNeovimWebSocketOptions },
) {
  return useCallback(
    (bytes: Uint8Array) => {
      const connection = connRef.current;
      const text = decoder.decode(bytes);
      if (!connection || !connection.sendJson({ type: "write", data: text })) {
        toast.error("Neovim disconnected — your input was dropped. Reconnecting…", {
          id: WRITE_DROPPED_TOAST_ID,
        });
        optionsRef.current.onError("Write dropped: connection is not open");
      }
    },
    [connRef, optionsRef],
  );
}

/**
 * Connects to a feature's Neovim PTY over `/api/neovim/ws`.
 *
 * Simpler than `useTerminalWebSocket`: there is no resumable `pty_id` and no
 * dimensions to pass at connect time — the backend keeps one session per
 * feature and replays its scrollback via `attached` on every (re)connection,
 * and `resize` is a separate, independently callable message.
 */
export function useNeovimWebSocket(options: UseNeovimWebSocketOptions): UseNeovimWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const connRef = useRef<WsConnection | null>(null);
  const generationRef = useRef(0);
  const attachedRef = useRef(false);
  const dimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const reconnectKey = useRef(
    `neovim:${optionsRef.current.featureId}:${crypto.randomUUID()}`,
  ).current;

  const doConnect = useCallback(() => {
    const generation = ++generationRef.current;
    attachedRef.current = false;
    setIsConnected(false);
    connRef.current?.close(1000, "reconnect");
    const url = `${getNeovimWsUrl()}?feature_id=${optionsRef.current.featureId}`;
    connRef.current = createWsConnection({
      url,
      protocols: getWsProtocols(),
      onOpen: () => {
        if (generation !== generationRef.current) return;
        setIsConnected(true);
        setLastError(null);
        resetReconnectState(reconnectKey);
        useConnectionStatusStore.getState().reportSource(reconnectKey, "connected");
      },
      onMessage: (data) => {
        if (generation !== generationRef.current) return;
        handleMessage(data, optionsRef, setLastError, () => {
          attachedRef.current = true;
          if (dimensionsRef.current) {
            connRef.current?.sendJson({ type: "resize", ...dimensionsRef.current });
          }
        });
      },
      onError: (intentional) => {
        if (intentional || generation !== generationRef.current) return;
        useConnectionStatusStore
          .getState()
          .reportSource(reconnectKey, "reconnecting", "Neovim WebSocket error");
      },
      onClose: (intentional) => {
        if (generation !== generationRef.current) return;
        attachedRef.current = false;
        setIsConnected(false);
        if (intentional || generation !== generationRef.current) return;
        // Do not overwrite a server-sent error with a generic reconnect message.
        // The server sends an explicit error before closing when the process
        // could not be started; the user should see that, not "Reconnecting…".
        useConnectionStatusStore
          .getState()
          .reportSource(reconnectKey, "reconnecting", "Neovim WebSocket dropped");
        scheduleReconnect(reconnectKey, doConnect);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectKey]);

  const connect = useCallback(() => {
    doConnect();
    registerReconnector(reconnectKey, doConnect);
  }, [doConnect, reconnectKey]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      attachedRef.current = false;
      connRef.current?.close(1000, "unmount");
      unregisterReconnector(reconnectKey);
      useConnectionStatusStore.getState().clearSource(reconnectKey);
    },
    [reconnectKey],
  );

  const write = useNeovimWriter(connRef, optionsRef);

  const resize = useCallback((cols: number, rows: number) => {
    dimensionsRef.current = { cols, rows };
    if (!attachedRef.current) return;
    const connection = connRef.current;
    if (!connection || !connection.sendJson({ type: "resize", cols, rows })) {
      console.warn("[neovim] dropped resize", { cols, rows });
    }
  }, []);

  const detach = useCallback(() => {
    generationRef.current += 1;
    attachedRef.current = false;
    unregisterReconnector(reconnectKey);
    useConnectionStatusStore.getState().clearSource(reconnectKey);
    const connection = connRef.current;
    connection?.sendJson({ type: "detach" });
    connection?.close(1000, "detach");
    connRef.current = null;
    setIsConnected(false);
  }, [reconnectKey]);

  return useMemo(
    () => ({ connect, write, resize, detach, isConnected, lastError }),
    [connect, write, resize, detach, isConnected, lastError],
  );
}
