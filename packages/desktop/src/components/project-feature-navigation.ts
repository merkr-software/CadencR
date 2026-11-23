import type { useNavigate } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { navigateToConversation } from "@/lib/conversation-route";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import {
  FeatureStatus,
  getGetFeatureQueryKey,
  getListActiveFeaturesQueryKey,
  getListFeaturesQueryKey,
  getListPinnedFeaturesQueryKey,
  getListRecentFeaturesQueryKey,
  type Feature,
} from "@/api/generated";

type NavigateFn = ReturnType<typeof useNavigate>;

export function closeFeatureSession(featureId: number): void {
  useWsSessionStore.getState().disconnect(wsSessionIdFromFeature(featureId));
}

/**
 * A deleted conversation leaves every cached list that holds it (the project
 * lists, pinned, active, recent) and its own feature query, so nothing reads it
 * as existing (`conversationRoute`).
 */
export function removeFeatureFromCachedLists(queryClient: QueryClient, featureId: number): void {
  const listKeys = [
    getListFeaturesQueryKey(),
    getListPinnedFeaturesQueryKey(),
    getListActiveFeaturesQueryKey(),
    getListRecentFeaturesQueryKey(),
  ];
  for (const queryKey of listKeys) {
    queryClient.setQueriesData<Feature[]>({ queryKey }, (old) =>
      removeFeatureFromList(old, featureId),
    );
  }
  queryClient.removeQueries({ queryKey: getGetFeatureQueryKey(featureId), exact: true });
}

export function archiveFeaturesInCachedLists(
  queryClient: QueryClient,
  featureIds: readonly number[],
): void {
  const archivedIds = new Set(featureIds);
  queryClient.setQueriesData<Feature[]>({ queryKey: getListFeaturesQueryKey() }, (old) =>
    archiveFeaturesInList(old, archivedIds),
  );
}

/** The service reported `featureId` archived (`app/archive_cleanup` updates the cached lists). */
export function isArchivedInCachedLists(queryClient: QueryClient, featureId: number): boolean {
  return queryClient
    .getQueriesData<Feature[] | object>({ queryKey: getListFeaturesQueryKey() })
    .some(
      ([, data]) =>
        Array.isArray(data) &&
        data.some(
          (feature: Feature) =>
            feature.id === featureId && feature.status === FeatureStatus.archived,
        ),
    );
}

function removeFeatureFromList(
  old: Feature[] | undefined,
  featureId: number,
): Feature[] | undefined {
  if (!Array.isArray(old) || !old.some((feature) => feature.id === featureId)) return old;
  return old.filter((feature) => feature.id !== featureId);
}

function archiveFeaturesInList(
  old: Feature[] | undefined,
  archivedIds: ReadonlySet<number>,
): Feature[] | undefined {
  if (!Array.isArray(old)) return old;
  let changed = false;
  const next = old.map((feature) => {
    if (!archivedIds.has(feature.id) || feature.status === FeatureStatus.archived) return feature;
    changed = true;
    return { ...feature, status: FeatureStatus.archived };
  });
  return changed ? next : old;
}

export function adjacentFeatureOutsideIds(
  features: readonly Feature[],
  featureId: number,
  excludedIds: ReadonlySet<number>,
): Feature | undefined {
  const index = features.findIndex((feature) => feature.id === featureId);
  if (index < 0) return features.find((feature) => !excludedIds.has(feature.id));
  for (let distance = 1; distance < features.length; distance += 1) {
    const after = features[index + distance];
    if (after && !excludedIds.has(after.id)) return after;
    const before = features[index - distance];
    if (before && !excludedIds.has(before.id)) return before;
  }
  return undefined;
}

export function archiveNavigationTarget(
  features: readonly Feature[],
  activeFeatureId: number | null,
  archivedIds: ReadonlySet<number>,
): Feature | null | undefined {
  if (activeFeatureId == null || !archivedIds.has(activeFeatureId)) return undefined;
  return adjacentFeatureOutsideIds(features, activeFeatureId, archivedIds) ?? null;
}

export function adjacentFeature(
  features: readonly Feature[],
  featureId: number,
): Feature | undefined {
  const index = features.findIndex((feature) => feature.id === featureId);
  return features[index + 1] ?? features[index - 1];
}

export function navigateToFeatureOrHome(
  navigate: NavigateFn,
  projectId: number,
  feature: Feature | undefined,
): void {
  navigateToFeatureIdOrHome(navigate, projectId, feature?.id);
}

/** Open a conversation (`navigateToConversation`), or the home page without one. */
export function navigateToFeatureIdOrHome(
  navigate: NavigateFn,
  projectId: number,
  featureId: number | null | undefined,
): void {
  if (featureId == null) {
    void navigate({ to: "/" });
    return;
  }
  navigateToConversation(navigate, projectId, featureId);
}
