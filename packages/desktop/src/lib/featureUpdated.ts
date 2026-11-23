/**
 * Shared handler for `feature.updated` WebSocket events.
 * Maps changed aspect names to React Query cache invalidations.
 */
import type { QueryClient } from "@tanstack/react-query";
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

/**
 * Invalidate only the conversation list queries (one project's list when
 * `projectId` is known, plus the global Pinned/Recent/Active lists).
 *
 * Avoids `invalidateByUrlPrefix("/api/features")`, which also refetches
 * per-feature detail/settings/working-dir/subagent queries across every
 * workspace kept mounted in `WorkspacePool`, `/api/features/ports`,
 * `/api/features/activity`, and preloaded `/agent-state` snapshots.
 */
export function invalidateFeatureLists(
  client: QueryClient,
  projectId?: number | null,
): Promise<void> {
  return Promise.all([
    client.invalidateQueries({
      queryKey:
        projectId != null && projectId > 0
          ? getListFeaturesQueryKey({ project_id: projectId })
          : getListFeaturesQueryKey(),
    }),
    invalidateByUrlPrefix(client, GLOBAL_FEATURE_LIST_URLS),
  ]).then(() => undefined);
}

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
    void invalidateFeatureLists(queryClient);
  }
}
