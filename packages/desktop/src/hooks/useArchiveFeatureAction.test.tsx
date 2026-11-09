import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getListFeaturesQueryKey, type ArchiveResponse, type Feature } from "@/api/generated";
import { useArchiveFeatureAction } from "./useArchiveFeatureAction";

const { customInstance, navigate, disconnect, toastSuccess } = vi.hoisted(() => ({
  customInstance: vi.fn(),
  navigate: vi.fn(),
  disconnect: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: toastSuccess } }));

vi.mock("@/api/client", () => ({ customInstance }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: { getState: () => ({ disconnect }) },
}));

const features: Feature[] = [1, 2, 3, 4].map((id) => ({
  id,
  title: `Conversation ${id}`,
  project_id: 1,
  type: "ws-session",
  status: "active",
  is_pinned: false,
  created_at: "2026-01-01T00:00:00Z",
}));
const options = {
  include_parent: true,
  include_descendants: true,
  kill_terminals: false,
  close_browser_tabs: false,
  remove_worktree: false,
  remove_branch: false,
  force_remove_worktree: false,
  force_remove_branch: false,
};

function setup(activeFeatureId: number) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const listKey = getListFeaturesQueryKey({ project_id: 1 });
  const otherListKey = getListFeaturesQueryKey({ project_id: 1, include_archived: true });
  const detailKey = ["/api/features/2/archive-preview"];
  client.setQueryData(listKey, features);
  client.setQueryData(otherListKey, features);
  client.setQueryData(detailKey, { has_relations: true });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    () => useArchiveFeatureAction({ activeFeatureId, activeFeatures: features, projectId: 1 }),
    { wrapper },
  );
  return { ...hook, client, listKey, otherListKey, detailKey };
}

describe("useArchiveFeatureAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customInstance.mockReset();
  });

  it("waits for the server, then updates all confirmed IDs and leaves the archived group", async () => {
    let resolveRequest: ((response: ArchiveResponse) => void) | undefined;
    customInstance.mockImplementation(
      () =>
        new Promise<ArchiveResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const { result, client, listKey, otherListKey, detailKey, unmount } = setup(3);
    let pending: Promise<ArchiveResponse> | undefined;
    act(() => {
      pending = result.current(2, options);
    });
    await waitFor(() => expect(customInstance).toHaveBeenCalledOnce());
    expect(customInstance.mock.calls[0]?.[0]).toMatchObject({
      url: "/api/features/2/archive",
      method: "POST",
      data: options,
    });
    expect(client.getQueryData(listKey)).toBe(features);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      resolveRequest?.({ archived_ids: [1, 2, 3], cleanup: {} });
      await pending;
    });
    for (const key of [listKey, otherListKey]) {
      expect(client.getQueryData<Feature[]>(key)?.map(({ status }) => status)).toEqual([
        "archived",
        "archived",
        "archived",
        "active",
      ]);
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(disconnect.mock.calls).toEqual([["ws-feature-1"], ["ws-feature-2"], ["ws-feature-3"]]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId: "1", featureId: "4" },
    });
    unmount();
    client.clear();
  });

  it("does not navigate away from a conversation outside the archived group", async () => {
    customInstance.mockResolvedValue({ archived_ids: [1, 2, 3], cleanup: {} });
    const { result, client, unmount } = setup(4);
    await act(async () => {
      await result.current(2, options);
    });
    expect(disconnect).toHaveBeenCalledTimes(3);
    expect(navigate).not.toHaveBeenCalled();
    unmount();
    client.clear();
  });

  it("toasts a finished cleanup and leaves steps needing the user to the cleanup notices", async () => {
    customInstance.mockResolvedValueOnce({
      archived_ids: [2],
      cleanup: { terminals: { status: "done" }, worktree: { status: "done" } },
    });
    const { result, client, unmount } = setup(4);
    await act(async () => {
      await result.current(2, { ...options, kill_terminals: true, remove_worktree: true });
    });
    expect(customInstance.mock.calls[0]?.[0]).toMatchObject({
      data: { kill_terminals: true, remove_worktree: true },
    });
    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith("Session archived", {
      description: "Cleanup finished: terminals, worktree.",
    });

    customInstance.mockResolvedValueOnce({
      archived_ids: [3],
      cleanup: {
        worktree: { status: "blocked", reason: "dirty_worktree", message: "dirty" },
        branch: { status: "pending", reason: "waiting for the worktree removal" },
      },
    });
    await act(async () => {
      await result.current(3, { ...options, remove_branch: true });
    });
    expect(toastSuccess).toHaveBeenCalledOnce();
    unmount();
    client.clear();
  });

  it("propagates failure without changing cache, sessions or navigation", async () => {
    const failure = new Error("Archive failed");
    customInstance.mockRejectedValue(failure);
    const { result, client, listKey, detailKey, unmount } = setup(3);
    await act(async () => {
      await expect(result.current(2, options)).rejects.toBe(failure);
    });
    expect(client.getQueryData(listKey)).toBe(features);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    unmount();
    client.clear();
  });
});
