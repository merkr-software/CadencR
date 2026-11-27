import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pluginTabSummary,
  linuxOnlyBackendTab,
} from "@/components/plugin-tabs/plugin-tab-fixtures";
import { usePluginTabFeatureProjects } from "@/lib/plugin-tabs/feature-projects";
const mocks = vi.hoisted(() => ({
  plugins: vi.fn(),
  projectId: 3 as number | undefined,
  loading: false,
  selected: "plugin:example",
}));
vi.mock("@/api/generated", () => ({
  useGetWorkspaceSetting: (key: string) => ({
    data: { value: key === "editor_backend" ? mocks.selected : "0" },
  }),
  useGetFeature: () => ({
    data: mocks.projectId === undefined ? undefined : { project_id: mocks.projectId },
    isLoading: mocks.loading,
  }),
  usePluginTabList: mocks.plugins,
}));
vi.mock("@/lib/plugin-tabs/availability", () => ({ pluginTabsAvailable: () => true }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
import { useEditorBackend } from "./useEditorBackend";
const editor = linuxOnlyBackendTab({
  id: "example",
  backend_availability: "available",
  editor: { label: "Editor", open_method: "files.open" },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectId = 3;
  mocks.loading = false;
  mocks.selected = "plugin:example";
  usePluginTabFeatureProjects.setState({ projects: {} });
  mocks.plugins.mockImplementation((params?: { project_id: number }) => ({
    data: params?.project_id === 3 ? [editor] : [pluginTabSummary({ id: "example" })],
  }));
});
describe("project-scoped editor choice", () => {
  it("resolves project overrides for links before the editor has ever mounted", () => {
    const { result } = renderHook(() => useEditorBackend(7));
    expect(mocks.plugins).toHaveBeenCalledWith({ project_id: 3 }, expect.any(Object));
    expect(result.current.kind).toBe("plugin");
  });
  it("waits visibly rather than interpreting the global switch as the project's override", () => {
    mocks.projectId = undefined;
    mocks.loading = true;
    const { result } = renderHook(() => useEditorBackend(7));
    expect(result.current.kind).toBe("loading");
    expect(mocks.plugins).toHaveBeenCalledWith(undefined, {
      query: { enabled: false, staleTime: Infinity },
    });
  });
  it("uses an already known project without waiting for feature metadata", () => {
    mocks.projectId = undefined;
    mocks.loading = true;
    usePluginTabFeatureProjects.setState({ projects: { 7: 3 } });
    const { result } = renderHook(() => useEditorBackend(7));
    expect(result.current.kind).toBe("plugin");
  });
});
