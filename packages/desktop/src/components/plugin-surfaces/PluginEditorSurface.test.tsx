import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabContext } from "@cadencr/tab-sdk/protocol";
import { render, screen, waitFor } from "@/test-utils";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { createPluginTabsBridgeMock, pluginTabSummary } from "../plugin-tabs/plugin-tab-fixtures";
import { PluginEditorSurface } from "./PluginEditorSurface";

const leases = vi.hoisted(() => ({ release: vi.fn(), acquire: vi.fn() }));
vi.mock("@/lib/plugin-tabs/surface-presence", () => ({
  acquirePluginSurfacePresence: leases.acquire,
}));
const context: TabContext = {
  project: { id: 1, name: "Demo", path: "/repo" },
  feature: { id: 7, name: "Editor", branch: null, baseBranch: null, worktreePath: null },
  pullRequest: null,
  session: null,
};
const summary = pluginTabSummary({
  editor: { label: "Demo editor", open_method: "editor.open" },
  backend: { protocol: 2, reasoning: "Edit files", binary: { "darwin-aarch64": "bin/editor" } },
  backend_availability: "available",
});
let bridge: ReturnType<typeof createPluginTabsBridgeMock>;

beforeEach(() => {
  bridge = createPluginTabsBridgeMock();
  setDesktopBridgeOverrideForTests({ isElectron: true, pluginTabs: bridge.bridge });
  leases.acquire.mockReset().mockReturnValue(leases.release);
  leases.release.mockClear();
});
afterEach(clearDesktopBridgeOverrideForTests);

describe("PluginEditorSurface", () => {
  it("keeps its lease through hiding and recycling, then releases on logical close", async () => {
    const props = { featureId: 7, summary, context };
    const view = render(<PluginEditorSurface {...props} visible />);
    await waitFor(() =>
      expect(bridge.bridge.open).toHaveBeenCalledWith("7:editor:graph", "graph", {
        kind: "editor",
      }),
    );
    expect(screen.getByRole("status", { name: "Loading Demo editor" })).toBeInTheDocument();
    act(() => bridge.emit({ instanceId: "7:editor:graph", type: "loaded" }));
    await waitFor(() =>
      expect(bridge.bridge.setVisible).toHaveBeenLastCalledWith("7:editor:graph", true),
    );
    view.rerender(<PluginEditorSurface {...props} visible={false} />);
    act(() => bridge.emit({ instanceId: "7:editor:graph", type: "recycled" }));
    expect(leases.release).not.toHaveBeenCalled();
    view.rerender(<PluginEditorSurface {...props} visible />);
    await waitFor(() => expect(bridge.bridge.open).toHaveBeenCalledTimes(2));
    expect(leases.acquire).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(leases.release).toHaveBeenCalledTimes(1);
    expect(bridge.bridge.close).toHaveBeenCalledWith("7:editor:graph");
  });

  it("refuses disabled editors without acquiring a lease or opening a guest", () => {
    render(
      <PluginEditorSurface
        featureId={7}
        summary={{
          ...summary,
          enablement: { global: false, project: null, effective: false, consent_required: true },
        }}
        context={context}
        visible
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
    expect(bridge.bridge.open).not.toHaveBeenCalled();
    expect(leases.acquire).not.toHaveBeenCalled();
  });
});
