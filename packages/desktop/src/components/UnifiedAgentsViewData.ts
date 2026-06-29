import { useCallback, useMemo } from "react";
import { useGetUnifiedAgents, type UnifiedAgentEntry } from "@/api/generated";
import {
  toUnifiedAgentsQueryParams,
  type UnifiedAgentsSortOrder,
} from "@/components/UnifiedAgentsFilterState";
import type { UnifiedAgentsFilterMode } from "@/components/UnifiedAgentsFilters";
import { parseUTCDateTime } from "@/lib/date-utils";
import { useLiveActiveSessionIds } from "@/stores/session-status-selectors";

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
  const queryText = query.trim().toLowerCase();
  const rawAgents = agentsData?.agents ?? [];
  // Live "non-idle" sessions from the canonical WS store keep the "Recent"
  // filter honest while an agent is mid-run but stale by `last_activity_at`.
  const liveActiveIdsList = useLiveActiveSessionIds();
  const liveActiveSessionIds = useMemo(() => new Set(liveActiveIdsList), [liveActiveIdsList]);
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
      }),
    [
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
      isLoading,
      isFetching: agentsFetching,
      isError,
      errorMessage: error instanceof Error ? error.message : "Failed to load agents",
      refresh,
      pruneExcludedTitles,
    }),
    [agents, agentsFetching, error, isError, isLoading, refresh, pruneExcludedTitles],
  );
}

export interface UnifiedAgentMatchFilters {
  mode: UnifiedAgentsFilterMode;
  freshMinutes: number;
  projectIds: number[];
  /** Feature-title substrings to hide entirely (the `/exclude:` filter).
   *  Case-insensitive; an excluded agent is dropped even if pinned. */
  excludedTitles: string[];
  /** When true (the `/pin:` filter) the candidate set is restricted to pinned
   *  features before any other filter runs. */
  pinnedOnly: boolean;
  queryText: string;
  /** Live `sessionDbId`s with non-idle status — fed by the WS store.
   *  Optional so call sites that don't care about the "Recent" mode (e.g.
   *  the sidebar link's matching-count) can omit it. */
  liveActiveSessionIds?: ReadonlySet<number>;
}

export interface UnifiedAgentFilterArgs extends UnifiedAgentMatchFilters {
  sortOrder: UnifiedAgentsSortOrder;
}

export function orderUnifiedAgentsForDisplay(
  entries: UnifiedAgentEntry[],
  filters: UnifiedAgentFilterArgs,
): UnifiedAgentEntry[] {
  // Excluded agents are hidden entirely — pre-filter before the pin/sort
  // logic so the `/exclude:` filter wins over the pinned-extras fallback.
  // `/pin:` then narrows the candidate set to pinned features only.
  const included = scopeToPinned(
    dropExcludedAgents(entries, filters.excludedTitles),
    filters.pinnedOnly,
  );
  if (hasNoActiveFilter(filters)) {
    return pinFirst(included.filter(isVisibleAgent), filters.sortOrder);
  }
  const { matching, pinnedExtras } = splitAgentsByFilterVisibility(included, filters);
  const orderedMatches =
    filters.queryText.length === 0
      ? pinFirst(matching, filters.sortOrder)
      : sortAgentsForDisplay(matching, filters.sortOrder);
  return [...orderedMatches, ...sortAgentsForDisplay(pinnedExtras, filters.sortOrder)];
}

export function getUnifiedAgentsMatchingFilters(
  entries: UnifiedAgentEntry[],
  filters: UnifiedAgentMatchFilters,
): UnifiedAgentEntry[] {
  const included = scopeToPinned(
    dropExcludedAgents(entries, filters.excludedTitles),
    filters.pinnedOnly,
  );
  const { matching, pinnedExtras } = splitAgentsByFilterVisibility(included, filters);
  return [...matching, ...pinnedExtras];
}

/** Recompute the `/exclude:` titles, keeping only those that still hide an
 *  agent which would otherwise be visible under the current filters. A title
 *  whose matches have aged out of the `/last` window is dropped so the filter
 *  shrinks over time. */
export function pruneRedundantExcludedTitles(
  entries: UnifiedAgentEntry[],
  filters: UnifiedAgentMatchFilters,
): string[] {
  if (filters.excludedTitles.length === 0) return filters.excludedTitles;
  const visibleTitles = getUnifiedAgentsMatchingFilters(entries, {
    ...filters,
    excludedTitles: [],
  }).map((entry: UnifiedAgentEntry): string => entry.feature.title.toLowerCase());
  const survivors = filters.excludedTitles.filter((title: string): boolean => {
    const needle = title.toLowerCase();
    return visibleTitles.some((visible: string): boolean => visible.includes(needle));
  });
  return survivors.length === filters.excludedTitles.length ? filters.excludedTitles : survivors;
}

function scopeToPinned(entries: UnifiedAgentEntry[], pinnedOnly: boolean): UnifiedAgentEntry[] {
  if (!pinnedOnly) return entries;
  return entries.filter((entry: UnifiedAgentEntry): boolean => entry.is_pinned);
}

function dropExcludedAgents(
  entries: UnifiedAgentEntry[],
  excludedTitles: string[],
): UnifiedAgentEntry[] {
  if (excludedTitles.length === 0) return entries;
  const needles = excludedTitles.map((title: string): string => title.toLowerCase());
  return entries.filter((entry: UnifiedAgentEntry): boolean => !isExcluded(entry, needles));
}

function isExcluded(entry: UnifiedAgentEntry, lowercaseNeedles: string[]): boolean {
  const title = entry.feature.title.toLowerCase();
  return lowercaseNeedles.some((needle: string): boolean => title.includes(needle));
}

function hasNoActiveFilter(filters: UnifiedAgentMatchFilters): boolean {
  return (
    filters.mode === "all" && filters.projectIds.length === 0 && filters.queryText.length === 0
  );
}

function matchesCurrentFilters(
  entry: UnifiedAgentEntry,
  filters: UnifiedAgentMatchFilters,
): boolean {
  if (!isVisibleAgent(entry)) return false;
  if (filters.projectIds.length > 0 && !filters.projectIds.includes(entry.project.id)) return false;
  if (filters.queryText && !matchesAgentQuery(entry, filters.queryText)) return false;
  if (filters.mode === "recent") {
    return isFreshOrActive(entry, filters.freshMinutes, filters.liveActiveSessionIds);
  }
  return true;
}

function splitAgentsByFilterVisibility(
  entries: UnifiedAgentEntry[],
  filters: UnifiedAgentMatchFilters,
): { matching: UnifiedAgentEntry[]; pinnedExtras: UnifiedAgentEntry[] } {
  const matching: UnifiedAgentEntry[] = [];
  const pinnedExtras: UnifiedAgentEntry[] = [];
  for (const entry of entries) {
    if (matchesCurrentFilters(entry, filters)) matching.push(entry);
    else if (entry.is_pinned && isVisibleAgent(entry)) pinnedExtras.push(entry);
  }
  return { matching, pinnedExtras };
}

function isVisibleAgent(_entry: UnifiedAgentEntry): boolean {
  return true;
}

function isFreshOrActive(
  entry: UnifiedAgentEntry,
  freshMinutes: number,
  liveActiveSessionIds: ReadonlySet<number> | undefined,
): boolean {
  // Primary signal: live WS store. Bootstrap fallback: REST flags
  // (`status === "running"`, pending question/permission). REST can lag
  // a few hundred ms behind the truth, but during the cold-start window
  // before `session_status.snapshot` arrives it's the only thing
  // keeping a long-running but stale-by-timestamp agent visible — and
  // the live store overwrites once the snapshot lands.
  if (liveActiveSessionIds?.has(entry.session.sessionDbId)) return true;
  if (entry.session.status === "running") return true;
  if (entry.session.pendingQuestions || entry.session.pendingPermission) return true;
  const activityTime = entry.last_activity_at
    ? parseUTCDateTime(entry.last_activity_at).getTime()
    : NaN;
  if (!Number.isFinite(activityTime)) return false;
  return Date.now() - activityTime <= Math.max(1, freshMinutes) * 60_000;
}

function pinFirst(
  entries: UnifiedAgentEntry[],
  sortOrder: UnifiedAgentsSortOrder,
): UnifiedAgentEntry[] {
  const pinned: UnifiedAgentEntry[] = [];
  const unpinned: UnifiedAgentEntry[] = [];
  for (const entry of sortAgentsForDisplay(entries, sortOrder)) {
    if (entry.is_pinned) pinned.push(entry);
    else unpinned.push(entry);
  }
  return [...pinned, ...unpinned];
}

interface SortableAgentEntry {
  entry: UnifiedAgentEntry;
  createdTime: number;
  activityTime: number;
}

function sortAgentsForDisplay(
  entries: UnifiedAgentEntry[],
  sortOrder: UnifiedAgentsSortOrder,
): UnifiedAgentEntry[] {
  return entries
    .map(toSortableAgentEntry)
    .sort((a, b) => compareSortableAgents(a, b, sortOrder))
    .map((item: SortableAgentEntry): UnifiedAgentEntry => item.entry);
}

function toSortableAgentEntry(entry: UnifiedAgentEntry): SortableAgentEntry {
  const createdTime = agentCreatedTime(entry);
  return {
    entry,
    createdTime,
    activityTime: agentActivityTime(entry, createdTime),
  };
}

function compareSortableAgents(
  a: SortableAgentEntry,
  b: SortableAgentEntry,
  sortOrder: UnifiedAgentsSortOrder,
): number {
  const direction = sortOrder.endsWith("_asc") ? 1 : -1;
  const timeDiff = sortTime(a, sortOrder) - sortTime(b, sortOrder);
  if (timeDiff !== 0) return timeDiff * direction;
  return (a.entry.session.sessionDbId - b.entry.session.sessionDbId) * direction;
}

function sortTime(entry: SortableAgentEntry, sortOrder: UnifiedAgentsSortOrder): number {
  return sortOrder === "activity_asc" || sortOrder === "activity_desc"
    ? entry.activityTime
    : entry.createdTime;
}

function agentActivityTime(entry: UnifiedAgentEntry, fallbackTime: number): number {
  if (!entry.last_activity_at) return fallbackTime;
  const time = parseUTCDateTime(entry.last_activity_at).getTime();
  return Number.isFinite(time) ? time : fallbackTime;
}

function agentCreatedTime(entry: UnifiedAgentEntry): number {
  const time = parseUTCDateTime(entry.agent_created_at).getTime();
  return Number.isFinite(time) ? time : 0;
}

// `countRunningAgents` (REST-based) has been removed in favour of
// `useLiveWorkingCount(sessionIds)` exported from `session-status-store`.
// Consumers should pass the list of `sessionDbId`s they want counted.

function matchesAgentQuery(entry: UnifiedAgentEntry, query: string): boolean {
  return entry.feature.title.toLowerCase().includes(query);
}
