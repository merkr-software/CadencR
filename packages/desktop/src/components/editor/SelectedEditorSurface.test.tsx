import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { pluginTabSummary } from "@/components/plugin-tabs/plugin-tab-fixtures";
import { useEditorNavigationStore } from "@/lib/editors/editor-navigation-store";
import { SelectedEditorSurface } from "./SelectedEditorSurface";
vi.mock("./neovim/NeovimPane", () => ({
  default: ({ featureId }: { featureId: number }) => (
    <div data-testid="neovim-pane">{featureId}</div>
  ),
}));
vi.mock("@/api/generated", () => ({
  useListProjects: () => ({ data: [] }),
  useGetFeatureSettings: () => ({ data: [] }),
}));
vi.mock("@/hooks/useFeatureWorktreePath", () => ({
  useFeatureWorktreeInfo: () => ({ worktree: undefined, isResolved: true }),
}));
vi.mock("@/components/plugin-tabs/usePluginTabContext", () => ({
  usePluginTabContext: () => ({}),
}));
vi.mock("@/components/plugin-surfaces/PluginEditorSurface", () => ({
  PluginEditorSurface: ({ visible }: { visible: boolean }) => (
    <div data-testid="plugin-editor" data-visible={String(visible)} />
  ),
}));
const props = {
  featureId: 7,
  projectId: 1,
  projectPath: "/repo",
  visible: true,
  children: <div data-testid="codemirror" />,
};
beforeEach(() => useEditorNavigationStore.setState({ fallbacks: {} }));
describe("selected editor surface", () => {
  it("keeps CodeMirror as the standard editor", () => {
    render(<SelectedEditorSurface {...props} target={{ kind: "codemirror", id: "codemirror" }} />);
    expect(screen.getByTestId("codemirror")).toBeInTheDocument();
  });
  it("mounts one built-in Neovim surface outside CodeMirror splits", async () => {
    render(<SelectedEditorSurface {...props} target={{ kind: "neovim", id: "neovim" }} />);
    expect(await screen.findByTestId("neovim-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("codemirror")).not.toBeInTheDocument();
  });
  it("shows fallback explanations without a retry that cannot resolve static incompatibility", () => {
    render(
      <SelectedEditorSurface
        {...props}
        target={{ kind: "codemirror", id: "plugin:example", reason: "Unavailable on mobile" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Unavailable on mobile");
    expect(screen.queryByRole("button", { name: "Retry editor" })).not.toBeInTheDocument();
    expect(screen.getByTestId("codemirror")).toBeInTheDocument();
  });
  it("mounts a plugin with actual visibility rather than focus", () => {
    const plugin = pluginTabSummary({ editor: { label: "Editor", open_method: "files.open" } });
    const { rerender } = render(
      <SelectedEditorSurface {...props} target={{ kind: "plugin", id: "plugin:graph", plugin }} />,
    );
    expect(screen.getByTestId("plugin-editor")).toHaveAttribute("data-visible", "true");
    rerender(
      <SelectedEditorSurface
        {...props}
        visible={false}
        target={{ kind: "plugin", id: "plugin:graph", plugin }}
      />,
    );
    expect(screen.getByTestId("plugin-editor")).toHaveAttribute("data-visible", "false");
  });
  it("acknowledges setting/catalog loading visibly", () => {
    render(<SelectedEditorSurface {...props} target={{ kind: "loading", id: "plugin:graph" }} />);
    expect(screen.getByRole("status", { name: "Loading editor" })).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-editor")).not.toBeInTheDocument();
  });
});
