import { useCallback, useEffect, useMemo, useState } from "react";
import type { UnifiedAgentsMode } from "@/api/generated";
import { dedupeTitles } from "@/components/unified-agents-filter-values";
import type { UnifiedAgentsFilterMode } from "@/components/UnifiedAgentsFilters";
import { intArraysEqual, stringArraysEqual } from "@/lib/utils";

const FILTER_EVENT = "cadencr:unified-agents-filters-changed";

const FILTER_KEYS = {
  mode: "unified_agents_mode",
  freshMinutes: "unified_agents_fresh_minutes",
  projectId: "unified_agents_project_id",
  projectIds: "unified_agents_project_ids",
  excludedTitles: "unified_agents_excluded_titles",
  pinnedOnly: "unified_agents_pinned_only",
  query: "unified_agents_query",
  sortOrder: "unified_agents_sort_order",
} as const;

const FRESH_MINUTES_MIN = 1;
const FRESH_MINUTES_MAX = 43_200;
const DEFAULT_FRESH_MINUTES = 5;

export type UnifiedAgentsSortOrder =
  | "created_desc"
  | "created_asc"
  | "activity_desc"
  | "activity_asc";

export interface PersistedUnifiedAgentsFilters {
  mode: UnifiedAgentsFilterMode;
  freshMinutes: number;
  projectIds: number[];
  excludedTitles: string[];
  pinnedOnly: boolean;
  query: string;
  sortOrder: UnifiedAgentsSortOrder;
}

export type UnifiedAgentsFilterUpdate = Partial<PersistedUnifiedAgentsFilters>;

export function readUnifiedAgentsFilters(): PersistedUnifiedAgentsFilters {
  return {
    mode: readMode(),
    freshMinutes: readBoundedInt(
      FILTER_KEYS.freshMinutes,
      DEFAULT_FRESH_MINUTES,
      FRESH_MINUTES_MIN,
      FRESH_MINUTES_MAX,
    ),
    projectIds: readProjectIds(),
    excludedTitles: readExcludedTitles(),
    pinnedOnly: window.localStorage.getItem(FILTER_KEYS.pinnedOnly) === "1",
    query: window.localStorage.getItem(FILTER_KEYS.query) ?? "",
    sortOrder: readSortOrder(),
  };
}

function writeUnifiedAgentsFilters(
  update: UnifiedAgentsFilterUpdate,
): PersistedUnifiedAgentsFilters {
  const currentFilters = readUnifiedAgentsFilters();
  const nextFilters = normalizeFilters({ ...currentFilters, ...update });
  if (areUnifiedAgentsFiltersEqual(currentFilters, nextFilters)) return currentFilters;
  writeFiltersToStorage(nextFilters);
  window.dispatchEvent(new CustomEvent(FILTER_EVENT));
  return nextFilters;
}

export function useUnifiedAgentsFilters(): readonly [
  PersistedUnifiedAgentsFilters,
  (update: UnifiedAgentsFilterUpdate) => void,
] {
  const [filters, setFiltersState] = useState(readUnifiedAgentsFilters);
  useEffect(() => subscribeFilters(() => setFiltersState(readUnifiedAgentsFilters())), []);
  const setFilters = useCallback((update: UnifiedAgentsFilterUpdate): void => {
    writeUnifiedAgentsFilters(update);
  }, []);
  return useMemo(() => [filters, setFilters] as const, [filters, setFilters]);
}

export function toUnifiedAgentsQueryParams(
  filters: Pick<PersistedUnifiedAgentsFilters, "mode" | "freshMinutes">,
  messageLimit: number,
): {
  mode: UnifiedAgentsMode;
  fresh_minutes?: number;
  message_limit: number;
} {
  return {
    mode: filters.mode as UnifiedAgentsMode,
    fresh_minutes: filters.mode === "recent" ? filters.freshMinutes : undefined,
    message_limit: messageLimit,
  };
}

function normalizeFilters(filters: PersistedUnifiedAgentsFilters): PersistedUnifiedAgentsFilters {
  return {
    mode: filters.mode === "all" ? "all" : "recent",
    freshMinutes: clampInt(
      filters.freshMinutes,
      DEFAULT_FRESH_MINUTES,
      FRESH_MINUTES_MIN,
      FRESH_MINUTES_MAX,
    ),
    projectIds: uniquePositiveInts(filters.projectIds),
    excludedTitles: dedupeTitles(filters.excludedTitles),
    pinnedOnly: filters.pinnedOnly === true,
    query: filters.query,
    sortOrder: normalizeSortOrder(filters.sortOrder),
  };
}

function areUnifiedAgentsFiltersEqual(
  a: PersistedUnifiedAgentsFilters,
  b: PersistedUnifiedAgentsFilters,
): boolean {
  return (
    a.mode === b.mode &&
    a.freshMinutes === b.freshMinutes &&
    a.pinnedOnly === b.pinnedOnly &&
    a.query === b.query &&
    a.sortOrder === b.sortOrder &&
    intArraysEqual(a.projectIds, b.projectIds) &&
    stringArraysEqual(a.excludedTitles, b.excludedTitles)
  );
}

function writeFiltersToStorage(filters: PersistedUnifiedAgentsFilters): void {
  window.localStorage.setItem(FILTER_KEYS.mode, filters.mode);
  window.localStorage.setItem(FILTER_KEYS.freshMinutes, String(filters.freshMinutes));
  writeOptionalString(FILTER_KEYS.query, filters.query);
  writeProjectIds(filters.projectIds);
  writeExcludedTitles(filters.excludedTitles);
  writePinnedOnly(filters.pinnedOnly);
  window.localStorage.setItem(FILTER_KEYS.sortOrder, filters.sortOrder);
}

function writeExcludedTitles(excludedTitles: string[]): void {
  if (excludedTitles.length === 0) window.localStorage.removeItem(FILTER_KEYS.excludedTitles);
  else window.localStorage.setItem(FILTER_KEYS.excludedTitles, JSON.stringify(excludedTitles));
}

function writePinnedOnly(pinnedOnly: boolean): void {
  if (pinnedOnly) window.localStorage.setItem(FILTER_KEYS.pinnedOnly, "1");
  else window.localStorage.removeItem(FILTER_KEYS.pinnedOnly);
}

function writeOptionalString(key: string, value: string): void {
  if (value.length === 0) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}

function writeProjectIds(projectIds: number[]): void {
  if (projectIds.length === 0) window.localStorage.removeItem(FILTER_KEYS.projectIds);
  else window.localStorage.setItem(FILTER_KEYS.projectIds, projectIds.join(","));
  window.localStorage.removeItem(FILTER_KEYS.projectId);
}

function subscribeFilters(callback: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key && !Object.values(FILTER_KEYS).includes(event.key as never)) return;
    callback();
  };
  window.addEventListener(FILTER_EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(FILTER_EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}

function readMode(): UnifiedAgentsFilterMode {
  const value = window.localStorage.getItem(FILTER_KEYS.mode);
  return value === "all" ? "all" : "recent";
}

function readSortOrder(): UnifiedAgentsSortOrder {
  return normalizeSortOrder(window.localStorage.getItem(FILTER_KEYS.sortOrder));
}

function normalizeSortOrder(value: string | null): UnifiedAgentsSortOrder {
  if (value === "activity_desc" || value === "activity_asc") return value;
  return value === "created_asc" ? "created_asc" : "created_desc";
}

function readBoundedInt(key: string, fallback: number, min: number, max: number): number {
  return clampInt(Number.parseInt(window.localStorage.getItem(key) ?? "", 10), fallback, min, max);
}

function clampInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function readProjectIds(): number[] {
  const storedIds = window.localStorage.getItem(FILTER_KEYS.projectIds);
  if (storedIds) return parsePositiveIntList(storedIds);
  const legacyProjectId = readNullableInt(FILTER_KEYS.projectId);
  return legacyProjectId === null ? [] : [legacyProjectId];
}

function parsePositiveIntList(value: string): number[] {
  return uniquePositiveInts(
    value.split(",").map((part: string): number => Number.parseInt(part, 10)),
  );
}

function uniquePositiveInts(values: number[]): number[] {
  const ids: number[] = [];
  for (const value of values) {
    if (Number.isFinite(value) && value > 0 && !ids.includes(value)) ids.push(value);
  }
  return ids;
}

function readExcludedTitles(): string[] {
  const stored = window.localStorage.getItem(FILTER_KEYS.excludedTitles);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    const strings = parsed.filter((item: unknown): item is string => typeof item === "string");
    return dedupeTitles(strings);
  } catch {
    return [];
  }
}

function readNullableInt(key: string): number | null {
  const stored = window.localStorage.getItem(key);
  if (!stored) return null;
  const parsed = Number.parseInt(stored, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
