import type { UnifiedAgentEntry } from "@/api/generated";
import type { UnifiedAgentsSortOrder } from "@/components/UnifiedAgentsFilterState";
import type { UnifiedAgentsFilterMode } from "@/components/UnifiedAgentsFilters";
import { parseUTCDateTime } from "@/lib/date-utils";
import { compareAttention, type AttentionState } from "@/lib/sidebar-attention";

/**
 * Pure filtering and ordering for the unified agents grid: which agents a
 * filter shows, and in what order. The default order ("attention") puts the
 * agents that need the user first, using the same states as the sidebar's
 * "For me" queue.
 */

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
  /** Each feature's attention state, for the "attention" order. A feature
   *  missing from the map is idle. */
  attentionByFeature?: ReadonlyMap<number, AttentionState>;
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
  const { matching, pinnedExtras } = splitAgentsByFilterVisibility(included, filters);
  if (filters.sortOrder === "attention") {
    const attention = filters.attentionByFeature;
    return [...sortByAttention(matching, attention), ...sortByAttention(pinnedExtras, attention)];
  }
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

function matchesCurrentFilters(
  entry: UnifiedAgentEntry,
  filters: UnifiedAgentMatchFilters,
): boolean {
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
    else if (entry.is_pinned) pinnedExtras.push(entry);
  }
  return { matching, pinnedExtras };
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

/** Most urgent state first (the sidebar's "For me" ladder); within a state, pinned agents, then the most
 *  recently active. */
function sortByAttention(
  entries: UnifiedAgentEntry[],
  attention: ReadonlyMap<number, AttentionState> | undefined,
): UnifiedAgentEntry[] {
  const stateOf = (entry: UnifiedAgentEntry): AttentionState =>
    attention?.get(entry.feature.id) ?? "idle";
  return entries
    .map(toSortableAgentEntry)
    .sort(
      (a, b) =>
        compareAttention(stateOf(a.entry), stateOf(b.entry)) ||
        Number(b.entry.is_pinned) - Number(a.entry.is_pinned) ||
        b.activityTime - a.activityTime ||
        b.entry.session.sessionDbId - a.entry.session.sessionDbId,
    )
    .map((item: SortableAgentEntry): UnifiedAgentEntry => item.entry);
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

function matchesAgentQuery(entry: UnifiedAgentEntry, query: string): boolean {
  return entry.feature.title.toLowerCase().includes(query);
}
