import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginTabSummary } from "@/api/generated";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { selectFeatureLayout, useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { getPluginTabs } from "@/stores/feature-layout-tree";
import { usePluginTabRuntimeStore } from "@/lib/plugin-tabs/runtime-store";
import {
  setReplacedTabs,
  showBuiltinTab,
  useBuiltinTabFallbacks,
} from "@/lib/plugin-tabs/builtin-fallback";
import { getFocusedTab } from "@/stores/feature-layout-store";
import { render, screen } from "@/test-utils";

import {
  createPluginTabsBridgeMock,
  linuxOnlyBackendTab,
  OFF_ENABLEMENT,
  pluginTabSummary,
} from "./plugin-tab-fixtures";
import { PluginTabAddMenu } from "./PluginTabAddMenu";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(() => Promise.resolve()),
  tabs: [] as PluginTabSummary[],
  noteUserLayoutChange: vi.fn(),
  replacements: null as string | null,
}));

vi.mock("@/lib/auto-layout/auto-layout-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auto-layout/auto-layout-controller")>()),
  noteUserLayoutChange: mocks.noteUserLayoutChange,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  usePluginTabList: () => ({ data: mocks.tabs, isLoading: false, error: null }),
  useGetWorkspaceSetting: (
    key: string,
    options: { query: { select: (setting: { key: string; value: string | null }) => unknown } },
  ) => ({ data: options.query.select({ key, value: mocks.replacements }) }),
}));

let bridge: ReturnType<typeof createPluginTabsBridgeMock>["bridge"];
const setBrowserSuppressed = vi.fn(() => Promise.resolve());

beforeEach(() => {
  bridge = createPluginTabsBridgeMock().bridge;
  setDesktopBridgeOverrideForTests({ isElectron: true, pluginTabs: bridge, setBrowserSuppressed });
  useFeatureLayoutStore.setState({ features: {} });
  useBuiltinTabFallbacks.setState({ replaced: {}, shown: {} });
  mocks.replacements = null;
  mocks.navigate.mockClear();
  setBrowserSuppressed.mockClear();
  mocks.tabs = [
    pluginTabSummary(),
    pluginTabSummary({ id: "ci", name: "CI", label: "Pipelines", description: "GitLab pipelines" }),
    pluginTabSummary({ id: "off", name: "Off", label: "Disabled tab", enablement: OFF_ENABLEMENT }),
  ];
});

afterEach(() => {
  clearDesktopBridgeOverrideForTests();
});

function placedTabs(): string[] {
  return getPluginTabs(selectFeatureLayout(7)(useFeatureLayoutStore.getState()).splitRoot);
}

async function openMenu() {
  const view = render(<PluginTabAddMenu featureId={7} projectId={1} />);
  await view.user.click(screen.getByRole("button", { name: "Add custom tab" }));
  return view;
}

describe("PluginTabAddMenu", () => {
  it("lists the project's enabled tabs and suppresses native views while open", async () => {
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Graph" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pipelines" })).toBeInTheDocument();
    expect(screen.getByText("GitLab pipelines")).toBeInTheDocument();
    expect(screen.queryByText("Disabled tab")).not.toBeInTheDocument();
    expect(setBrowserSuppressed).toHaveBeenLastCalledWith(true);
  });

  it("lists a tab whose backend can't run here as unavailable, and won't add it", async () => {
    mocks.tabs = [linuxOnlyBackendTab({ id: "ports", label: "Ports" })];
    const { user } = await openMenu();
    const item = screen.getByRole("menuitem", { name: "Ports" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Unavailable on this platform")).toBeInTheDocument();
    await user.click(item);
    expect(placedTabs()).toEqual([]);
  });

  it("adds a tab to the layout, and activates instead of duplicating a placed one", async () => {
    const { user } = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Pipelines" }));
    expect(placedTabs()).toEqual(["plugin:ci"]);
    // A structural edit, so an auto-layout Undo can't drop the new tab.
    expect(mocks.noteUserLayoutChange).toHaveBeenCalledWith(7, { structural: true });

    await user.click(screen.getByRole("button", { name: "Add custom tab" }));
    expect(screen.getByRole("menuitem", { name: "Pipelines (open)" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Pipelines (open)" }));
    expect(placedTabs()).toEqual(["plugin:ci"]);
  });

  it("links to the settings section and the create dialog", async () => {
    const { user } = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: /Create custom tab/ }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "custom-tabs", action: "create" },
    });
    await user.click(screen.getByRole("button", { name: "Add custom tab" }));
    await user.click(screen.getByRole("menuitem", { name: /Manage custom tabs/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/settings",
      search: { section: "custom-tabs" },
    });
  });

  it("offers reload and DevTools for the focused custom tab", async () => {
    useFeatureLayoutStore.getState().addTab(7, "plugin:graph");
    const { user } = await openMenu();
    expect(screen.getByRole("menuitem", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open source project" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Open DevTools" }));
    expect(bridge.openDevTools).toHaveBeenCalledWith("7:plugin:graph");
  });

  it("opens a replacement in the built-in's place and switches the place back and forth", async () => {
    mocks.tabs = [pluginTabSummary({ id: "vcs", label: "VCS", replaces: ["git"] })];
    mocks.replacements = '{"git":"vcs"}';
    setReplacedTabs(7, { git: "vcs" }, { git: "vcs" });
    const { user } = await openMenu();
    expect(screen.getByText("Shown in place of Git")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "VCS (open)" }));
    expect(placedTabs()).toEqual([]);
    expect(getFocusedTab(selectFeatureLayout(7)(useFeatureLayoutStore.getState()))).toBe("git");

    // Focused: the replacement's own actions, and the way to the built-in.
    await user.click(screen.getByRole("button", { name: "Add custom tab" }));
    await user.click(screen.getByRole("menuitem", { name: "Open DevTools" }));
    expect(bridge.openDevTools).toHaveBeenCalledWith("7:plugin:vcs");
    await user.click(screen.getByRole("button", { name: "Add custom tab" }));
    await user.click(screen.getByRole("menuitem", { name: "Show the built-in Git" }));
    expect(useBuiltinTabFallbacks.getState().shown[7]).toEqual({ git: "vcs" });

    await user.click(screen.getByRole("button", { name: "Add custom tab" }));
    expect(screen.queryByRole("menuitem", { name: "Open DevTools" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Show VCS instead of Git" }));
    expect(useBuiltinTabFallbacks.getState().shown[7]).toEqual({});

    // Picking it from the list while the built-in shows takes the place back.
    act(() => showBuiltinTab(7, "git"));
    await user.click(screen.getByRole("button", { name: "Add custom tab" }));
    expect(screen.getByText("Replaces Git; the built-in shows here now")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "VCS" }));
    expect(useBuiltinTabFallbacks.getState().shown[7]).toEqual({});
    expect(placedTabs()).toEqual([]);
  });

  it("marks tabs that run commands or native code and opens their Activity", async () => {
    mocks.tabs = [
      pluginTabSummary(),
      pluginTabSummary({ id: "runner", label: "Reviewers", access_level: "commands" }),
      pluginTabSummary({ id: "native", label: "Ports", access_level: "backend" }),
    ];
    useFeatureLayoutStore.getState().addTab(7, "plugin:native");
    const { user } = await openMenu();
    expect(screen.getByRole("img", { name: "Runs commands" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Native code" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Activity…" }));
    expect(usePluginTabRuntimeStore.getState().activityOpen).toBe("7:plugin:native");
  });

  it("offers no Activity for a read-only tab", async () => {
    useFeatureLayoutStore.getState().addTab(7, "plugin:graph");
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Activity…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Runs commands" })).not.toBeInTheDocument();
  });

  it("says so when no tab is on for the project", async () => {
    mocks.tabs = [pluginTabSummary({ enablement: OFF_ENABLEMENT })];
    await openMenu();
    expect(screen.getByText("No custom tab is on for this project yet.")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Reload" })).not.toBeInTheDocument();
  });
});
