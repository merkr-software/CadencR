/**
 * Shared WebSocket connection factory.
 * Encapsulates: creation, event wiring, readiness-gated send, intentional-close cleanup.
 */

const CONNECTING = 0;
const OPEN = 1;

/** What a connection needs from a socket: a browser `WebSocket`, or a test's fake. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Event) => void,
  ): void;
}

export type WebSocketFactory = (url: string, protocols: string[] | undefined) => WebSocketLike;

const browserWebSocket: WebSocketFactory = (url, protocols) => new WebSocket(url, protocols);

export interface WsConnectionOptions {
  url: string;
  /** Forwarded to `new WebSocket(url, protocols)`; see `getWsProtocols`. */
  protocols?: string[];
  /** Defaults to the browser's `WebSocket`. */
  createSocket?: WebSocketFactory;
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
  const ws = (options.createSocket ?? browserWebSocket)(options.url, protocols);
  let intentionalClose = false;

  ws.addEventListener("open", () => options.onOpen?.());
  ws.addEventListener("message", (e) => options.onMessage((e as MessageEvent).data as string));
  ws.addEventListener("error", () => options.onError?.(intentionalClose));
  ws.addEventListener("close", (event) => options.onClose?.(intentionalClose, event as CloseEvent));

  const conn: WsConnection = {
    send(data: string): boolean {
      if (ws.readyState === OPEN) {
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
      if (ws.readyState === OPEN || ws.readyState === CONNECTING) {
        ws.close(code, reason);
      }
    },
    isOpen(): boolean {
      return ws.readyState === OPEN;
    },
    isConnecting(): boolean {
      return ws.readyState === CONNECTING;
    },
  };

  return conn;
}
