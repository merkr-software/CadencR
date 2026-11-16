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
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { LSPClient } from "@codemirror/lsp-client";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
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

function useAcquireLspClients({
  workspaceRoot,
  absPath,
  languageId,
  lspIds,
  idsKey,
  retryKey,
  setReady,
  setErrorMessage,
}: UseLspClientsArgs & {
  idsKey: string;
  retryKey: number;
  setReady: Dispatch<SetStateAction<ReadyLspClient[]>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
}): void {
  useEffect(() => {
    setErrorMessage(null);
    if (!workspaceRoot || !absPath || !languageId || lspIds.length === 0) {
      setReady([]);
      return;
    }
    let cancelled = false;
    const acquired: Acquired[] = [];
    const acquireOne = async (lspId: string): Promise<ReadyLspClient | null> => {
      const root = await resolveLspRoot(workspaceRoot, languageId, absPath, lspId);
      const entry = await acquireLspClient(root, lspId, languageId);
      if (cancelled) {
        releaseLspClient(root, lspId);
        return null;
      }
      acquired.push({ lspId, root });
      return { lspId, root, client: entry.client, workspace: entry.workspace };
    };
    const typeCheckerId = lspIds[0];
    void Promise.all(
      lspIds.map((id) => acquireOne(id).catch((error: unknown) => ({ id, error }))),
    ).then((results) => {
      if (cancelled) return;
      const live: ReadyLspClient[] = [];
      for (const result of results) {
        if (result && "client" in result) {
          live.push(result);
        } else if (result && "error" in result) {
          const message = apiErrorMessage(result.error, "Failed to start language server");
          toast.error(message);
          if (result.id === typeCheckerId) setErrorMessage(message);
        }
      }
      setReady(live);
    });
    return () => {
      cancelled = true;
      for (const client of acquired) releaseLspClient(client.root, client.lspId);
      setReady([]);
    };
  }, [absPath, idsKey, languageId, lspIds, retryKey, setErrorMessage, setReady, workspaceRoot]);
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
  const [retryKey, setRetryKey] = useState(0);
  // Bumped on every manager status transition so we re-read live clients
  // (identity changes after a reconnect) and re-derive status.
  const [, setStatusTick] = useState(0);
  // Stable join key so the acquire effect only re-runs when the id set changes.
  const idsKey = lspIds.join(",");

  useAcquireLspClients({
    workspaceRoot,
    absPath,
    languageId,
    lspIds,
    idsKey,
    retryKey,
    setReady,
    setErrorMessage,
  });

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
      // Failed initial handshakes have no manager entry to reconnect yet.
      // Reacquire them too, including when another server is already ready.
      setRetryKey((key) => key + 1);
    },
    [ready],
  );

  return { clients: ready, status, errorMessage: aggregateError, onRetry };
}
