import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "@/api/generated";
import { buildFeatureForest } from "@/lib/feature-hierarchy";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { SidebarAttentionProvider } from "@/components/SidebarAttentionProvider";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useUnreadStore } from "@/stores/unread-store";
import { createTestQueryClient } from "@/test-utils";
import { useDormantSplit } from "./useDormantSplit";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function feature(id: number, lastActivityDays: number, spawnedBy?: number): Feature {
  return {
    id,
    title: `F${id}`,
    created_at: daysAgo(lastActivityDays),
    last_activity_at: daysAgo(lastActivityDays),
    spawned_by_feature_id: spawnedBy ?? null,
  } as Feature;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
  useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {} });
});

function withAttention({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={createTestQueryClient()}>
      <SidebarAttentionProvider>{children}</SidebarAttentionProvider>
    </QueryClientProvider>
  );
}

describe("useDormantSplit", () => {
  const forest = buildFeatureForest([
    feature(1, 1),
    feature(2, 10),
    feature(3, 10),
    feature(4, 1, 3),
    feature(5, 20),
  ]);
  const ids = (nodes: { feature: Feature }[]) => nodes.map((node) => node.feature.id);

  it("folds roots idle past the threshold, unless something under them is recent", () => {
    const { result } = renderHook(() => useDormantSplit(forest, null, false));
    expect(ids(result.current.awake)).toEqual([1, 3]);
    expect(ids(result.current.dormant)).toEqual([2, 5]);
  });

  it("keeps the open conversation awake and folds nothing while filtering", () => {
    const open = renderHook(() => useDormantSplit(forest, 5, false));
    expect(ids(open.result.current.dormant)).toEqual([2]);
    const filtering = renderHook(() => useDormantSplit(forest, null, true));
    expect(filtering.result.current.dormant).toEqual([]);
  });

  it("keeps a conversation with something unseen awake, before its record loads", () => {
    useUnreadStore.getState().markUnread(2);
    const { result } = renderHook(() => useDormantSplit(forest, null, false), {
      wrapper: withAttention,
    });
    expect(ids(result.current.dormant)).toEqual([5]);
  });

  it("keeps the same split object while nothing moves", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDormantSplit(forest, active, false),
      { initialProps: { active: null as number | null } },
    );
    const first = result.current;
    rerender({ active: 1 });
    expect(result.current).toBe(first);
  });

  it("follows the configured days, and never folds when off", () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, dormantAfter: "14" } });
    const twoWeeks = renderHook(() => useDormantSplit(forest, null, false));
    expect(ids(twoWeeks.result.current.dormant)).toEqual([5]);
    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, dormantAfter: "never" },
    });
    const never = renderHook(() => useDormantSplit(forest, null, false));
    expect(never.result.current.awake).toBe(forest);
  });
});
