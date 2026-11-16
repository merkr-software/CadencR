import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, waitFor } from "@/test-utils";
import type { Feature } from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";

const mocks = vi.hoisted(() => ({
  active: [] as Feature[],
  batch: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/api/generated", () => {
  const settingKey = (key: string) => ["/api/settings", key];
  return {
    getGetWorkspaceSettingQueryKey: settingKey,
    getListActiveFeaturesQueryOptions: () => ({
      queryKey: ["/api/features/active"],
      queryFn: async () => mocks.active,
    }),
    useGetWorkspaceSetting: (key: string, options?: { query?: { enabled?: boolean } }) =>
      useQuery({
        queryKey: settingKey(key),
        queryFn: async () => ({ value: null }),
        enabled: options?.query?.enabled,
      }),
    setWorkspaceSettingsBatch: mocks.batch,
  };
});
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

import { moveConversation, useManualConversationOrder } from "@/hooks/useManualConversationOrder";

const ORDER = ["/api/settings", "sidebar_conversation_order"];

function feature(id: number, createdAt: string): Feature {
  return { id, title: `F${id}`, created_at: createdAt } as unknown as Feature;
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** The batch endpoint echoes what it stored, after a tick like a real request. */
function echoBatch(): void {
  mocks.batch.mockImplementation(async ({ values }: { values: Record<string, string> }) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return Object.entries(values).map(([key, value]) => ({ key, value }));
  });
}

/** The saved sort, in the settings cache and mirrored into the config store. */
function setSort(conversationSort: typeof DEFAULT_SIDEBAR_CONFIG.conversationSort): void {
  queryClient.setQueryData(["/api/settings", "sidebar_conversation_sort"], {
    value: conversationSort,
  });
  useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, conversationSort } });
}

beforeEach(() => {
  // Last activity first, as the endpoint returns them.
  mocks.active = [
    feature(10, "2026-10-01 10:00:00"),
    feature(11, "2026-10-04 10:00:00"),
    feature(12, "2026-10-02 10:00:00"),
    feature(13, "2026-10-03 10:00:00"),
  ];
  mocks.batch.mockReset();
  mocks.toastError.mockReset();
  echoBatch();
  setSort("activity");
});

afterEach(() => {
  queryClient.clear();
});

describe("moveConversation", () => {
  it("ranks only the dragged group and switches to manual on the first drop", async () => {
    await moveConversation([11, 12], 12, { targetId: 11, position: "before" });
    expect(mocks.batch).toHaveBeenCalledWith({
      values: {
        sidebar_conversation_order: "[12,11]",
        sidebar_conversation_sort: "manual",
      },
    });
    expect(queryClient.getQueryData(ORDER)).toEqual({ value: "[12,11]" });
    expect(queryClient.getQueryData(["/api/settings", "sidebar_conversation_sort"])).toEqual({
      value: "manual",
    });
  });

  it("seeds every conversation in the current sort's order (newest created first)", async () => {
    setSort("created");
    // Displayed by creation: 11, 13, 12, 10. Move 10 above 12.
    await moveConversation([11, 13, 12, 10], 10, { targetId: 12, position: "before" });
    const values = mocks.batch.mock.calls[0]?.[0].values;
    expect(values.sidebar_conversation_order).toBe("[11,13,10,12]");
  });

  it("under manual, writes only the order and prunes conversations no longer listed", async () => {
    setSort("manual");
    queryClient.setQueryData(ORDER, { value: "[13,99,12,11,10]" });
    await moveConversation([13, 12, 11, 10], 10, { targetId: 13, position: "before" });
    expect(mocks.batch).toHaveBeenCalledWith({
      values: { sidebar_conversation_order: "[10,13,12,11]" },
    });
  });

  it("runs moves one after another, each from the order the last one saved", async () => {
    setSort("manual");
    queryClient.setQueryData(ORDER, { value: "[10,11,12,13]" });
    await Promise.all([
      moveConversation([10, 11], 11, { targetId: 10, position: "before" }),
      moveConversation([12, 13], 13, { targetId: 12, position: "before" }),
    ]);
    expect(queryClient.getQueryData(ORDER)).toEqual({ value: "[11,10,13,12]" });
  });

  it("steps a held move shortcut from where the previous step left the row", async () => {
    setSort("manual");
    queryClient.setQueryData(ORDER, { value: "[10,11,12,13]" });
    // Every step was pressed while the list still showed the first order.
    const group = [10, 11, 12, 13];
    await Promise.all([1, 2, 3].map(() => moveConversation(group, 13, { direction: "up" })));
    expect(queryClient.getQueryData(ORDER)).toEqual({ value: "[13,10,11,12]" });
    await moveConversation(group, 13, { direction: "up" });
    expect(mocks.batch).toHaveBeenCalledTimes(3);
  });

  it("keeps stepping a held shortcut right after the first step switched to manual", async () => {
    const group = [10, 11, 12, 13];
    await Promise.all([1, 2].map(() => moveConversation(group, 13, { direction: "up" })));
    expect(queryClient.getQueryData(ORDER)).toEqual({ value: "[10,13,11,12]" });
    expect(mocks.batch.mock.calls[1]?.[0].values).toEqual({
      sidebar_conversation_order: "[10,13,11,12]",
    });
  });

  it("writes nothing when the drop leaves the row in place", async () => {
    await moveConversation([11, 12], 12, { targetId: 11, position: "after" });
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it("refuses to write under manual before the stored order loaded", async () => {
    setSort("manual");
    await moveConversation([11, 12], 12, { targetId: 11, position: "before" });
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not save setting "sidebar_conversation_order": it has not loaded yet.',
      { id: "setting-sidebar_conversation_order" },
    );
  });

  it("says why a failed write failed, leaves the cache alone and lets the next move run", async () => {
    mocks.batch.mockRejectedValueOnce(new Error("disk full"));
    await moveConversation([11, 12], 12, { targetId: 11, position: "before" });
    expect(mocks.toastError).toHaveBeenCalledWith("Could not reorder conversations: disk full");
    expect(queryClient.getQueryData(ORDER)).toBeUndefined();
    await moveConversation([11, 12], 12, { targetId: 11, position: "before" });
    expect(queryClient.getQueryData(ORDER)).toEqual({ value: "[12,11]" });
  });
});

describe("useManualConversationOrder", () => {
  beforeEach(() => {
    queryClient.setDefaultOptions({ queries: { staleTime: Infinity } });
  });

  it("reads the stored ids under the manual sort", () => {
    setSort("manual");
    queryClient.setQueryData(ORDER, { value: "[3,1,2]" });
    const { result } = renderHook(() => useManualConversationOrder(), { wrapper });
    expect(result.current).toEqual([3, 1, 2]);
  });

  it("reads nothing under another sort", () => {
    queryClient.setQueryData(ORDER, { value: "[3,1,2]" });
    const { result } = renderHook(() => useManualConversationOrder(), { wrapper });
    expect(result.current).toEqual([]);
  });

  it("reads a corrupt value as empty and says so", async () => {
    setSort("manual");
    queryClient.setQueryData(ORDER, { value: '{"nope":1}' });
    const { result } = renderHook(() => useManualConversationOrder(), { wrapper });
    expect(result.current).toEqual([]);
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining('Could not read setting "sidebar_conversation_order"'),
        { id: "setting-sidebar_conversation_order" },
      ),
    );
  });
});
