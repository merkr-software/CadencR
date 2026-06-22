/**
 * Acquire and track a SET of LSP clients for one editor (Phase 4: a file may
 * run a type checker plus one or more linters). Splits the multi-client
 * acquire/release/status bookkeeping out of `useLsp` so that file stays under
 * the size cap and focuses on building the CodeMirror extension.
 *
 * The first id in `lspIds` is the type checker; its client drives navigation
 * (go-to-definition / hover / completion), so it must be mounted first.
 *
 * Roots are resolved per-id because each server roots at its own markers.
 */
import { useEffect, useMemo, useState } from "react";
import type { LSPClient } from "@codemirror/lsp-client";
import { toast } from "sonner";
import {
  acquireLspClient,
  releaseLspClient,
  getLspClient,
  getLspStatus,
  subscribeLspStatus,
  retryLspClient,
} from "./client-manager";
import { resolveLspRoot } from "./resolve-root";
import type { CadencrWorkspace } from "./cadencr-workspace";
import type { LspStatus } from "./lsp-status";

/** One ready client plus the metadata the editor needs to mount its plugin. */
export interface ReadyLspClient {
  lspId: string;
  root: string;
  client: LSPClient;
  workspace: CadencrWorkspace;
}

interface UseLspClientsArgs {
  workspaceRoot: string | undefined;
  absPath: string | null;
  languageId: string | null;
  /** Concrete server ids to run, type checker first. */
  lspIds: string[];
}

interface UseLspClientsResult {
  /** Ready clients in `lspIds` order (type checker first). */
  clients: ReadyLspClient[];
  status: LspStatus;
  errorMessage: string | null;
  onRetry: () => void;
}

interface Acquired {
  lspId: string;
  root: string;
}

/**
 * Resolve each id's root, acquire a client per id, and keep the set in sync
 * with `lspIds`. Returns the ready clients plus an aggregate status (error if
 * the type checker errors; reconnecting/starting/ready otherwise).
 *
 * @public
 */
export function useLspClients({
  workspaceRoot,
  absPath,
  languageId,
  lspIds,
}: UseLspClientsArgs): UseLspClientsResult {
  const [ready, setReady] = useState<ReadyLspClient[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Bumped on every manager status transition so we re-read live clients
  // (identity changes after a reconnect) and re-derive status.
  const [, setStatusTick] = useState(0);
  // Stable join key so the acquire effect only re-runs when the id set changes.
  const idsKey = lspIds.join(",");

  useEffect(() => {
    setErrorMessage(null);
    if (!workspaceRoot || !absPath || !languageId || lspIds.length === 0) {
      setReady([]);
      return;
    }
    let cancelled = false;
    const acquired: Acquired[] = [];

    const acquireOne = async (lspId: string): Promise<ReadyLspClient | null> => {
      // Each server roots at its own markers; ask the backend with its id.
      const root = await resolveLspRoot(workspaceRoot, languageId, absPath, lspId);
      const entry = await acquireLspClient(root, lspId, languageId);
      if (cancelled) {
        releaseLspClient(root, lspId);
        return null;
      }
      acquired.push({ lspId, root });
      return { lspId, root, client: entry.client, workspace: entry.workspace };
    };

    // The type checker is the first id; its failure is the only one that makes
    // the whole editor's LSP "error". A linter (any trailing id) that won't
    // start — e.g. enabled in settings but not installed — must NOT mask a
    // working type checker: it gets a one-shot toast, but go-to-def / hover /
    // diagnostics from the type checker stay live.
    const typeCheckerId = lspIds[0];
    void Promise.all(
      lspIds.map((id) => acquireOne(id).catch((err: unknown) => ({ id, err }))),
    ).then((results) => {
      if (cancelled) return;
      const live: ReadyLspClient[] = [];
      for (const r of results) {
        if (r && "client" in r) live.push(r);
        else if (r && "err" in r) {
          const msg = r.err instanceof Error ? r.err.message : "Failed to start language server";
          toast.error(msg);
          if (r.id === typeCheckerId) setErrorMessage(msg);
        }
      }
      setReady(live);
    });

    return () => {
      cancelled = true;
      for (const a of acquired) releaseLspClient(a.root, a.lspId);
      setReady([]);
    };
  }, [workspaceRoot, absPath, languageId, idsKey, lspIds]);

  // Subscribe to each acquired client's status so reconnects re-bind it and
  // surface reconnecting/error in the status bar.
  useEffect(() => {
    if (ready.length === 0) return;
    const unsubs = ready.map((c) =>
      subscribeLspStatus(c.root, c.lspId, () => {
        const live = getLspClient(c.root, c.lspId);
        if (live) {
          setReady((prev) =>
            prev.map((p) =>
              p.lspId === c.lspId && p.root === c.root
                ? { ...p, client: live.client, workspace: live.workspace }
                : p,
            ),
          );
        }
        setStatusTick((t) => t + 1);
      }),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [ready]);

  const status = useMemo<LspStatus>(() => {
    if (!languageId || lspIds.length === 0) return "unsupported";
    if (errorMessage) return "error";
    // The type checker (first id) drives the aggregate state.
    const typeChecker = ready[0];
    if (!typeChecker) return "starting";
    const snap = getLspStatus(typeChecker.root, typeChecker.lspId);
    if (snap?.status === "error") return "error";
    if (snap?.status === "reconnecting") return "reconnecting";
    if (snap?.status === "ready") return "ready";
    return "starting";
  }, [languageId, lspIds.length, errorMessage, ready]);

  const aggregateError = useMemo<string | null>(() => {
    if (errorMessage) return errorMessage;
    const typeChecker = ready[0];
    if (!typeChecker) return null;
    return getLspStatus(typeChecker.root, typeChecker.lspId)?.errorMessage ?? null;
  }, [errorMessage, ready]);

  const onRetry = useMemo(
    () => () => {
      for (const c of ready) retryLspClient(c.root, c.lspId);
    },
    [ready],
  );

  return { clients: ready, status, errorMessage: aggregateError, onRetry };
}
