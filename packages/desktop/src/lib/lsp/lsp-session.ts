/**
 * LSP session construction and reconnect-timing helpers, split out of
 * `client-manager.ts` to keep that file focused on the refcounted entry
 * lifecycle. `buildSession` performs the POST → WebSocket → `LSPClient`
 * handshake; the backoff/error helpers are pure and shared by the manager's
 * reconnect cycle.
 */
import { LSPClient } from "@codemirror/lsp-client";
import { openSession } from "@/api/generated";
import { connectLspWs, type WebSocketLspTransport } from "./transport";
import { CadencrWorkspace } from "./cadencr-workspace";
import { pathToFileUri } from "./file-uri";
import { buildLspNotificationHandlers } from "./notifications";
import { cadencrServerDiagnostics, type ClientRef } from "./diagnostics";

interface SessionParts {
  client: LSPClient;
  workspace: CadencrWorkspace;
  transport: WebSocketLspTransport;
}

/**
 * Build the LSP session (POST → WS → LSPClient). Throws on failure.
 *
 * `lspId` selects the concrete server (Phase 4: a project may run e.g. `tsgo`
 * plus `biome`). It also keys this client's diagnostic bucket so several
 * servers' diagnostics merge instead of clobbering each other. When `lspId` is
 * absent the backend uses the language's default server, and the bucket is
 * keyed by `languageId` (single-client behavior, unchanged).
 */
export async function buildSession(
  workspaceRoot: string,
  languageId: string,
  lspId?: string,
): Promise<SessionParts> {
  const session = await openSession({
    workspace_root: workspaceRoot,
    language_id: languageId,
    lsp_id: lspId ?? null,
  }).catch((err: unknown) => {
    throw new Error(extractSessionError(err));
  });
  const transport = await connectLspWs(session.session_id);
  let workspaceRef: CadencrWorkspace | null = null;
  // The autoSync needs the client, but the client doesn't exist yet (the
  // extension is a constructor arg). Fill the ref right after construction.
  const clientRef: ClientRef = { current: null };
  const bucketKey = lspId ?? languageId;
  const client = new LSPClient({
    rootUri: pathToFileUri(workspaceRoot),
    workspace: (c) => {
      workspaceRef = new CadencrWorkspace(c);
      return workspaceRef;
    },
    // Route `window/showMessage` and `window/logMessage` to sonner toasts.
    notificationHandlers: buildLspNotificationHandlers(),
    // Wires `publishDiagnostics` into this client's merged-diagnostics bucket
    // and installs the per-client doc-change autoSync.
    extensions: [cadencrServerDiagnostics(bucketKey, clientRef)],
  });
  clientRef.current = client;
  client.connect(transport);
  if (!workspaceRef) {
    transport.close();
    throw new Error("LSP workspace was not initialised by the client");
  }
  return { client, workspace: workspaceRef, transport };
}

/** Exponential backoff capped at 30s, honoring a server `Retry-After`. */
export function backoffDelayMs(failCount: number, err: unknown): number {
  const retryAfter = retryAfterMs(err);
  if (retryAfter != null) return retryAfter;
  const base = 500 * 2 ** (failCount - 1);
  return Math.min(base, 30_000);
}

function extractSessionError(err: unknown): string {
  // Axios wraps the body inside `err.response.data.error`. Surface the
  // backend's install hint verbatim rather than a bare HTTP status.
  const axiosErr = err as { response?: { data?: { error?: string } } };
  const detail = axiosErr?.response?.data?.error;
  if (detail) return detail;
  return err instanceof Error ? err.message : "Failed to open LSP session";
}

/**
 * Parse a `Retry-After` from a 503 response. Supports the seconds form
 * (`Retry-After: 7`) used by the LSP crash-backoff. Returns null when
 * absent or unparseable.
 */
function retryAfterMs(err: unknown): number | null {
  const axiosErr = err as {
    response?: { status?: number; headers?: Record<string, unknown> };
  };
  const resp = axiosErr?.response;
  if (!resp || resp.status !== 503) return null;
  const raw = resp.headers?.["retry-after"] ?? resp.headers?.["Retry-After"];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(secs * 1000, 60_000);
}
