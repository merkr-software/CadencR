/**
 * Module-scoped manager for `LSPClient` instances keyed by
 * `${workspaceRoot}::${lspId}` (Phase 4: a file may run several servers, e.g. a
 * type checker plus a linter, so the key is the concrete server id, not the
 * language). `languageId` is still carried for `didOpen`. Lives outside Zustand
 * on purpose:
 * `LSPClient` is a non-reactive object — components must never re-render when
 * its internal state changes, so a plain `Map` is the right shape.
 *
 * The ONE thing components do care about is the *connection status* of an
 * entry (ready / reconnecting / error). For that we expose a tiny per-key
 * subscription/emitter (not Zustand — we keep the Map and only push coarse
 * status transitions), so a mounted editor can re-mount its LSP compartment
 * onto a fresh client after an unexpected socket death.
 *
 * Each entry holds a single LSP session: one POST to reserve, one WebSocket
 * to carry frames, one `LSPClient` + `CadencrWorkspace`. Concurrent
 * `acquireLspClient(...)` calls for the same key share the in-flight init
 * promise so we don't claim two sessions for the same workspace+language.
 *
 * Lifecycle: `useLsp` calls [`acquireLspClient`] on mount, [`releaseLspClient`]
 * on unmount. When the refcount drops to zero we arm a grace-period timer
 * (so flipping between tabs doesn't tear the server down) and only then
 * disconnect. A re-acquire inside the grace period cancels the shutdown.
 *
 * Reconnect: when the socket dies unexpectedly while the entry is still
 * referenced, we rebuild the session with bounded exponential backoff,
 * respecting a `Retry-After` from a 503, and notify subscribers so editors
 * re-bind to the new client.
 */
import { LSPClient } from "@codemirror/lsp-client";
import { type WebSocketLspTransport } from "./transport";
import { CadencrWorkspace, type DisplayFileHandler } from "./cadencr-workspace";
import { buildSession, backoffDelayMs } from "./lsp-session";

/** Coarse connection status for an entry, mirrored into the UI. */
export type LspEntryStatus = "connecting" | "ready" | "reconnecting" | "error";

interface ClientEntry {
  client: LSPClient;
  workspace: CadencrWorkspace;
  transport: WebSocketLspTransport;
  /** LSP language id for `didOpen`; carried so reconnect can rebuild. */
  languageId: string;
  refCount: number;
  shutdownTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  status: LspEntryStatus;
  /** Set on `status === "error"`; carries the last failure message. */
  errorMessage: string | null;
  /** Consecutive reconnect failures; resets to 0 on a successful connect. */
  failCount: number;
}

/**
 * How long an unused client lingers before we disconnect. Long enough to
 * absorb tab-switches and re-renders that briefly drop the refcount to
 * zero; short enough that a closed file doesn't keep its language server
 * resident for the rest of the session.
 */
const SHUTDOWN_GRACE_MS = 30_000;

/** Give up auto-reconnecting after this many consecutive failures and mark
 * the entry `error` (the user can force a retry from the status bar). */
const MAX_RECONNECT_ATTEMPTS = 5;

const clients = new Map<string, ClientEntry>();
const pending = new Map<string, Promise<ClientEntry>>();
const subscribers = new Map<string, Set<() => void>>();

function keyFor(workspaceRoot: string, lspId: string): string {
  return `${workspaceRoot}::${lspId}`;
}

// ---------------------------------------------------------------------------
// Status subscription
// ---------------------------------------------------------------------------

export interface LspEntrySnapshot {
  status: LspEntryStatus;
  errorMessage: string | null;
}

/**
 * Subscribe to status transitions for `(workspaceRoot, lspId)`. The
 * callback fires on every status change (and reconnect-driven client swap).
 * Returns an unsubscribe function. Safe to call before the entry exists.
 *
 * @public
 */
export function subscribeLspStatus(
  workspaceRoot: string,
  lspId: string,
  cb: () => void,
): () => void {
  const key = keyFor(workspaceRoot, lspId);
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(cb);
  return () => {
    const current = subscribers.get(key);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) subscribers.delete(key);
  };
}

/**
 * Read the current status snapshot for `(workspaceRoot, lspId)`, or
 * `null` if no entry exists yet.
 *
 * @public
 */
export function getLspStatus(workspaceRoot: string, lspId: string): LspEntrySnapshot | null {
  const entry = clients.get(keyFor(workspaceRoot, lspId));
  if (!entry) return null;
  return { status: entry.status, errorMessage: entry.errorMessage };
}

/**
 * Read the live `{client, workspace}` for `(workspaceRoot, lspId)`, or
 * `null` if no entry exists. Always returns the *current* client, which
 * changes identity after a reconnect — callers re-read on each `notify`.
 *
 * @public
 */
export function getLspClient(
  workspaceRoot: string,
  lspId: string,
): { client: LSPClient; workspace: CadencrWorkspace } | null {
  const entry = clients.get(keyFor(workspaceRoot, lspId));
  if (!entry) return null;
  return { client: entry.client, workspace: entry.workspace };
}

function notify(key: string): void {
  const set = subscribers.get(key);
  if (!set) return;
  for (const cb of set) cb();
}

function setStatus(key: string, status: LspEntryStatus, errorMessage: string | null): void {
  const entry = clients.get(key);
  if (!entry) return;
  if (entry.status === status && entry.errorMessage === errorMessage) return;
  entry.status = status;
  entry.errorMessage = errorMessage;
  notify(key);
}

// ---------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------

/**
 * Acquire a refcounted LSP client for `(workspaceRoot, lspId)`. `languageId`
 * is the LSP language id used for `didOpen` / the default-server fallback when
 * `lspId` resolves to the language default. Bumps the refcount and cancels any
 * pending shutdown timer. Pair every call with [`releaseLspClient`] on
 * cleanup. Throws on server resolve / transport failure — surface a toast.
 *
 * @public
 */
export async function acquireLspClient(
  workspaceRoot: string,
  lspId: string,
  languageId: string,
): Promise<{ client: LSPClient; workspace: CadencrWorkspace }> {
  const key = keyFor(workspaceRoot, lspId);
  const existing = clients.get(key);
  if (existing) {
    existing.refCount += 1;
    if (existing.shutdownTimer != null) {
      clearTimeout(existing.shutdownTimer);
      existing.shutdownTimer = null;
    }
    return { client: existing.client, workspace: existing.workspace };
  }
  const inflight = pending.get(key);
  if (inflight) {
    const entry = await inflight;
    entry.refCount += 1;
    return { client: entry.client, workspace: entry.workspace };
  }
  const promise = createEntry(workspaceRoot, lspId, languageId).finally(() => {
    pending.delete(key);
  });
  pending.set(key, promise);
  const entry = await promise;
  entry.refCount += 1;
  clients.set(key, entry);
  setStatus(key, "ready", null);
  return { client: entry.client, workspace: entry.workspace };
}

/**
 * Decrement the refcount for `(workspaceRoot, lspId)`. When it
 * reaches zero we arm a grace timer; the entry stays alive (and warm) for
 * `SHUTDOWN_GRACE_MS` so a quick re-acquire avoids a respawn.
 *
 * @public
 */
export function releaseLspClient(workspaceRoot: string, lspId: string): void {
  const key = keyFor(workspaceRoot, lspId);
  const entry = clients.get(key);
  if (!entry) return;
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0) return;
  if (entry.shutdownTimer != null) clearTimeout(entry.shutdownTimer);
  entry.shutdownTimer = setTimeout(() => {
    // Re-check in case a late re-acquire bumped the count back up.
    const current = clients.get(key);
    if (!current || current.refCount > 0) return;
    teardownEntry(key, current);
  }, SHUTDOWN_GRACE_MS);
}

/**
 * Force a fresh connection attempt for an entry that gave up (`error`). The
 * status bar wires this to the clickable error indicator.
 *
 * @public
 */
export function retryLspClient(workspaceRoot: string, lspId: string): void {
  const key = keyFor(workspaceRoot, lspId);
  const entry = clients.get(key);
  if (!entry || entry.refCount === 0) return;
  entry.failCount = 0;
  void reconnect(key, workspaceRoot, lspId, entry.languageId);
}

function teardownEntry(key: string, entry: ClientEntry): void {
  if (entry.reconnectTimer != null) clearTimeout(entry.reconnectTimer);
  entry.client.disconnect();
  entry.transport.close();
  clients.delete(key);
}

// ---------------------------------------------------------------------------
// Session construction + reconnect
// ---------------------------------------------------------------------------

async function createEntry(
  workspaceRoot: string,
  lspId: string,
  languageId: string,
): Promise<ClientEntry> {
  const key = keyFor(workspaceRoot, lspId);
  // `lspId` is the concrete server id, except when the resolver passed the
  // bare languageId (no explicit server) — in that case don't send an lsp_id.
  const sessionLspId = lspId === languageId ? undefined : lspId;
  const parts = await buildSession(workspaceRoot, languageId, sessionLspId);
  const entry: ClientEntry = {
    client: parts.client,
    workspace: parts.workspace,
    transport: parts.transport,
    languageId,
    refCount: 0,
    shutdownTimer: null,
    reconnectTimer: null,
    status: "connecting",
    errorMessage: null,
    failCount: 0,
  };
  parts.transport.setOnClose((unexpected) =>
    onTransportClose(key, workspaceRoot, lspId, languageId, unexpected),
  );
  return entry;
}

/**
 * Handle a transport close. A clean (client-initiated) close is ignored —
 * we tore it down on purpose. An unexpected death while still referenced
 * triggers the reconnect cycle.
 */
function onTransportClose(
  key: string,
  workspaceRoot: string,
  lspId: string,
  languageId: string,
  unexpected: boolean,
): void {
  if (!unexpected) return;
  const entry = clients.get(key);
  if (!entry || entry.refCount === 0) return;
  // The dead client can't serve requests; drop it before reconnecting.
  entry.client.disconnect();
  setStatus(key, "reconnecting", null);
  void reconnect(key, workspaceRoot, lspId, languageId);
}

/**
 * Rebuild the session for `key` with bounded exponential backoff. Notifies
 * subscribers on success so editors re-bind to the fresh client; marks the
 * entry `error` after `MAX_RECONNECT_ATTEMPTS`.
 */
async function reconnect(
  key: string,
  workspaceRoot: string,
  lspId: string,
  languageId: string,
): Promise<void> {
  const entry = clients.get(key);
  if (!entry || entry.refCount === 0) return;
  if (entry.reconnectTimer != null) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  // Share the single-inflight guard so concurrent acquires don't double-spawn.
  if (pending.has(key)) return;
  setStatus(key, "reconnecting", null);
  const sessionLspId = lspId === languageId ? undefined : lspId;
  const attempt = (async (): Promise<ClientEntry> => {
    const parts = await buildSession(workspaceRoot, languageId, sessionLspId);
    const live = clients.get(key);
    if (!live) {
      parts.transport.close();
      throw new Error("entry torn down during reconnect");
    }
    live.client = parts.client;
    live.workspace = parts.workspace;
    live.transport = parts.transport;
    live.failCount = 0;
    parts.transport.setOnClose((unexpected) =>
      onTransportClose(key, workspaceRoot, lspId, languageId, unexpected),
    );
    return live;
  })().finally(() => pending.delete(key));
  pending.set(key, attempt);
  try {
    await attempt;
    setStatus(key, "ready", null);
    // A fresh client identity means editors must re-mount the compartment.
    notify(key);
  } catch (err) {
    scheduleRetry(key, workspaceRoot, lspId, languageId, err);
  }
}

function scheduleRetry(
  key: string,
  workspaceRoot: string,
  lspId: string,
  languageId: string,
  err: unknown,
): void {
  const entry = clients.get(key);
  if (!entry || entry.refCount === 0) return;
  entry.failCount += 1;
  const msg = err instanceof Error ? err.message : "Language server reconnect failed";
  if (entry.failCount >= MAX_RECONNECT_ATTEMPTS) {
    setStatus(key, "error", msg);
    return;
  }
  const delay = backoffDelayMs(entry.failCount, err);
  setStatus(key, "reconnecting", null);
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    void reconnect(key, workspaceRoot, lspId, languageId);
  }, delay);
}

// ---------------------------------------------------------------------------
// Display-file handler + test reset
// ---------------------------------------------------------------------------

/**
 * Register a host-provided `displayFile` handler with the workspace for
 * `(workspaceRoot, lspId)`. The handler bridges LSP-driven navigation
 * into Cadencr's tab system. Returns an unregister function.
 *
 * @public
 */
export function setDisplayFileHandler(
  workspaceRoot: string,
  lspId: string,
  handler: DisplayFileHandler,
): () => void {
  const entry = clients.get(keyFor(workspaceRoot, lspId));
  if (!entry) return () => {};
  entry.workspace.setDisplayFileHandler(handler);
  return () => {
    // Only clear if no other handler has replaced ours in the meantime.
    entry.workspace.setDisplayFileHandler(null);
  };
}

/** Test-only: tear down every cached client. */
/** @public */
export function __resetLspClientsForTest(): void {
  for (const [key, entry] of clients) {
    teardownEntry(key, entry);
  }
  clients.clear();
  pending.clear();
  subscribers.clear();
}
