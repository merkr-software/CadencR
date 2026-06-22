/**
 * WebSocket implementation of `@codemirror/lsp-client`'s `Transport`
 * interface. Carries raw LSP JSON-RPC text frames between the renderer's
 * `LSPClient` and the Cadencr service's proxy at
 * `/api/lsp/sessions/:session_id/connect`.
 *
 * The transport is constructed *after* a session has been reserved via
 * `POST /api/lsp/sessions` and the WebSocket has reached `OPEN` — see
 * `connectLspWs` below. That two-step shape mirrors the backend's
 * single-use claim model so we can fail fast with HTTP error codes when a
 * language isn't supported, rather than completing a handshake just to
 * close it.
 *
 * @public
 */
import type { Transport } from "@codemirror/lsp-client";

import { resolveApiBaseUrlSync } from "@/api/client";
import { getWsProtocols } from "@/lib/ws-url";
import { applyServerEdit } from "./apply-edit-bridge";
import type { LspWorkspaceEdit } from "./workspace-edit";

/** How long we wait for the WebSocket to reach OPEN before treating the
 * connect as a failure. Long enough to absorb a single backend cold-start
 * (e.g. spawning rust-analyzer), short enough that a stuck connect doesn't
 * leave the cmd-click handler in limbo. */
const OPEN_TIMEOUT_MS = 10_000;

/** @public */
export class WebSocketLspTransport implements Transport {
  private readonly ws: WebSocket;
  private readonly handlers = new Set<(value: string) => void>();
  private closed = false;
  /** Fired exactly once when the socket dies. `unexpected` is true for a
   * server-side death / network error, false for a client-initiated
   * `close()`. The client-manager uses this to drive auto-reconnect. */
  private onCloseCb: ((unexpected: boolean) => void) | null = null;
  private closeFired = false;

  /** Use `connectLspWs(sessionId)` instead — that handles the open-promise. */
  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", this.handleMessage);
    this.ws.addEventListener("close", this.handleClose);
    this.ws.addEventListener("error", this.handleClose);
  }

  /**
   * Register the close callback. Replaces any previous one. Fired at most
   * once per transport — a clean `close()` reports `unexpected=false`, an
   * unsolicited socket death reports `unexpected=true`.
   */
  setOnClose(cb: (unexpected: boolean) => void): void {
    this.onCloseCb = cb;
  }

  send(message: string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("LSP transport is not connected");
    }
    this.ws.send(message);
  }

  subscribe(handler: (value: string) => void): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.handlers.delete(handler);
  }

  /** Explicitly close the transport. Idempotent. Reports a *clean* close to
   * any registered `onClose` callback (`unexpected=false`). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.removeEventListener("message", this.handleMessage);
    this.ws.removeEventListener("close", this.handleClose);
    this.ws.removeEventListener("error", this.handleClose);
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, "client");
    }
    this.fireClose(false);
  }

  private handleMessage = (event: MessageEvent): void => {
    if (typeof event.data !== "string") {
      // The Rust proxy only emits text frames; binary would mean a bug.
      return;
    }
    // `workspace/applyEdit` is applied asynchronously (it writes files), so it
    // can't go through the synchronous request-response path below.
    const request = parseClientRequest(event.data);
    if (request?.method === "workspace/applyEdit") {
      void this.handleApplyEdit(request);
      return;
    }
    const response = buildClientRequestResponse(event.data);
    if (response) {
      this.send(response);
      return;
    }
    for (const handler of this.handlers) {
      handler(event.data);
    }
  };

  /** Apply a server-pushed `WorkspaceEdit` and reply with the outcome. */
  private async handleApplyEdit(request: JsonRpcClientRequest): Promise<void> {
    const params = request.params;
    const edit =
      isRecord(params) && isRecord(params.edit) ? (params.edit as LspWorkspaceEdit) : null;
    const result = edit
      ? await applyServerEdit(edit)
      : { applied: false, failureReason: "Malformed workspace edit." };
    if (this.closed) return;
    const response: JsonRpcResponse = { jsonrpc: "2.0", id: request.id, result };
    this.send(JSON.stringify(response));
  }

  private handleClose = (): void => {
    // Reached via the socket's `close`/`error` events — i.e. NOT through our
    // own `close()`, which removes these listeners first. So this is always
    // an unexpected death (idle timeout, server crash, network drop).
    this.closed = true;
    this.fireClose(true);
  };

  private fireClose(unexpected: boolean): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.onCloseCb?.(unexpected);
  }
}

type JsonRpcId = string | number | null;

interface JsonRpcClientRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

function buildClientRequestResponse(raw: string): string | null {
  const request = parseClientRequest(raw);
  if (!request) return null;
  const result = handledClientRequestResult(request.method, request.params);
  if (result === undefined) return null;
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: request.id,
    result,
  };
  return JSON.stringify(response);
}

function parseClientRequest(raw: string): JsonRpcClientRequest | null {
  if (!raw.includes('"id"') || !raw.includes('"method"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (!("id" in parsed) || !("method" in parsed)) return null;
  if (!isJsonRpcId(parsed.id) || typeof parsed.method !== "string") return null;
  return {
    id: parsed.id,
    method: parsed.method,
    params: parsed.params,
  };
}

function handledClientRequestResult(method: string, params: unknown): unknown | undefined {
  switch (method) {
    case "workspace/configuration":
      return workspaceConfigurationResult(params);
    case "workspace/workspaceFolders":
    case "window/showMessageRequest":
    case "window/workDoneProgress/create":
    case "client/registerCapability":
    case "client/unregisterCapability":
    case "workspace/codeLens/refresh":
    case "workspace/diagnostic/refresh":
    case "workspace/inlayHint/refresh":
    case "workspace/inlineValue/refresh":
    case "workspace/semanticTokens/refresh":
      return null;
    // `workspace/applyEdit` is handled out-of-band in `handleMessage` because
    // applying the edit is asynchronous (it writes files).
    default:
      return undefined;
  }
}

function workspaceConfigurationResult(params: unknown): unknown[] {
  if (!isRecord(params) || !Array.isArray(params.items)) return [];
  return params.items.map(() => ({}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

/**
 * Build the WebSocket URL for a claimed LSP session. Mirrors the backend
 * route `GET /api/lsp/sessions/{session_id}/connect`.
 */
/** @public */
export function getLspWsUrl(sessionId: string): string {
  const base = resolveApiBaseUrlSync().replace(/^http/, "ws");
  return `${base}/api/lsp/sessions/${encodeURIComponent(sessionId)}/connect`;
}

/**
 * Open a WebSocket to the given LSP session and resolve to a connected
 * `Transport`. Rejects on error or timeout — the caller (cmd-click handler)
 * surfaces the failure as a toast.
 */
/** @public */
export async function connectLspWs(sessionId: string): Promise<WebSocketLspTransport> {
  const ws = new WebSocket(getLspWsUrl(sessionId), getWsProtocols());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      ws.close();
      reject(new Error("LSP connect timed out"));
    }, OPEN_TIMEOUT_MS);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("LSP connect failed"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
  return new WebSocketLspTransport(ws);
}
