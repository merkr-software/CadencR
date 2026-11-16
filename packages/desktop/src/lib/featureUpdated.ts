/**
 * Shared handler for `feature.updated` WebSocket events.
 * Maps changed aspect names to React Query cache invalidations.
 */
import { invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";
import {
  getGetFeatureQueryKey,
  getGetFeatureSettingsQueryKey,
  getListFeaturesQueryKey,
} from "@/api/generated";

/** Valid values for the `changed` array in a `feature.updated` payload. */
type FeatureChangedField = "title" | "label" | "settings";

/**
 * The cross-project conversation lists (Pinned, Recent, the lenses and views),
 * siblings of `/api/features` that its array-prefix key can't reach.
 */
export const GLOBAL_FEATURE_LIST_URLS = [
  "/api/features/pinned",
  "/api/features/recent",
  "/api/features/active",
];

const FIELD_TO_QUERY_KEY: Record<FeatureChangedField, (id: number) => readonly unknown[]> = {
  title: getGetFeatureQueryKey,
  label: getGetFeatureQueryKey,
  settings: getGetFeatureSettingsQueryKey,
};

/**
 * Invalidate React Query caches for the given feature based on which aspects changed.
 * Deduplicates query keys so each is invalidated at most once.
 */
export function invalidateFeatureQueries(featureId: number, changed: string[]): void {
  const seen = new Set<string>();
  for (const field of changed) {
    const getKey = FIELD_TO_QUERY_KEY[field as FeatureChangedField];
    if (!getKey) continue;
    const queryKey = getKey(featureId);
    const keyStr = JSON.stringify(queryKey);
    if (seen.has(keyStr)) continue;
    seen.add(keyStr);
    queryClient.invalidateQueries({ queryKey });
  }
  // When fields that are rendered in the sidebar/project list change, also
  // invalidate the list cache so those views pick up the new value.
  const LIST_RELEVANT: FeatureChangedField[] = ["title", "label"];
  if (changed.some((f) => LIST_RELEVANT.includes(f as FeatureChangedField))) {
    // `getListFeaturesQueryKey()` (no args) returns `["/api/features"]` — a
    // 1-element prefix that matches every per-project list query under React
    // Query's default prefix matching.
    void queryClient.invalidateQueries({ queryKey: getListFeaturesQueryKey(), exact: false });
    // Sibling URLs the prefix above can't reach; they all show titles and labels.
    void invalidateByUrlPrefix(queryClient, GLOBAL_FEATURE_LIST_URLS);
  }
}
