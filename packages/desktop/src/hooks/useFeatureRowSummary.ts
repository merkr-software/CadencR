import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetFeatureRowSummaryQueryKey, useGetFeatureRowSummary } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import type { AttentionState } from "@/lib/sidebar-attention";
import type { RowSummary } from "@/lib/sidebar-row-summary";
import { useSidebarSample } from "@/lib/sidebar-sample-context";

/** Todos move while the agent works: ask again this often until its turn ends. */
const WORKING_REFRESH_MS = 15_000;

/**
 * The state each conversation's summary was last asked in. Module-wide, not
 * per row: a row scrolled out of the virtual list while a turn ended still
 * refetches when it comes back, and a conversation shown twice (a block and
 * the tree) refetches once.
 */
const seenStates = new Map<number, AttentionState>();

/**
 * The last reply and todo progress a row previews, fetched only while `enabled`
 * (an option shows one of them). Asked again when the agent's turn ends and
 * every 15 s while it works. Rows remounting as the list scrolls reuse the
 * cached answer.
 */
export function useFeatureRowSummary(
  featureId: number,
  state: AttentionState,
  enabled: boolean,
): RowSummary | undefined {
  const sample = useSidebarSample();
  const queryClient = useQueryClient();
  const active = enabled && sample === null;
  const { data, error } = useGetFeatureRowSummary(featureId, {
    query: {
      enabled: active,
      retry: false,
      staleTime: 5 * 60_000,
      refetchInterval: state === "working" ? WORKING_REFRESH_MS : false,
      refetchOnWindowFocus: false,
    },
  });

  useEffect(() => {
    if (!active) return;
    const previous = seenStates.get(featureId);
    seenStates.set(featureId, state);
    if (previous === "working" && state !== "working") {
      void queryClient.invalidateQueries({ queryKey: getGetFeatureRowSummaryQueryKey(featureId) });
    }
  }, [active, featureId, queryClient, state]);

  return useMemo(() => {
    if (sample) return sample.summaries.get(featureId);
    if (!enabled) return undefined;
    if (error) {
      return {
        preview: null,
        todos: null,
        error: apiErrorMessage(error, "Couldn't load the row summary"),
      };
    }
    if (!data) return undefined;
    return { preview: data.preview ?? null, todos: data.todos ?? null, error: null };
  }, [data, enabled, error, featureId, sample]);
}
