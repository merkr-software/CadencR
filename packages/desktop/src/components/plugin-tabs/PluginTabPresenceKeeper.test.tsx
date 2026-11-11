import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginTabSummary } from "@/api/generated";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import {
  forgetFeatureProject,
  rememberFeatureProject,
  usePluginTabFeatureProjects,
} from "@/lib/plugin-tabs/feature-projects";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { createTestQueryClient, render, waitFor } from "@/test-utils";

import {
  createPluginTabsBridgeMock,
  linuxOnlyBackendTab,
  pluginTabSummary,
} from "./plugin-tab-fixtures";
import {
  PluginTabPresenceKeeper,
  selectPlacedPluginTabs,
  wantedLeases,
} from "./PluginTabPresenceKeeper";

const mocks = vi.hoisted(() => ({
  tabs: new Map<number, PluginTabSummary[]>(),
  renew: vi.fn(async (..._args: unknown[]) => undefined),
  release: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  getPluginTabListQueryOptions: (params: { project_id: number }) => ({
    queryKey: ["/api/plugin-tabs", params],
    queryFn: () => mocks.tabs.get(params.project_id) ?? [],
  }),
  pluginTabRenewPresence: mocks.renew,
  pluginTabReleasePresence: mocks.release,
}));

const backendTab = (overrides: Partial<PluginTabSummary> = {}) =>
  linuxOnlyBackendTab({ backend_availability: "available", ...overrides });

const renewedFor = () => mocks.renew.mock.calls.map((call) => [call[0], call[2]]);

beforeEach(() => {
  setDesktopBridgeOverrideForTests({
    isElectron: true,
    pluginTabs: createPluginTabsBridgeMock().bridge,
  });
  useFeatureLayoutStore.setState({ features: {} });
  usePluginTabFeatureProjects.setState({ projects: {} });
  mocks.tabs = new Map([[1, [backendTab(), pluginTabSummary({ id: "notes", name: "Notes" })]]]);
  mocks.renew.mockClear();
  mocks.release.mockClear();
});

afterEach(() => {
  clearDesktopBridgeOverrideForTests();
});

function place(featureId: number, pluginId: string): void {
  act(() => {
    useFeatureLayoutStore.getState().addTab(featureId, `plugin:${pluginId}`);
    rememberFeatureProject(featureId, 1);
  });
}

describe("PluginTabPresenceKeeper", () => {
  it("lists the custom tabs placed in every conversation, unchanged by unrelated writes", () => {
    place(9, "graph");
    place(7, "graph");
    place(7, "notes");
    const before = selectPlacedPluginTabs(useFeatureLayoutStore.getState());
    expect(before).toEqual([
      { featureId: 7, pluginId: "graph" },
      { featureId: 7, pluginId: "notes" },
      { featureId: 9, pluginId: "graph" },
    ]);
    // Another conversation's write keeps every entry: `useShallow` sees no change.
    act(() => useFeatureLayoutStore.getState().addTab(9, "terminal"));
    const after = selectPlacedPluginTabs(useFeatureLayoutStore.getState());
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it("leases each open backend tab of every conversation until it is closed", async () => {
    place(7, "graph");
    place(9, "graph");
    place(7, "notes");
    render(<PluginTabPresenceKeeper />);
    await waitFor(() => expect(mocks.renew).toHaveBeenCalledTimes(2));
    // One lease per instance; a tab without a backend takes none.
    expect(renewedFor()).toEqual([
      ["graph", { feature_id: 7 }],
      ["graph", { feature_id: 9 }],
    ]);
    // Another conversation on screen, or Settings, changes no tab strip.
    act(() => useFeatureLayoutStore.getState().setFocusedPane(9, null));
    expect(mocks.release).not.toHaveBeenCalled();
    act(() => useFeatureLayoutStore.getState().removeTab(7, "plugin:graph"));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1));
    expect(mocks.release.mock.calls[0]).toEqual(["graph", mocks.renew.mock.calls[0]?.[1]]);
  });

  it("releases the lease of a tab that may no longer run", async () => {
    place(7, "graph");
    const queryClient = createTestQueryClient();
    render(<PluginTabPresenceKeeper />, { queryClient });
    await waitFor(() => expect(mocks.renew).toHaveBeenCalledTimes(1));
    mocks.tabs.set(1, [backendTab({ status: "blocked", blocked_reason: "Malware." })]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["/api/plugin-tabs"] }));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1));
  });

  it("releases the leases of a deleted conversation, whose layout stays behind", async () => {
    place(7, "graph");
    place(9, "graph");
    render(<PluginTabPresenceKeeper />);
    await waitFor(() => expect(mocks.renew).toHaveBeenCalledTimes(2));
    act(() => forgetFeatureProject(7));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1));
    expect(mocks.release.mock.calls[0]).toEqual(["graph", mocks.renew.mock.calls[0]?.[1]]);
    expect(useFeatureLayoutStore.getState().features[7]).toBeDefined();
  });

  it("leases no tab whose backend can't run here", () => {
    const tabs = [
      linuxOnlyBackendTab(),
      backendTab({
        id: "off",
        enablement: { global: false, project: null, effective: false, consent_required: false },
      }),
      backendTab({ id: "unbuilt", entry_present: false }),
      backendTab({ id: "ports", name: "Ports" }),
    ];
    const placed = tabs.map((tab) => ({ featureId: 7, pluginId: tab.id }));
    expect(wantedLeases(placed, { 7: 1 }, () => tabs)).toEqual([
      { instanceId: "7:plugin:ports", pluginId: "ports", featureId: 7, name: "Ports" },
    ]);
    expect(wantedLeases(placed, {}, () => tabs)).toEqual([]);
  });

  it("leases a backend tab shown in place of a built-in once per conversation", () => {
    const tabs = [backendTab({ id: "ports", name: "Ports", replaces: ["terminal"] })];
    const lease = { instanceId: "7:plugin:ports", pluginId: "ports", featureId: 7, name: "Ports" };
    expect(wantedLeases([], { 7: 1 }, () => tabs, { terminal: "ports" })).toEqual([lease]);
    // Placed as well: still one instance.
    const placed = [{ featureId: 7, pluginId: "ports" }];
    expect(wantedLeases(placed, { 7: 1 }, () => tabs, { terminal: "ports" })).toEqual([lease]);
    // Not declared for that built-in: nothing replaces it.
    expect(wantedLeases([], { 7: 1 }, () => tabs, { git: "ports" })).toEqual([]);
  });

  it("leases nothing outside the desktop app", async () => {
    setDesktopBridgeOverrideForTests({ isElectron: false });
    place(7, "graph");
    render(<PluginTabPresenceKeeper />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.renew).not.toHaveBeenCalled();
  });
});
