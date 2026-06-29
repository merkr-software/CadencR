import type { useNavigate } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { FeatureStatus, getListFeaturesQueryKey, type Feature } from "@/api/generated";

type NavigateFn = ReturnType<typeof useNavigate>;

export function closeFeatureSession(featureId: number): void {
  useWsSessionStore.getState().disconnect(wsSessionIdFromFeature(featureId));
}

export function removeFeatureFromCachedLists(queryClient: QueryClient, featureId: number): void {
  queryClient.setQueriesData<Feature[]>({ queryKey: getListFeaturesQueryKey() }, (old) =>
    removeFeatureFromList(old, featureId),
  );
}

export function archiveFeatureInCachedLists(queryClient: QueryClient, featureId: number): void {
  queryClient.setQueriesData<Feature[]>({ queryKey: getListFeaturesQueryKey() }, (old) =>
    archiveFeatureInList(old, featureId),
  );
}

function removeFeatureFromList(
  old: Feature[] | undefined,
  featureId: number,
): Feature[] | undefined {
  if (!Array.isArray(old) || !old.some((feature) => feature.id === featureId)) return old;
  return old.filter((feature) => feature.id !== featureId);
}

function archiveFeatureInList(
  old: Feature[] | undefined,
  featureId: number,
): Feature[] | undefined {
  if (!Array.isArray(old)) return old;
  let changed = false;
  const next = old.map((feature) => {
    if (feature.id !== featureId || feature.status === FeatureStatus.archived) return feature;
    changed = true;
    return { ...feature, status: FeatureStatus.archived };
  });
  return changed ? next : old;
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

export function navigateToFeatureIdOrHome(
  navigate: NavigateFn,
  projectId: number,
  featureId: number | null | undefined,
): void {
  if (featureId == null) {
    void navigate({ to: "/" });
    return;
  }
  void navigate({
    to: "/projects/$projectId/features/$featureId",
    params: { projectId: String(projectId), featureId: String(featureId) },
  });
}
