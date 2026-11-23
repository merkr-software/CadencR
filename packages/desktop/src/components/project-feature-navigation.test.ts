import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Feature } from "@/api/generated";
import {
  adjacentFeatureOutsideIds,
  archiveNavigationTarget,
  archiveFeaturesInCachedLists,
  removeFeatureFromCachedLists,
} from "@/components/project-feature-navigation";

function feature(id: number, status: Feature["status"] = "active"): Feature {
  return {
    id,
    title: `Feature ${id}`,
    status,
    type: "ws-session",
    project_id: 1,
    created_at: "2026-01-01T00:00:00Z",
    is_pinned: false,
  };
}

describe("project feature navigation cache helpers", () => {
  it("removes a deleted only conversation from cached feature lists", () => {
    const queryClient = new QueryClient();
    const key = ["/api/features", { project_id: 1, include_archived: true }] as const;
    queryClient.setQueryData<Feature[]>(key, [feature(1)]);

    removeFeatureFromCachedLists(queryClient, 1);

    expect(queryClient.getQueryData<Feature[]>(key)).toEqual([]);
    queryClient.clear();
  });

  it("forgets a deleted conversation everywhere it is cached", () => {
    const queryClient = new QueryClient();
    const keys = [["/api/features/pinned"], ["/api/features/active"], ["/api/features/recent"]];
    for (const key of keys) queryClient.setQueryData<Feature[]>(key, [feature(1), feature(2)]);
    queryClient.setQueryData<Feature>(["/api/features/1"], feature(1));

    removeFeatureFromCachedLists(queryClient, 1);

    for (const key of keys) {
      expect(queryClient.getQueryData<Feature[]>(key)?.map(({ id }) => id)).toEqual([2]);
    }
    expect(queryClient.getQueryState(["/api/features/1"])).toBeUndefined();
    queryClient.clear();
  });

  it("marks an archived only conversation so home shows the empty project screen", () => {
    const queryClient = new QueryClient();
    const key = ["/api/features", { project_id: 1, include_archived: true }] as const;
    queryClient.setQueryData<Feature[]>(key, [feature(1)]);

    archiveFeaturesInCachedLists(queryClient, [1]);

    expect(queryClient.getQueryData<Feature[]>(key)).toEqual([feature(1, "archived")]);
    queryClient.clear();
  });

  it("archives every confirmed related conversation in cached feature lists", () => {
    const queryClient = new QueryClient();
    const key = ["/api/features", { project_id: 1, include_archived: true }] as const;
    queryClient.setQueryData<Feature[]>(key, [feature(1), feature(2), feature(3)]);

    archiveFeaturesInCachedLists(queryClient, [1, 3]);

    expect(queryClient.getQueryData<Feature[]>(key)).toEqual([
      feature(1, "archived"),
      feature(2),
      feature(3, "archived"),
    ]);
    queryClient.clear();
  });

  it("selects an adjacent conversation outside the archived group", () => {
    const features = [feature(1), feature(2), feature(3), feature(4)];
    expect(adjacentFeatureOutsideIds(features, 2, new Set([1, 2, 3]))?.id).toBe(4);
    expect(adjacentFeatureOutsideIds(features, 3, new Set([2, 3, 4]))?.id).toBe(1);
    expect(adjacentFeatureOutsideIds(features, 2, new Set([1, 2, 3, 4]))).toBeUndefined();
  });

  it("navigates away when the current conversation is archived as a relative", () => {
    const features = [feature(1), feature(2), feature(3), feature(4)];
    expect(archiveNavigationTarget(features, 2, new Set([1, 2, 3]))?.id).toBe(4);
  });

  it("preserves an unrelated current conversation", () => {
    expect(archiveNavigationTarget([feature(1), feature(2)], 2, new Set([1]))).toBeUndefined();
  });

  it("does not touch non-list feature caches", () => {
    const queryClient = new QueryClient();
    const listKey = ["/api/features", { project_id: 1, include_archived: true }] as const;
    const activityKey = ["/api/features/activity", { project_id: 1 }] as const;
    const activity = [{ feature_id: 1, shell_count: 2 }];
    queryClient.setQueryData<Feature[]>(listKey, [feature(1)]);
    queryClient.setQueryData(activityKey, activity);

    removeFeatureFromCachedLists(queryClient, 1);

    expect(queryClient.getQueryData(activityKey)).toBe(activity);
    queryClient.clear();
  });

  it("skips no-op cache writes when the feature is absent or already archived", () => {
    const queryClient = new QueryClient();
    const key = ["/api/features", { project_id: 1, include_archived: true }] as const;
    const archived = [feature(1, "archived")];
    queryClient.setQueryData<Feature[]>(key, archived);

    archiveFeaturesInCachedLists(queryClient, [1]);
    expect(queryClient.getQueryData<Feature[]>(key)).toBe(archived);

    removeFeatureFromCachedLists(queryClient, 2);
    expect(queryClient.getQueryData<Feature[]>(key)).toBe(archived);
    queryClient.clear();
  });
});
