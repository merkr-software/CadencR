import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryClient } from "@/lib/queryClient";

import {
  handlePluginTabChanged,
  registerLivePluginTab,
  reloadLivePluginTab,
} from "./live-instances";

const cleanups: Array<() => void> = [];

function live(instanceId: string, pluginId: string) {
  const controls = { pluginId, reload: vi.fn(), refresh: vi.fn() };
  cleanups.push(registerLivePluginTab(instanceId, controls));
  return controls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Close the change coalescer's settle window between tests.
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe("handlePluginTabChanged", () => {
  it("refetches plugin-tab reads and refreshes only that plugin's live tabs", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const graph1 = live("1:plugin:graph", "graph");
    const graph2 = live("2:plugin:graph", "graph");
    const other = live("1:plugin:other", "other");

    handlePluginTabChanged({ plugin_id: "graph" });

    expect(invalidate).toHaveBeenCalledOnce();
    expect(graph1.refresh).toHaveBeenCalledOnce();
    expect(graph2.refresh).toHaveBeenCalledOnce();
    expect(other.refresh).not.toHaveBeenCalled();
  });

  it("refreshes every live tab for a bare (lagged) event", () => {
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const graph = live("1:plugin:graph", "graph");
    const other = live("1:plugin:other", "other");
    handlePluginTabChanged({});
    expect(graph.refresh).toHaveBeenCalledOnce();
    expect(other.refresh).toHaveBeenCalledOnce();
  });

  it("folds a burst of changes into one trailing refetch and reload", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const graph = live("1:plugin:graph", "graph");
    const other = live("1:plugin:other", "other");
    const unrelated = live("1:plugin:third", "third");

    handlePluginTabChanged({ plugin_id: "graph" });
    handlePluginTabChanged({ plugin_id: "graph" });
    handlePluginTabChanged({ plugin_id: "other" });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(graph.refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(graph.refresh).toHaveBeenCalledTimes(2);
    expect(other.refresh).toHaveBeenCalledTimes(1);
    expect(unrelated.refresh).not.toHaveBeenCalled();
  });
});

describe("reloadLivePluginTab", () => {
  it("reloads a mounted tab and reports when none is running", () => {
    const graph = live("1:plugin:graph", "graph");
    expect(reloadLivePluginTab("1:plugin:graph")).toBe(true);
    expect(graph.reload).toHaveBeenCalledOnce();
    expect(reloadLivePluginTab("9:plugin:graph")).toBe(false);
  });
});
