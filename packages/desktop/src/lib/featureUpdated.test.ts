import type { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/api/generated", () => ({
  getGetFeatureQueryKey: (id: number) => [`/api/features/${id}`],
  getGetFeatureSettingsQueryKey: (id: number) => [`/api/features/${id}/settings`],
  getListFeaturesQueryKey: (params?: { project_id?: number }) =>
    params ? ["/api/features", params] : ["/api/features"],
}));

const mockInvalidateQueries = vi.fn();
const mockInvalidateByUrlPrefix = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: (...args: unknown[]) => mockInvalidateQueries(...args) },
  invalidateByUrlPrefix: (...args: unknown[]) => mockInvalidateByUrlPrefix(...args),
}));

import {
  GLOBAL_FEATURE_LIST_URLS,
  invalidateFeatureLists,
  invalidateFeatureQueries,
} from "./featureUpdated";

describe("invalidateFeatureQueries", () => {
  beforeEach(() => {
    mockInvalidateQueries.mockClear();
    mockInvalidateByUrlPrefix.mockClear();
  });

  it("refreshes the Pinned and Recent blocks when a title or label changes", () => {
    invalidateFeatureQueries(42, ["label"]);
    expect(mockInvalidateByUrlPrefix).toHaveBeenCalledWith(expect.anything(), [
      "/api/features/pinned",
      "/api/features/recent",
      "/api/features/active",
    ]);
    mockInvalidateByUrlPrefix.mockClear();
    invalidateFeatureQueries(42, ["settings"]);
    expect(mockInvalidateByUrlPrefix).not.toHaveBeenCalled();
  });

  it("invalidates the feature detail and list query when title changes", () => {
    invalidateFeatureQueries(42, ["title"]);
    // title now also invalidates the list so the sidebar picks up the new title
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/features/42"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/features"],
    });
  });

  it("invalidates multiple keys for multiple changed fields", () => {
    invalidateFeatureQueries(1, ["title", "settings"]);
    // title (= feature detail), settings + the list invalidation triggered by title
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(3);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/features/1"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/features/1/settings"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/features"],
    });
  });

  it("ignores unknown changed fields", () => {
    invalidateFeatureQueries(1, ["unknown_field", "also_unknown"]);
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it("handles empty changed array", () => {
    invalidateFeatureQueries(1, []);
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it("deduplicates when 'title' and 'label' both resolve to the feature query key", () => {
    invalidateFeatureQueries(3, ["title", "label"]);
    // 1 unique feature detail key + 1 list invalidation
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/features/3"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/features"],
    });
  });
});

describe("invalidateFeatureLists", () => {
  beforeEach(() => {
    mockInvalidateQueries.mockClear();
    mockInvalidateByUrlPrefix.mockClear();
  });

  it("scopes list invalidation to the project and global list URLs without touching per-feature or ports caches", async () => {
    const client = {
      invalidateQueries: mockInvalidateQueries.mockResolvedValue(undefined),
    } as unknown as QueryClient;

    await invalidateFeatureLists(client, 9);

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/features", { project_id: 9 }],
    });
    expect(mockInvalidateByUrlPrefix).toHaveBeenCalledWith(client, GLOBAL_FEATURE_LIST_URLS);
  });

  it("falls back to all project lists when projectId is absent, null, or 0", async () => {
    const client = {
      invalidateQueries: mockInvalidateQueries.mockResolvedValue(undefined),
    } as unknown as QueryClient;

    for (const invalidProjectId of [undefined, null, 0] as const) {
      mockInvalidateQueries.mockClear();
      mockInvalidateByUrlPrefix.mockClear();
      await invalidateFeatureLists(client, invalidProjectId);
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ["/api/features"],
      });
      expect(mockInvalidateByUrlPrefix).toHaveBeenCalledWith(client, GLOBAL_FEATURE_LIST_URLS);
    }
  });
});
