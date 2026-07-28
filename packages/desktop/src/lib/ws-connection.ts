/**
 * Shared WebSocket connection factory.
 * Encapsulates: creation, event wiring, readiness-gated send, intentional-close cleanup.
 */

export interface WsConnectionOptions {
  url: string;
  /** Forwarded to `new WebSocket(url, protocols)`; see `getWsProtocols`. */
  protocols?: string[];
  onOpen?: () => void;
  onClose?: (intentional: boolean, event: CloseEvent) => void;
  onError?: (intentional: boolean) => void;
  onMessage: (data: string) => void;
}

export interface WsConnection {
  send: (data: string) => boolean;
  sendJson: (msg: unknown) => boolean;
  close: (code?: number, reason?: string) => void;
  isOpen: () => boolean;
  isConnecting: () => boolean;
}

export function createWsConnection(options: WsConnectionOptions): WsConnection {
  const protocols =
    options.protocols && options.protocols.length > 0 ? options.protocols : undefined;
  const ws = new WebSocket(options.url, protocols);
  let intentionalClose = false;

  ws.addEventListener("open", () => options.onOpen?.());
  ws.addEventListener("message", (e) => options.onMessage(e.data as string));
  ws.addEventListener("error", () => options.onError?.(intentionalClose));
  ws.addEventListener("close", (event) => options.onClose?.(intentionalClose, event));

  const conn: WsConnection = {
    send(data: string): boolean {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        return true;
      }
      return false;
    },
    sendJson(msg: unknown): boolean {
      return conn.send(JSON.stringify(msg));
    },
    close(code = 1000, reason = "client"): void {
      intentionalClose = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    },
    isOpen(): boolean {
      return ws.readyState === WebSocket.OPEN;
    },
    isConnecting(): boolean {
      return ws.readyState === WebSocket.CONNECTING;
    },
  };

  return conn;
}
