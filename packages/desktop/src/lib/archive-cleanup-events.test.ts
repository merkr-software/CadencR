// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGetArchiveCleanupQueryKey,
  getListArchiveCleanupsQueryKey,
  getListFeatureActivityQueryKey,
  getListFeaturesQueryKey,
  type Feature,
} from "@/api/generated";
import { useTerminalStore } from "@/hooks/useTerminalState";
import { queryClient } from "@/lib/queryClient";
import { handleArchiveCleanupEvent } from "@/lib/archive-cleanup-events";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";

const navigate = vi.hoisted(() => vi.fn(async () => undefined));
const closeFeatureSession = vi.hoisted(() => vi.fn());
const updateArchiveProgress = vi.hoisted(() => vi.fn());

vi.mock("@/router", () => ({ router: { navigate } }));
vi.mock("@/lib/archive-progress-toast", () => ({ updateArchiveProgress }));
vi.mock("@/components/project-feature-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/project-feature-navigation")>()),
  closeFeatureSession,
}));

function feature(id: number, status: Feature["status"] = "active"): Feature {
  return { id, project_id: 1, title: `F${id}`, status } as Feature;
}

function event(cleanup: Record<string, unknown>, archivedIds: number[] = []) {
  return { project_id: 1, feature_id: 2, archived_feature_ids: archivedIds, cleanup };
}

describe("handleArchiveCleanupEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    window.location.hash = "";
    useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
  });

  it("applies an archive made elsewhere: cached lists, live sessions, cleanup queries", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 1 }), [feature(1), feature(2)]);

    handleArchiveCleanupEvent(event({ worktree: { status: "pending" } }, [2, 3]));

    const cached = queryClient.getQueryData<Feature[]>(getListFeaturesQueryKey({ project_id: 1 }));
    expect(cached?.find((candidate) => candidate.id === 2)?.status).toBe("archived");
    expect(closeFeatureSession.mock.calls).toEqual([[2], [3]]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: getListArchiveCleanupsQueryKey() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: getGetArchiveCleanupQueryKey(2) });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("tears down the terminal panes once the service killed their shells", () => {
    const closePanel = vi.spyOn(useTerminalStore.getState(), "closePanel");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    handleArchiveCleanupEvent(event({ terminals: { status: "running" } }));
    expect(closePanel).not.toHaveBeenCalled();
    expect(closeFeatureSession).not.toHaveBeenCalled();

    handleArchiveCleanupEvent(
      event({ terminals: { status: "done", detail: "killed 1 shell(s)" } }),
    );
    expect(closePanel).toHaveBeenCalledWith(2);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getListFeatureActivityQueryKey({ project_id: 1, include_archived: true }),
    });
  });

  it("leaves the archived conversation for its neighbour when it is on screen", async () => {
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 1 }), [
      feature(1),
      feature(2),
      feature(4, "archived"),
    ]);
    window.location.hash = "#/ws-session/ws-feature-2?featureId=2&projectId=1";

    handleArchiveCleanupEvent(event({}, [2]));

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: "1", featureId: "1" },
      }),
    );
  });

  it("still picks the next neighbour when a refetch marked the viewed conversation archived first", async () => {
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 1 }), [
      feature(1),
      feature(2, "archived"),
      feature(3),
    ]);
    window.location.hash = "#/ws-session/ws-feature-2?featureId=2&projectId=1";

    handleArchiveCleanupEvent(event({}, [2]));

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: "1", featureId: "3" },
      }),
    );

    // Multi-feature archive where relatives are also already archived in the refetched list.
    navigate.mockClear();
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 1 }), [
      feature(1, "archived"),
      feature(2, "archived"),
      feature(3, "archived"),
      feature(4),
    ]);
    handleArchiveCleanupEvent(event({}, [1, 2, 3]));

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: "1", featureId: "4" },
      }),
    );
  });

  it("picks the next neighbour in the sidebar's configured sort order", async () => {
    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, conversationSort: "title" },
    });
    // Raw cache order: [2: Alpha, 1: Zeta, 3: Middle]; Title sort: [2: Alpha, 3: Middle, 1: Zeta].
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 1 }), [
      { ...feature(2), title: "Alpha" },
      { ...feature(1), title: "Zeta" },
      { ...feature(3), title: "Middle" },
    ]);
    window.location.hash = "#/ws-session/ws-feature-2?featureId=2&projectId=1";

    handleArchiveCleanupEvent(event({}, [2]));

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: "1", featureId: "3" },
      }),
    );
  });

  it("navigates to the project home screen when archiving the last active conversation", async () => {
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 1 }), [
      feature(2),
      feature(4, "archived"),
    ]);
    window.location.hash = "#/ws-session/ws-feature-2?featureId=2&projectId=1";

    handleArchiveCleanupEvent(event({}, [2]));

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/",
        search: { projectId: 1 },
      }),
    );
  });

  it("refetches every cleanup after a bare (lagged) event", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    handleArchiveCleanupEvent({});

    expect(invalidate).toHaveBeenCalled();
    expect(closeFeatureSession).not.toHaveBeenCalled();
  });

  it("hands each step change to the progress toast of the archived conversation", () => {
    const cleanup = { worktree: { status: "running" } };
    handleArchiveCleanupEvent(event(cleanup));
    expect(updateArchiveProgress).toHaveBeenCalledExactlyOnceWith(2, cleanup);
  });
});
