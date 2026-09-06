import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRef, useEffect, type ReactNode } from "react";
import { render, screen } from "@/test-utils";
import { waitFor } from "@testing-library/react";
import FeatureEditorTab from "../FeatureEditorTab";

const mockUseFileWatcher = vi.fn();
const mockUseScopedShortcut = vi.fn();
const mockUseScopedGlobalShortcutById = vi.fn();
const mockSplitEditorPane = vi.fn();
const mockNavigatePane = vi.fn();
const mockInitFeature = vi.fn();
const mockEditorFocus = vi.fn();
const mockEditorUnmount = vi.fn();
let mockRegisterEditorView = true;
const mockToggleSidebar = vi.fn();
const mockPersistCollapsed = vi.fn();
let mockSidebarVisible = false;
const mockUseDebouncedSetting = vi.fn<
  (
    key: string,
    debounceMs?: number,
  ) => {
    value: string | null;
    setValue: typeof mockPersistCollapsed;
  }
>(() => ({ value: null, setValue: mockPersistCollapsed }));

vi.mock("@/hooks/useShortcut", () => ({
  useScopedShortcut: (...args: unknown[]) => mockUseScopedShortcut(...args),
  useScopedGlobalShortcutById: (...args: unknown[]) => mockUseScopedGlobalShortcutById(...args),
}));

vi.mock("@/hooks/useFileWatcher", () => ({
  useFileWatcher: (projectId: number, featureId?: number) =>
    mockUseFileWatcher(projectId, featureId),
}));

vi.mock("@/hooks/useFeatureWorktreePath", () => ({
  useFeatureWorktreePath: () => null,
}));

vi.mock("@/stores/feature-layout-store", () => ({
  // Test always considers the editor focused — exercises hotkeys and focus restore.
  useFeatureLayoutStore: vi.fn(() => true),
  selectFeatureLayout: () => () => ({}),
  getFocusedTab: () => "editor",
}));

vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: (key: string, debounceMs?: number) =>
    mockUseDebouncedSetting(key, debounceMs),
}));

vi.mock("@/hooks/useEditorState", () => ({
  useEditorState: vi.fn(() => ({
    initFeature: mockInitFeature,
    splitTree: { id: "root" },
    activePaneId: "pane-1",
    sidebarVisible: mockSidebarVisible,
    toggleSidebar: mockToggleSidebar,
    panes: {
      "pane-1": {
        tabs: [],
      },
    },
  })),
}));

vi.mock("@/stores/editor-store", () => ({
  useEditorStore: vi.fn(
    (
      selector: (state: {
        splitEditorPane: typeof mockSplitEditorPane;
        navigatePane: typeof mockNavigatePane;
      }) => unknown,
    ) => selector({ splitEditorPane: mockSplitEditorPane, navigatePane: mockNavigatePane }),
  ),
}));

// Auto conflict-resolution has its own unit test and needs the real store +
// changed-files query; keep it out of this layout-focused suite.
vi.mock("../useAutoConflictResolution", () => ({
  useConfirmedConflictPaths: () => ({ byPath: new Map() }),
  ConfirmedConflictPathsProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../FileTree", () => ({
  default: () => <div data-testid="file-tree" />,
}));

vi.mock("../EditorSplitTree", () => ({
  default: ({
    onEditorViewChange,
  }: {
    onEditorViewChange?: (paneId: string, view: { focus: () => void } | null) => void;
  }) => {
    useEffect(() => {
      if (!mockRegisterEditorView) return;
      onEditorViewChange?.("pane-1", { focus: mockEditorFocus });
      return () => {
        mockEditorUnmount();
        onEditorViewChange?.("pane-1", null);
      };
    }, [onEditorViewChange]);
    return <div data-testid="editor-split-tree" />;
  },
}));

vi.mock("../FileSearchDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="file-search-dialog" /> : null,
}));

vi.mock("../ContentSearchDialog", () => ({
  default: () => null,
}));

vi.mock("../editorSaveRegistry", () => ({
  saveAll: vi.fn(),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

describe("FeatureEditorTab", () => {
  beforeEach(() => {
    mockUseFileWatcher.mockReset();
    mockUseScopedShortcut.mockReset();
    mockUseScopedGlobalShortcutById.mockReset();
    mockSplitEditorPane.mockReset();
    mockNavigatePane.mockReset();
    mockInitFeature.mockReset();
    mockEditorFocus.mockReset();
    mockEditorUnmount.mockReset();
    mockRegisterEditorView = true;
    mockToggleSidebar.mockReset();
    mockPersistCollapsed.mockReset();
    mockSidebarVisible = false;
    mockUseDebouncedSetting.mockReset();
    mockUseDebouncedSetting.mockReturnValue({ value: null, setValue: mockPersistCollapsed });
  });

  it("subscribes to file changes even when the file tree sidebar is hidden", () => {
    render(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />);

    expect(mockUseFileWatcher).toHaveBeenCalledWith(1, 1);
    // The file tree stays mounted (so the pierre model survives a
    // collapse / expand cycle) but is hidden via CSS when the sidebar
    // is collapsed. `ResizableSidebarLayout` wraps the sidebar slot in
    // a div with the `hidden` Tailwind class (display: none).
    const fileTree = screen.queryByTestId("file-tree");
    expect(fileTree).toBeInTheDocument();
    expect(fileTree?.closest(".hidden")).not.toBeNull();
    expect(screen.getByTestId("editor-split-tree")).toBeInTheDocument();
  });

  it("uses a workspace-level collapse setting", () => {
    render(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />);

    expect(mockUseDebouncedSetting).toHaveBeenCalledWith("editor_sidebar_collapsed", 0);
  });

  it("reserves a rail for the expand button when the sidebar is collapsed", () => {
    render(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />);

    const expandButton = screen.getByRole("button", { name: "Show file tree sidebar" });
    // The rail wraps the (tooltip-wrapped) expand button; find it by class
    // since the tooltip adds an intermediate `relative inline-flex` wrapper.
    expect(expandButton.closest(".w-full")).not.toBeNull();
    expect(screen.getByTestId("editor-split-tree")).toBeInTheDocument();
  });

  it("shows a shortcut tooltip on hover over the collapsed-rail expand button", async () => {
    const { user } = render(
      <FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />,
    );

    const expandButton = screen.getByRole("button", { name: "Show file tree sidebar" });
    await user.hover(expandButton);

    expect(await screen.findByText("Show sidebar")).toBeInTheDocument();
  });

  it("persists the collapsed state when expanding from the rail", async () => {
    const { user } = render(
      <FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />,
    );

    await user.click(screen.getByRole("button", { name: "Show file tree sidebar" }));

    expect(mockToggleSidebar).toHaveBeenCalled();
    expect(mockPersistCollapsed).toHaveBeenCalledWith("false");
  });

  it("restores DOM focus to the active editor when the editor tab owns feature focus", async () => {
    render(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />);

    await waitFor(() => expect(mockEditorFocus).toHaveBeenCalled());
  });

  it("focuses the Neovim renderer input when no CodeMirror view is registered", async () => {
    mockRegisterEditorView = false;
    const input = document.createElement("textarea");
    const host = document.createElement("div");
    host.dataset.neovimFeatureId = "1";
    host.append(input);
    document.body.append(host);
    const ref = createRef<import("../FeatureEditorTab").FeatureEditorTabHandle>();

    render(<FeatureEditorTab ref={ref} featureId={1} projectId={1} projectPath="/project" />);
    ref.current?.focusActiveEditor();

    expect(document.activeElement).toBe(input);
    host.remove();
  });

  it("keeps the editor split tree mounted when the sidebar visibility changes", () => {
    mockSidebarVisible = true;
    const { rerender } = render(
      <FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />,
    );

    expect(screen.getByTestId("file-tree")).toBeInTheDocument();

    mockSidebarVisible = false;
    rerender(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project-next" />);

    expect(screen.getByRole("button", { name: "Show file tree sidebar" })).toBeInTheDocument();
    expect(screen.getByTestId("editor-split-tree")).toBeInTheDocument();
    expect(mockEditorUnmount).not.toHaveBeenCalled();
  });

  it("renders a file-search trigger in the sidebar header", () => {
    mockSidebarVisible = true;

    render(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />);

    expect(screen.getByRole("button", { name: /search files/i })).toBeInTheDocument();
    expect(screen.queryByTestId("file-search-dialog")).not.toBeInTheDocument();
  });

  it("opens the file search dialog when the header trigger is clicked", async () => {
    mockSidebarVisible = true;

    const { user } = render(
      <FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />,
    );

    await user.click(screen.getByRole("button", { name: /search files/i }));

    expect(screen.getByTestId("file-search-dialog")).toBeInTheDocument();
  });

  it("keeps the visible sidebar resizable", () => {
    mockSidebarVisible = true;

    render(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />);

    expect(screen.getByRole("separator", { name: "Resize file tree sidebar" })).toBeVisible();
  });

  it("binds the sidebar toggle shortcut through the capture-phase shortcut path", () => {
    render(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />);

    expect(mockUseScopedGlobalShortcutById).toHaveBeenCalledWith(
      "editor-toggle-sidebar",
      expect.any(Function),
      "editor",
      expect.objectContaining({ enabled: true }),
    );
  });

  it("ignores repeat events for the sidebar toggle shortcut", () => {
    render(<FeatureEditorTab featureId={1} projectId={1} projectPath="/project" />);
    const shortcutCall = mockUseScopedGlobalShortcutById.mock.calls.find(
      ([id]) => id === "editor-toggle-sidebar",
    );
    expect(shortcutCall).toBeDefined();
    const callback = shortcutCall?.[1] as (event: KeyboardEvent) => void;

    callback(new KeyboardEvent("keydown", { repeat: true }));
    expect(mockToggleSidebar).not.toHaveBeenCalled();

    callback(new KeyboardEvent("keydown"));
    expect(mockToggleSidebar).toHaveBeenCalledOnce();
  });
});
