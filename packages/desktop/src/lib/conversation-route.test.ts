// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGetFeatureQueryKey,
  getListFeaturesQueryKey,
  getListPinnedFeaturesQueryKey,
  getListProjectsQueryKey,
  type Feature,
  type Project,
} from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import { conversationRoute, navigateToConversation } from "./conversation-route";

const PROJECT = { id: 3, path: "/repo", name: "repo" } as Project;
const FEATURE = { id: 12, project_id: 3, title: "Fix it" } as Feature;

const DIRECT = {
  to: "/ws-session/$sessionId",
  params: { sessionId: "ws-feature-12" },
  search: { cwd: "/repo", featureId: 12, projectId: 3 },
};
const LEGACY = {
  to: "/projects/$projectId/features/$featureId",
  params: { projectId: "3", featureId: "12" },
};

describe("conversationRoute", () => {
  beforeEach(() => queryClient.clear());
  afterEach(() => queryClient.clear());

  it("goes straight to the workspace when the project and the feature are cached", () => {
    queryClient.setQueryData(getListProjectsQueryKey(), [PROJECT]);
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 3 }), [FEATURE]);

    expect(conversationRoute(3, 12)).toEqual(DIRECT);
  });

  it("finds the feature in any list the sidebar keeps, or in its own query", () => {
    queryClient.setQueryData(getListProjectsQueryKey(), [PROJECT]);

    queryClient.setQueryData(getListPinnedFeaturesQueryKey(), [FEATURE]);
    expect(conversationRoute(3, 12)).toEqual(DIRECT);

    queryClient.removeQueries({ queryKey: getListPinnedFeaturesQueryKey() });
    queryClient.setQueryData(getGetFeatureQueryKey(12), FEATURE);
    expect(conversationRoute(3, 12)).toEqual(DIRECT);
  });

  it("carries the requested tab on either route", () => {
    queryClient.setQueryData(getListProjectsQueryKey(), [PROJECT]);
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 3 }), [FEATURE]);
    expect(conversationRoute(3, 12, { focusTab: "git" }).search).toEqual({
      ...DIRECT.search,
      focusTab: "git",
    });

    queryClient.clear();
    expect(conversationRoute(3, 12, { focusTab: "git" })).toEqual({
      ...LEGACY,
      search: { focusTab: "git" },
    });
  });

  it("takes the legacy route for a feature not known to exist", () => {
    // It may have been deleted elsewhere: the legacy page says so.
    queryClient.setQueryData(getListProjectsQueryKey(), [PROJECT]);
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 3 }), [{ ...FEATURE, id: 99 }]);

    expect(conversationRoute(3, 12)).toEqual(LEGACY);
  });

  it("does not take a failed feature query for proof that it exists", async () => {
    queryClient.setQueryData(getListProjectsQueryKey(), [PROJECT]);
    // Fetched once, then deleted elsewhere: the refetch failed with a 404.
    queryClient.setQueryData(getGetFeatureQueryKey(12), FEATURE);
    await expect(
      queryClient.fetchQuery({
        queryKey: getGetFeatureQueryKey(12),
        queryFn: () => Promise.reject(new Error("404")),
        retry: false,
        staleTime: 0,
      }),
    ).rejects.toThrow("404");
    expect(queryClient.getQueryState(getGetFeatureQueryKey(12))?.status).toBe("error");

    expect(conversationRoute(3, 12)).toEqual(LEGACY);
  });

  it("takes the legacy route when the project's path is not cached", () => {
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 3 }), [FEATURE]);

    expect(conversationRoute(3, 12)).toEqual(LEGACY);
  });

  it("trusts a feature the caller holds, and a path the caller gives", () => {
    queryClient.setQueryData(getListProjectsQueryKey(), [PROJECT]);
    // Just created: not in any list yet.
    expect(conversationRoute(3, 12, { featureKnown: true })).toEqual(DIRECT);

    queryClient.clear();
    expect(conversationRoute(3, 12, { featureKnown: true, cwd: "/repo" })).toEqual(DIRECT);
  });

  it("navigates to the route it picks", () => {
    queryClient.setQueryData(getListProjectsQueryKey(), [PROJECT]);
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 3 }), [FEATURE]);
    const navigate = vi.fn(() => Promise.resolve());

    navigateToConversation(navigate, 3, 12);

    expect(navigate).toHaveBeenCalledWith(DIRECT);
  });
});
