import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGetFeatureArchivePreviewQueryKey,
  getIsFeatureEmptyQueryKey,
  type Feature,
} from "@/api/generated";
import {
  getFeatureArchiveAction,
  getPendingFeatureArchiveAction,
  resolveFeatureArchiveAction,
} from "./feature-archive-decision";

const customInstance = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", () => ({ customInstance }));

const feature = (status: Feature["status"] = "active"): Feature => ({
  id: 1,
  project_id: 1,
  title: "Conversation",
  type: "ws-session",
  status,
  created_at: "2026-01-01T00:00:00Z",
  is_pinned: false,
});

describe("feature archive decision", () => {
  it("deletes an isolated empty active conversation", () => {
    expect(getFeatureArchiveAction(feature(), true, false)).toBe("delete");
  });

  it("archives an empty conversation when it has any parent or descendant relation", () => {
    expect(getFeatureArchiveAction(feature(), true, true)).toBe("archive");
  });

  it("waits for both checks before deciding an empty active conversation", () => {
    expect(
      getPendingFeatureArchiveAction({
        feature: feature(),
        emptyResponse: { empty: true },
        isCheckingEmpty: false,
        hasEmptyCheckError: false,
        isCheckingRelations: true,
      }),
    ).toBeNull();
  });

  it("falls back to archive when relation lookup fails", () => {
    expect(
      getPendingFeatureArchiveAction({
        feature: feature(),
        emptyResponse: { empty: true },
        isCheckingEmpty: false,
        hasEmptyCheckError: false,
        hasRelationCheckError: true,
      }),
    ).toBe("archive");
  });

  describe("resolveFeatureArchiveAction", () => {
    beforeEach(() => {
      customInstance.mockReset();
    });

    it("populates the archive-preview and empty caches so the dialog reuses them", async () => {
      const preview = { parent_ids: [2], descendant_ids: [], has_relations: true };
      customInstance.mockImplementation(({ url }: { url: string }) => {
        if (url.endsWith("/archive-preview")) return Promise.resolve(preview);
        return Promise.resolve({ empty: false });
      });
      const queryClient = new QueryClient();

      const action = await resolveFeatureArchiveAction(feature(), queryClient);

      expect(action).toBe("archive");
      expect(queryClient.getQueryData(getGetFeatureArchivePreviewQueryKey(1))).toEqual(preview);
      expect(queryClient.getQueryData(getIsFeatureEmptyQueryKey(1))).toEqual({ empty: false });
      queryClient.clear();
    });

    it("returns delete immediately for an archived conversation without querying", async () => {
      const queryClient = new QueryClient();

      const action = await resolveFeatureArchiveAction(feature("archived"), queryClient);

      expect(action).toBe("delete");
      expect(customInstance).not.toHaveBeenCalled();
      queryClient.clear();
    });
  });
});
