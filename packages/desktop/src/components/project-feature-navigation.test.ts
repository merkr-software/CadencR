import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Feature } from "@/api/generated";
import {
  archiveFeatureInCachedLists,
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

  it("marks an archived only conversation so home shows the empty project screen", () => {
    const queryClient = new QueryClient();
    const key = ["/api/features", { project_id: 1, include_archived: true }] as const;
    queryClient.setQueryData<Feature[]>(key, [feature(1)]);

    archiveFeatureInCachedLists(queryClient, 1);

    expect(queryClient.getQueryData<Feature[]>(key)).toEqual([feature(1, "archived")]);
    queryClient.clear();
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

    archiveFeatureInCachedLists(queryClient, 1);
    expect(queryClient.getQueryData<Feature[]>(key)).toBe(archived);

    removeFeatureFromCachedLists(queryClient, 2);
    expect(queryClient.getQueryData<Feature[]>(key)).toBe(archived);
    queryClient.clear();
  });
});
