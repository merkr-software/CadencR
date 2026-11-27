import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { desktopBridge, type BrowserDownloadSnapshot } from "@/lib/desktop-bridge";

type DownloadAction = "pause" | "resume" | "cancel" | "reveal" | "clear";

export interface BrowserDownloadsController {
  snapshot: BrowserDownloadSnapshot | null;
  loading: boolean;
  error: string | null;
  pending: string | null;
  dismissError: () => void;
  reload: () => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  reveal: (id: string) => Promise<void>;
  clear: () => Promise<void>;
}

type DownloadError = { kind: "list" | DownloadAction; cause: unknown };

interface DownloadFeed {
  snapshot: BrowserDownloadSnapshot | null;
  loading: boolean;
  error: DownloadError | null;
  renderedScope: number;
  scope: MutableRefObject<number>;
  lifecycleGeneration: MutableRefObject<number>;
  snapshotRevision: MutableRefObject<number>;
  setSnapshot: Dispatch<SetStateAction<BrowserDownloadSnapshot | null>>;
  setError: Dispatch<SetStateAction<DownloadError | null>>;
  lifecycleIsCurrent: (scopeId: number, generation: number) => boolean;
  reload: () => Promise<void>;
}

export function useBrowserDownloads(scopeId: number): BrowserDownloadsController {
  const { t } = useUiTranslation();
  const feed = useBrowserDownloadFeed(scopeId);
  const actions = useBrowserDownloadActions(scopeId, feed);
  const scopeMatches = feed.renderedScope === scopeId;
  const snapshot = feed.snapshot?.scopeId === scopeId ? feed.snapshot : null;
  const dismissError = useCallback((): void => feed.setError(null), [feed.setError]);
  const loading = !scopeMatches || feed.loading || (feed.snapshot !== null && snapshot === null);
  const error = scopeMatches ? errorMessage(feed.error, t) : null;
  return useMemo(
    () => ({
      snapshot,
      loading,
      error,
      pending: scopeMatches ? actions.pending : null,
      dismissError,
      reload: feed.reload,
      ...actions.commands,
    }),
    [
      actions.commands,
      actions.pending,
      dismissError,
      error,
      feed.reload,
      loading,
      scopeMatches,
      snapshot,
    ],
  );
}

function useBrowserDownloadFeed(scopeId: number): DownloadFeed {
  const [snapshot, setSnapshot] = useState<BrowserDownloadSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DownloadError | null>(null);
  const [renderedScope, setRenderedScope] = useState(scopeId);
  const scope = useRef(scopeId);
  const lifecycleGeneration = useRef(0);
  const snapshotRevision = useRef(0);
  scope.current = scopeId;
  const lifecycleIsCurrent = useCallback((targetScope: number, generation: number): boolean => {
    return scope.current === targetScope && lifecycleGeneration.current === generation;
  }, []);
  const reload = useCallback(async (): Promise<void> => {
    const targetScope = scope.current;
    const targetGeneration = lifecycleGeneration.current;
    const targetRevision = ++snapshotRevision.current;
    setLoading(true);
    setError(null);
    try {
      const next = await desktopBridge.listBrowserDownloads(targetScope);
      if (
        lifecycleIsCurrent(targetScope, targetGeneration) &&
        snapshotRevision.current === targetRevision
      ) {
        setSnapshot(next);
      }
    } catch (cause) {
      if (
        lifecycleIsCurrent(targetScope, targetGeneration) &&
        snapshotRevision.current === targetRevision
      ) {
        setError({ kind: "list", cause });
      }
    } finally {
      if (
        lifecycleIsCurrent(targetScope, targetGeneration) &&
        snapshotRevision.current === targetRevision
      ) {
        setLoading(false);
      }
    }
  }, [lifecycleIsCurrent]);
  useEffect(() => {
    const generation = ++lifecycleGeneration.current;
    snapshotRevision.current += 1;
    setRenderedScope(scopeId);
    setSnapshot(null);
    setError(null);
    const off = desktopBridge.onBrowserDownloadsChanged((next) => {
      if (!lifecycleIsCurrent(scopeId, generation) || next.scopeId !== scopeId) return;
      snapshotRevision.current += 1;
      setSnapshot(next);
      setLoading(false);
    });
    void reload();
    return () => {
      lifecycleGeneration.current += 1;
      snapshotRevision.current += 1;
      off();
    };
  }, [lifecycleIsCurrent, reload, scopeId]);
  return useMemo(
    () => ({
      snapshot,
      loading,
      error,
      renderedScope,
      scope,
      lifecycleGeneration,
      snapshotRevision,
      setSnapshot,
      setError,
      lifecycleIsCurrent,
      reload,
    }),
    [error, lifecycleIsCurrent, loading, reload, renderedScope, snapshot],
  );
}

function useBrowserDownloadActions(
  scopeId: number,
  feed: DownloadFeed,
): {
  pending: string | null;
  commands: Pick<BrowserDownloadsController, "pause" | "resume" | "cancel" | "reveal" | "clear">;
} {
  const [pending, setPending] = useState<string | null>(null);
  const operation = useRef(0);
  const operationPending = useRef(false);
  const {
    scope,
    lifecycleGeneration,
    snapshotRevision,
    setSnapshot,
    setError,
    lifecycleIsCurrent,
  } = feed;
  useEffect(() => {
    operation.current += 1;
    operationPending.current = false;
    setPending(null);
    return () => {
      operation.current += 1;
      operationPending.current = false;
    };
  }, [scopeId]);
  const run = useCallback(
    async (
      action: DownloadAction,
      id: string,
      task: (targetScope: number) => Promise<BrowserDownloadSnapshot | void>,
    ): Promise<void> => {
      if (operationPending.current) return;
      operationPending.current = true;
      const token = ++operation.current;
      const targetScope = scope.current;
      const targetGeneration = lifecycleGeneration.current;
      const targetRevision = snapshotRevision.current;
      setPending(`${action}:${id}`);
      setError(null);
      try {
        const next = await task(targetScope);
        if (
          next &&
          lifecycleIsCurrent(targetScope, targetGeneration) &&
          snapshotRevision.current === targetRevision
        ) {
          setSnapshot(next);
        }
      } catch (cause) {
        if (lifecycleIsCurrent(targetScope, targetGeneration) && operation.current === token) {
          setError({ kind: action, cause });
        }
      } finally {
        if (scope.current === targetScope && operation.current === token) {
          operationPending.current = false;
          setPending(null);
        }
      }
    },
    [lifecycleGeneration, lifecycleIsCurrent, scope, setError, setSnapshot, snapshotRevision],
  );
  const commands = useMemo(
    () => ({
      pause: (id: string) =>
        run("pause", id, (scope) => desktopBridge.pauseBrowserDownload(scope, id)),
      resume: (id: string) =>
        run("resume", id, (scope) => desktopBridge.resumeBrowserDownload(scope, id)),
      cancel: (id: string) =>
        run("cancel", id, (scope) => desktopBridge.cancelBrowserDownload(scope, id)),
      reveal: (id: string) =>
        run("reveal", id, (scope) => desktopBridge.revealBrowserDownload(scope, id)),
      clear: () => run("clear", "all", (scope) => desktopBridge.clearBrowserDownloads(scope)),
    }),
    [run],
  );
  return useMemo(() => ({ pending, commands }), [commands, pending]);
}

function errorMessage(error: DownloadError | null, t: UiTranslator): string | null {
  if (!error) return null;
  const { cause } = error;
  return cause instanceof Error && cause.message
    ? cause.message
    : t(
        "workspace.tools.useBrowserDownloads.theDownloadActionFailed",
        "The download action failed.",
      );
}
