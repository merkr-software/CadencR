import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { getListFeaturesQueryKey, type ArchiveResponse, type Feature } from "@/api/generated";
import { useArchiveFeatureAction } from "./useArchiveFeatureAction";

const { customInstance, navigate, disconnect, progress } = vi.hoisted(() => ({
  customInstance: vi.fn(),
  navigate: vi.fn(),
  disconnect: vi.fn(),
  progress: { start: vi.fn(), finish: vi.fn(), fail: vi.fn() },
}));

vi.mock("@/lib/archive-progress-toast", () => ({
  startArchiveProgress: progress.start,
  finishArchiveProgress: progress.finish,
  failArchiveProgress: progress.fail,
}));

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
    (props: { projectId: number | null }) =>
      useArchiveFeatureAction({ activeFeatureId, activeFeatures: features, ...props }),
    { wrapper, initialProps: { projectId: 1 as number | null } },
  );
  return { ...hook, client, listKey, otherListKey, detailKey };
}

describe("useArchiveFeatureAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customInstance.mockReset();
  });

  it("opens the progress toast, then updates all confirmed IDs and leaves the archived group", async () => {
    let resolveRequest: ((response: ArchiveResponse) => void) | undefined;
    customInstance.mockImplementation(
      () =>
        new Promise<ArchiveResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const { result, client, listKey, otherListKey, detailKey, unmount } = setup(3);
    act(() => result.current(2, options));
    await waitFor(() => expect(customInstance).toHaveBeenCalledOnce());
    expect(customInstance.mock.calls[0]?.[0]).toMatchObject({
      url: "/api/features/2/archive",
      method: "POST",
      data: options,
    });
    expect(progress.start).toHaveBeenCalledExactlyOnceWith(2);
    expect(client.getQueryData(listKey)).toBe(features);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => resolveRequest?.({ archived_ids: [1, 2, 3], cleanup: {} }));
    await waitFor(() => expect(progress.finish).toHaveBeenCalledExactlyOnceWith(2, {}));
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
    act(() => result.current(2, options));
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(3));
    expect(navigate).not.toHaveBeenCalled();
    unmount();
    client.clear();
  });

  it("hands the cleanup report to the progress toast", async () => {
    const cleanup = { terminals: { status: "done" }, worktree: { status: "done" } };
    customInstance.mockResolvedValueOnce({ archived_ids: [2], cleanup });
    const { result, client, unmount } = setup(4);
    act(() => result.current(2, { ...options, kill_terminals: true, remove_worktree: true }));
    await waitFor(() => expect(progress.finish).toHaveBeenCalledExactlyOnceWith(2, cleanup));
    expect(customInstance.mock.calls[0]?.[0]).toMatchObject({
      data: { kill_terminals: true, remove_worktree: true },
    });
    unmount();
    client.clear();
  });

  it("reports a failure on the toast without changing cache, sessions or navigation", async () => {
    const failure = new Error("Archive failed");
    customInstance.mockRejectedValue(failure);
    const { result, client, listKey, detailKey, unmount } = setup(3);
    act(() => result.current(2, options));
    await waitFor(() => expect(progress.fail).toHaveBeenCalledExactlyOnceWith(2, failure, false));
    expect(progress.finish).not.toHaveBeenCalled();
    expect(client.getQueryData(listKey)).toBe(features);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    unmount();
    client.clear();
  });

  it("tells a lost answer after the service announced the archive from a refusal", async () => {
    const lost = new AxiosError("timeout of 600000ms exceeded", "ECONNABORTED");
    const refused = new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 409,
      statusText: "Conflict",
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { error: "This session's archive cleanup is already running", code: "CONFLICT" },
    });
    const { result, client, listKey, unmount } = setup(3);
    client.setQueryData(
      listKey,
      features.map((feature) => (feature.id === 2 ? { ...feature, status: "archived" } : feature)),
    );
    customInstance.mockRejectedValueOnce(lost);
    act(() => result.current(2, options));
    await waitFor(() => expect(progress.fail).toHaveBeenLastCalledWith(2, lost, true));

    customInstance.mockRejectedValueOnce(refused);
    act(() => result.current(2, options));
    await waitFor(() => expect(progress.fail).toHaveBeenLastCalledWith(2, refused, false));
    unmount();
    client.clear();
  });

  it("navigates within the project the request was sent from once the dialog is gone", async () => {
    let resolveRequest: ((response: ArchiveResponse) => void) | undefined;
    customInstance.mockImplementation(
      () =>
        new Promise<ArchiveResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const { result, client, rerender, unmount } = setup(3);
    act(() => result.current(2, options));
    await waitFor(() => expect(customInstance).toHaveBeenCalledOnce());
    // The sidebar's dialog closed: it no longer knows the conversation's project.
    rerender({ projectId: null });
    await act(async () => resolveRequest?.({ archived_ids: [1, 2, 3], cleanup: {} }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: "1", featureId: "4" },
      }),
    );
    unmount();
    client.clear();
  });
});
