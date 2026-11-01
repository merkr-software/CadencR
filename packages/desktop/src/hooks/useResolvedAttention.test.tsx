import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createTestQueryClient, renderHook, waitFor } from "@/test-utils";
import { getGetFeatureQueryKey, type Feature, type PrStatusSnapshot } from "@/api/generated";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useUnreadStore } from "@/stores/unread-store";
import { usePrStatusStore } from "@/stores/usePrStatusStore";
import { useResolvedAttention } from "./useResolvedAttention";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", () => ({ customInstance: request }));

function feature(id: number, status: Feature["status"] = "active"): Feature {
  return { id, title: `F${id}`, project_id: 9, status } as Feature;
}

function failingCi(featureId: number): PrStatusSnapshot {
  return {
    feature_id: featureId,
    fetched_at: 1,
    setup_required: false,
    error: null,
    ci: { state: "failing", checks: [] },
    pr: {
      number: featureId,
      title: "PR",
      body_markdown: "",
      state: "open",
      url: "https://forge.test/pr",
      source_branch: "b",
      target_branch: "main",
      head_sha: "abc",
      review_state: "none",
      author: { username: "me" },
      updated_at: "2026-10-01T00:00:00Z",
      pr_label: "Pull request",
    },
  };
}

function notFound(): Error {
  return Object.assign(new Error("Not found"), { isAxiosError: true, response: { status: 404 } });
}

function renderAttention(seeded: readonly Feature[]) {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
  for (const item of seeded) client.setQueryData(getGetFeatureQueryKey(item.id), item);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useResolvedAttention(), { wrapper });
}

beforeEach(() => {
  request.mockReset();
  useSessionStatusStore.setState({
    bySession: { 10: { featureId: 1, status: "question", kind: "permission", seq: 1 } },
  });
  useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {}, prAcks: {} });
  usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
});

describe("useResolvedAttention actions", () => {
  it("resolves pull request actions without counting them as attention", () => {
    useUnreadStore.getState().markUnread(2);
    usePrStatusStore.getState().hydrate([failingCi(3)]);
    const { result } = renderAttention([feature(1), feature(2), feature(3)]);

    expect(result.current.actions.map((a) => [a.feature.id, a.kind])).toEqual([
      [1, "waiting"],
      [3, "fix_ci"],
      [2, "review"],
    ]);
    expect(result.current.actionsLoading).toBe(false);
    expect(result.current.items.map((item) => item.feature.id)).toEqual([1, 2]);
    expect(result.current.queue.map((item) => item.feature.id)).toEqual([1, 2]);
    expect(result.current.byProject.get(9)).toEqual({
      waiting: 1,
      failed: 0,
      working: 0,
      unread: 1,
    });
  });

  it("waits on a pull request's conversation lookup, then lists it", async () => {
    let resolve: (value: Feature) => void = () => {};
    request.mockReturnValue(new Promise<Feature>((done) => (resolve = done)));
    usePrStatusStore.getState().hydrate([failingCi(3)]);
    const { result } = renderAttention([feature(1)]);

    expect(result.current.actionsLoading).toBe(true);
    expect(result.current.loadingStates).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => resolve(feature(3)));

    await waitFor(() => expect(result.current.actionsLoading).toBe(false));
    expect(result.current.actions.map((a) => a.feature.id)).toEqual([1, 3]);
  });

  it("keeps its result while nothing changes", () => {
    usePrStatusStore.getState().hydrate([failingCi(3)]);
    const { result, rerender } = renderAttention([feature(1), feature(3)]);
    const first = result.current;
    rerender();
    act(() => usePrStatusStore.getState().hydrate([{ ...failingCi(3), fetched_at: 2 }]));
    expect(result.current).toBe(first);
  });
});

describe("useResolvedAttention gone conversations", () => {
  it("clears the unread or failed mark of an archived or deleted conversation", async () => {
    request.mockRejectedValue(notFound());
    useUnreadStore.getState().markUnread(2);
    useUnreadStore.getState().markFailed(4);
    const { result } = renderAttention([feature(1), feature(2, "archived")]);

    await waitFor(() => expect(useUnreadStore.getState().failedByFeature).toEqual({}));
    expect(useUnreadStore.getState().byFeature).toEqual({});
    expect(result.current.items.map((item) => item.feature.id)).toEqual([1]);
    expect(result.current.actions.map((a) => a.feature.id)).toEqual([1]);
  });

  it("drops an archived pull request conversation from the actions", () => {
    usePrStatusStore.getState().hydrate([failingCi(3)]);
    const { result } = renderAttention([feature(1), feature(3, "archived")]);
    expect(result.current.actions.map((a) => a.feature.id)).toEqual([1]);
  });

  it("forgets a dismissed pull request action once its conversation is gone", async () => {
    request.mockRejectedValue(notFound());
    useUnreadStore.setState({ prAcks: { 3: "fix_ci:3:abc", 5: "merge:5:def" } });
    const { result } = renderAttention([feature(1), feature(3)]);

    await waitFor(() => expect(useUnreadStore.getState().prAcks).toEqual({ 3: "fix_ci:3:abc" }));
    expect(result.current.actions.map((a) => a.feature.id)).toEqual([1]);
  });
});

describe("useResolvedAttention list seeds", () => {
  it("refetches a record seeded from an invalidated project list", async () => {
    const { queryClient } = await import("@/lib/queryClient");
    queryClient.setQueryData(
      ["/api/features", { project_id: 9 }],
      [{ ...feature(1), runtime_provider: "old-provider" }],
    );
    await queryClient.invalidateQueries({ queryKey: ["/api/features"], refetchType: "none" });
    request.mockResolvedValue({ ...feature(1), runtime_provider: "new-provider" });
    try {
      const { result } = renderAttention([]);
      await waitFor(() =>
        expect(result.current.items[0]?.feature.runtime_provider).toBe("new-provider"),
      );
    } finally {
      queryClient.clear();
    }
  });
});
