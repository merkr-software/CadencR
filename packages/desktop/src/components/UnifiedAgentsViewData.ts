import { useCallback, useEffect, useMemo, useRef } from "react";
import { useGetUnifiedAgents, type UnifiedAgentEntry } from "@/api/generated";
import {
  toUnifiedAgentsQueryParams,
  type UnifiedAgentsSortOrder,
} from "@/components/UnifiedAgentsFilterState";
import type { UnifiedAgentsFilterMode } from "@/components/UnifiedAgentsFilters";
import {
  orderUnifiedAgentsForDisplay,
  pruneRedundantExcludedTitles,
} from "@/components/unified-agents-order";
import { useAttentionIndex } from "@/hooks/useAttentionIndex";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { apiErrorMessage } from "@/lib/api-errors";
import type { AttentionEntry } from "@/lib/attention-index";
import type { AttentionState } from "@/lib/sidebar-attention";
import { useLiveActiveSessionIds } from "@/stores/session-status-selectors";
import { useSessionStatusStore } from "@/stores/session-status-store";

/** Coalesces a burst of turn ends and starts into one reload of the grid. */
const ATTENTION_REFETCH_DELAY_MS = 800;

interface UseUnifiedAgentsDataArgs {
  mode: UnifiedAgentsFilterMode;
  freshMinutes: number;
  projectIds: number[];
  excludedTitles: string[];
  pinnedOnly: boolean;
  query: string;
  sortOrder: UnifiedAgentsSortOrder;
}

export interface UnifiedAgentsData {
  agents: UnifiedAgentEntry[];
  /** Each feature's attention state; a feature missing from it is idle. */
  attentionByFeature: ReadonlyMap<number, AttentionState>;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  errorMessage: string;
  refresh: () => void;
  /** Recompute the `/exclude:` titles against the current agents, dropping any
   *  that no longer hide an otherwise-visible agent (e.g. it aged out of the
   *  `/last` window). Returns the same array reference when nothing changed. */
  pruneExcludedTitles: () => string[];
}

export const UNIFIED_AGENTS_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
} as const;

export function useUnifiedAgentsData({
  mode,
  freshMinutes,
  projectIds,
  excludedTitles,
  pinnedOnly,
  query,
  sortOrder,
}: UseUnifiedAgentsDataArgs): UnifiedAgentsData {
  const baseQueryParams = useMemo(
    () => toUnifiedAgentsQueryParams({ mode, freshMinutes }, 100),
    [freshMinutes, mode],
  );
  const {
    data: agentsData,
    isLoading,
    isFetching: agentsFetching,
    isError,
    error,
    refetch: refetchAgents,
  } = useGetUnifiedAgents(baseQueryParams, { query: UNIFIED_AGENTS_QUERY_OPTIONS });
  const rawAgents = useMemo(() => agentsData?.agents ?? [], [agentsData]);
  const attentionByFeature = useLiveAttention(rawAgents, refetchAgents);
  const queryText = query.trim().toLowerCase();
  const liveActiveSessionIds = useRecentModeLiveIds(mode);
  const agents = useMemo(
    () =>
      orderUnifiedAgentsForDisplay(rawAgents, {
        mode,
        freshMinutes,
        projectIds,
        excludedTitles,
        pinnedOnly,
        queryText,
        sortOrder,
        liveActiveSessionIds,
        attentionByFeature,
      }),
    [
      attentionByFeature,
      freshMinutes,
      mode,
      projectIds,
      excludedTitles,
      pinnedOnly,
      queryText,
      rawAgents,
      sortOrder,
      liveActiveSessionIds,
    ],
  );
  const refresh = useCallback((): void => {
    void refetchAgents();
  }, [refetchAgents]);
  const pruneExcludedTitles = useCallback(
    (): string[] =>
      pruneRedundantExcludedTitles(rawAgents, {
        mode,
        freshMinutes,
        projectIds,
        excludedTitles,
        pinnedOnly,
        queryText,
        liveActiveSessionIds,
      }),
    [
      excludedTitles,
      freshMinutes,
      liveActiveSessionIds,
      mode,
      pinnedOnly,
      projectIds,
      queryText,
      rawAgents,
    ],
  );

  return useMemo<UnifiedAgentsData>(
    () => ({
      agents,
      attentionByFeature,
      isLoading,
      isFetching: agentsFetching,
      isError,
      errorMessage: apiErrorMessage(error, "Failed to load agents"),
      refresh,
      pruneExcludedTitles,
    }),
    [
      agents,
      attentionByFeature,
      agentsFetching,
      error,
      isError,
      isLoading,
      refresh,
      pruneExcludedTitles,
    ],
  );
}

// Live "non-idle" sessions from the canonical WS store keep the "Recent"
// filter honest while an agent is mid-run but stale by `last_activity_at`.
// Every other mode ignores them, so it gets one empty set.
const NO_SESSION_IDS: ReadonlySet<number> = new Set();
function useRecentModeLiveIds(mode: UnifiedAgentsFilterMode): ReadonlySet<number> {
  const liveActiveIdsList = useLiveActiveSessionIds();
  return useMemo(
    () => (mode === "recent" ? new Set(liveActiveIdsList) : NO_SESSION_IDS),
    [liveActiveIdsList, mode],
  );
}

interface RefetchAgents {
  (options?: { cancelRefetch?: boolean }): Promise<unknown>;
}

/** Each feature's attention state, reloading the list when an agent's
 *  activity makes it stale. */
function useLiveAttention(
  rawAgents: readonly UnifiedAgentEntry[],
  refetch: RefetchAgents,
): ReadonlyMap<number, AttentionState> {
  const entries = useAttentionIndex();
  useRefetchOnAgentActivity(entries, rawAgents, refetch);
  return useMemo(
    () => new Map(entries.map((entry) => [entry.featureId, entry.state] as const)),
    [entries],
  );
}

export interface LiveFeatures {
  /** Features with an agent working or waiting. */
  live: ReadonlySet<number>;
  /** The live ones the fetched list does not hold yet. */
  unknown: ReadonlySet<number>;
}

export function liveFeatures(
  entries: readonly AttentionEntry[],
  rawAgents: readonly UnifiedAgentEntry[],
): LiveFeatures {
  const known = new Set(rawAgents.map((entry) => entry.feature.id));
  const live = new Set<number>();
  for (const entry of entries) {
    if (entry.state === "working" || entry.state === "waiting") live.add(entry.featureId);
  }
  return { live, unknown: new Set([...live].filter((id) => !known.has(id))) };
}

/** A turn ended (its activity time moved) or an unknown agent started. */
export function agentsWentStale(previous: LiveFeatures, current: LiveFeatures): boolean {
  return (
    [...previous.live].some((id) => !current.live.has(id)) ||
    [...current.unknown].some((id) => !previous.unknown.has(id))
  );
}

/**
 * The grid's list is fetched once and kept (`staleTime: Infinity`): it
 * carries each agent's recent transcript, so reloading it is not cheap, and
 * a card's own transcript already streams over the socket. The list goes
 * stale in two ways only: an agent the grid does not know starts, or a turn
 * ends and moves its `last_activity_at`. Reload on those, never on a read or
 * failure mark, and only once the live statuses are in.
 */
function useRefetchOnAgentActivity(
  entries: readonly AttentionEntry[],
  rawAgents: readonly UnifiedAgentEntry[],
  refetch: RefetchAgents,
): void {
  const hasSnapshot = useSessionStatusStore((state) => state.hasSnapshot);
  const current = useMemo(() => liveFeatures(entries, rawAgents), [entries, rawAgents]);
  const reload = useDebouncedCallback(
    () => void refetch({ cancelRefetch: false }),
    ATTENTION_REFETCH_DELAY_MS,
  );
  const previousRef = useRef<LiveFeatures | null>(null);
  useEffect(() => {
    if (!hasSnapshot) return;
    const previous = previousRef.current;
    previousRef.current = current;
    if (previous && agentsWentStale(previous, current)) reload();
  }, [current, hasSnapshot, reload]);
}
