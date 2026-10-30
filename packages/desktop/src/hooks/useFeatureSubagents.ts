import { useCallback, useEffect } from "react";
import { hashKey } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getListFeatureSubagentsQueryKey,
  useListFeatureSubagents,
  type SubagentRun,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { queryClient } from "@/lib/queryClient";
import { parseSubagentRun, upsertSubagentRun } from "@/lib/subagents/subagent-runs";

/** Features whose registry changed since their list was last refetched. */
const pushedSinceRefetch = new Set<number>();

/** Runs pushed while their feature's list was being fetched, by list query hash. */
const pushedDuringFetch = new Map<string, { featureId: number; runs: Map<string, SubagentRun> }>();
let unsubscribeFetchWatch: (() => void) | null = null;

/** One sub-agent by its carrier tool_use id; re-renders only when it changes. */
export function useSubagentRun(
  featureId: number | null,
  toolUseId: string | undefined,
): SubagentRun | undefined {
  const select = useCallback(
    (runs: SubagentRun[]) => runs.find((run) => run.toolUseId === toolUseId),
    [toolUseId],
  );
  const query = useListFeatureSubagents(featureId ?? 0, {
    query: { enabled: featureId != null && toolUseId != null, select },
  });
  useEffect(() => {
    if (query.error && featureId != null) {
      toast.error(apiErrorMessage(query.error, "Could not load sub-agent status"), {
        id: `feature-subagents-error-${featureId}`,
      });
    }
  }, [featureId, query.error]);
  return query.data;
}

/**
 * Apply a pushed run to the feature's cached list. A fetch already in flight
 * may have read the registry before this change: the run is held and laid
 * over its answer when it lands. Restarting the fetch instead could keep the
 * list from ever loading, as running sub-agents push every second.
 */
export function applySubagentRunPush(featureId: number, payload: unknown): boolean {
  const run = parseSubagentRun(payload);
  if (!run) return false;
  const key = getListFeatureSubagentsQueryKey(featureId);
  pushedSinceRefetch.add(featureId);
  if (queryClient.getQueryData<SubagentRun[]>(key) !== undefined) {
    queryClient.setQueryData<SubagentRun[]>(key, (runs) => upsertSubagentRun(runs ?? [], run));
  }
  if (queryClient.isFetching({ queryKey: key }) > 0) holdUntilFetched(featureId, run);
  return true;
}

function holdUntilFetched(featureId: number, run: SubagentRun): void {
  const hash = hashKey(getListFeatureSubagentsQueryKey(featureId));
  const held = pushedDuringFetch.get(hash) ?? { featureId, runs: new Map() };
  held.runs.set(`${run.sessionId}:${run.toolUseId}`, run);
  pushedDuringFetch.set(hash, held);
  unsubscribeFetchWatch ??= queryClient.getQueryCache().subscribe((event) => {
    const hash = event.query.queryHash;
    if (!pushedDuringFetch.has(hash)) return;
    if (event.type === "removed") {
      dropHeldRuns(hash);
    } else if (event.type === "updated") {
      if (event.action.type === "success" && !event.action.manual) layHeldRunsOver(hash);
      // Failed or cancelled: the next fetch reads the registry after these pushes.
      else if (event.query.state.fetchStatus === "idle") dropHeldRuns(hash);
    }
  });
}

function layHeldRunsOver(queryHash: string): void {
  const held = pushedDuringFetch.get(queryHash);
  if (!held) return;
  dropHeldRuns(queryHash);
  queryClient.setQueryData<SubagentRun[]>(getListFeatureSubagentsQueryKey(held.featureId), (runs) =>
    [...held.runs.values()].reduce((list, run) => upsertSubagentRun(list, run), runs ?? []),
  );
}

function dropHeldRuns(queryHash: string): void {
  pushedDuringFetch.delete(queryHash);
  if (pushedDuringFetch.size > 0) return;
  unsubscribeFetchWatch?.();
  unsubscribeFetchWatch = null;
}

/** Refetch after a gap (reconnect), when pushes may have been missed. */
export function invalidateFeatureSubagents(featureId: number): void {
  pushedSinceRefetch.delete(featureId);
  dropHeldRuns(hashKey(getListFeatureSubagentsQueryKey(featureId)));
  void queryClient.invalidateQueries({ queryKey: getListFeatureSubagentsQueryKey(featureId) });
}

/**
 * A turn's end settles the transcript counts pushes do not carry: refetch,
 * but only when a sub-agent changed since the last refetch.
 */
export function refreshFeatureSubagentsAfterTurn(featureId: number): void {
  if (pushedSinceRefetch.has(featureId)) invalidateFeatureSubagents(featureId);
}
