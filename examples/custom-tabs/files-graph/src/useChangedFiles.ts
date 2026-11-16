import { useCallback, useEffect, useRef, useState } from "react";
import { toCadencrError, type CadencrError } from "@cadencr/tab-sdk";
import { getChangedFiles, type GetChangedFilesParams } from "@cadencr/tab-sdk/api";
import { useStream, useTabContext, useVisibility } from "@cadencr/tab-sdk/react";

import { toFileNode, type FileNode } from "./model";

/** Uncommitted work in the worktree, or everything the branch adds over its base. */
export type Scope = "uncommitted" | "branch";

export type LoadState =
  | { status: "loading" }
  | { status: "error"; error: CadencrError }
  | { status: "ready"; files: FileNode[] };

/** Git can report several status pushes per second during a rebase or a checkout:
 *  a burst is coalesced into one refetch, but never delayed past MAX_WAIT_MS. */
const REFRESH_DEBOUNCE_MS = 300;
const REFRESH_MAX_WAIT_MS = 1_000;

export function changedFilesParams(
  featureId: number,
  scope: Scope,
  baseBranch: string | null,
): GetChangedFilesParams {
  return scope === "branch" && baseBranch
    ? { feature_id: featureId, mode: "branch", target_branch: baseBranch }
    : { feature_id: featureId, mode: "uncommitted" };
}

/** Coalesces calls into one trailing `run()`, at most `maxWait` after the first. */
function useCoalesced(run: () => void) {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstStart = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const schedule = useCallback(() => {
    const now = Date.now();
    if (timer.current === null) burstStart.current = now;
    else clearTimeout(timer.current);
    const wait = Math.min(REFRESH_DEBOUNCE_MS, burstStart.current + REFRESH_MAX_WAIT_MS - now);
    timer.current = setTimeout(
      () => {
        timer.current = null;
        runRef.current();
      },
      Math.max(0, wait),
    );
  }, []);
  useEffect(() => cancel, [cancel]);
  return { schedule, cancel };
}

/**
 * The feature's changed files, kept live: every `git.status` push (and every
 * stream resync) schedules a coalesced refetch. While the tab is hidden the
 * subscription is closed; showing the tab refetches once.
 *
 * A refetch that returns the same list keeps the previous `files` array, so
 * everything memoized on it (grouping, treemap layout, the open diff) stays put.
 */
export function useChangedFiles(scope: Scope) {
  const { feature } = useTabContext();
  const visible = useVisibility();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<CadencrError | null>(null);
  const latestRequest = useRef(0);
  // The raw response of the list on screen, to detect unchanged refetches.
  const shown = useRef<string | null>(null);

  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    setRefreshing(true);
    try {
      const files = await getChangedFiles(changedFilesParams(feature.id, scope, feature.baseBranch));
      if (request !== latestRequest.current) return;
      const signature = JSON.stringify(files);
      if (signature !== shown.current) {
        shown.current = signature;
        setState({ status: "ready", files: files.map(toFileNode) });
      }
      setRefreshError(null);
    } catch (error) {
      if (request !== latestRequest.current) return;
      const failure = toCadencrError(error);
      // Keep showing the last good data; the header shows why it is stale.
      setState((current) => (current.status === "ready" ? current : { status: "error", error: failure }));
      setRefreshError(failure);
    } finally {
      if (request === latestRequest.current) setRefreshing(false);
    }
  }, [feature.id, feature.baseBranch, scope]);

  const { schedule, cancel } = useCoalesced(() => void load());

  // A new scope or base branch: drop the old list and any refetch queued for it.
  useEffect(() => {
    cancel();
    shown.current = null;
    setState({ status: "loading" });
    void load();
  }, [load, cancel]);

  // Coming back into view: the list may have changed while nobody listened.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) schedule();
    wasVisible.current = visible;
  }, [visible, schedule]);

  // The payload is the new git status snapshot; the file list is not in it,
  // so any push simply means "refetch".
  useStream("git.status", schedule, {
    enabled: visible,
    onResync: schedule,
    onError: setRefreshError,
  });

  return { state, refreshing, refreshError, reload: load };
}
