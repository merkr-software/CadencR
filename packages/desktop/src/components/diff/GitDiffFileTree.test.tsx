import type { ContextMenuOpenContext, FileTree } from "@pierre/trees";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { ConflictKind, FileStageState, type ChangedFile } from "@/api/generated";
import type { GitFileIndexActions } from "./useGitFileIndexActions";

const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));

vi.mock("@/lib/clipboard", () => clipboard);

vi.mock("@/components/file-tree/CadencrFileTree", () => ({
  CadencrFileTree: ({ header }: { header?: React.ReactNode }) => (
    <div>
      {header}
      <button type="button" data-item-path="conflict.ts" data-item-type="file">
        conflict.ts
      </button>
    </div>
  ),
}));

import { countUniqueConflicts, GitDiffFileTree, GitDiffTreeContextMenu } from "./GitDiffFileTree";
import { buildGitDiffTreePaths, buildGitDiffTreeStatus } from "./useGitDiffFileTreeModel";

function changedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    file: "src/file.ts",
    status: "M",
    additions: 1,
    deletions: 0,
    stage_state: FileStageState.unstaged,
    ...overrides,
  };
}

function indexActions(overrides: Partial<GitFileIndexActions> = {}): GitFileIndexActions {
  return {
    stage: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    pendingAction: null,
    pendingPath: null,
    error: null,
    ...overrides,
  };
}

function menuContext(): ContextMenuOpenContext {
  return {
    anchorElement: document.body,
    anchorRect: { top: 0, right: 10, bottom: 10, left: 0, width: 10, height: 10, x: 0, y: 0 },
    close: vi.fn(),
    restoreFocus: vi.fn(),
  };
}

describe("Git diff Pierre inputs", () => {
  it("adds explicit ancestor directories for reset-safe expansion", () => {
    expect(buildGitDiffTreePaths([changedFile({ file: "src/nested/a.ts" })])).toEqual([
      "src/",
      "src/nested/",
      "src/nested/a.ts",
    ]);
  });

  it("maps typed conflict/untracked state onto Pierre statuses", () => {
    const statuses = buildGitDiffTreeStatus([
      changedFile({ file: "conflict.ts", stage_state: FileStageState.conflicted, status: "DD" }),
      changedFile({ file: "new.ts", stage_state: FileStageState.untracked, status: "A" }),
      changedFile({ file: "renamed.ts", stage_state: FileStageState.staged, status: "R100" }),
    ]);

    expect(statuses).toEqual([
      { path: "conflict.ts", status: "modified" },
      { path: "new.ts", status: "untracked" },
      { path: "renamed.ts", status: "renamed" },
    ]);
  });

  it("counts unique typed conflict rows", () => {
    expect(
      countUniqueConflicts([
        changedFile({ file: "a.ts", stage_state: FileStageState.conflicted }),
        changedFile({ file: "a.ts", stage_state: FileStageState.conflicted }),
        changedFile({ file: "b.ts", stage_state: FileStageState.unstaged }),
        changedFile({ file: "c.ts", stage_state: FileStageState.conflicted }),
      ]),
    ).toBe(2);
  });
});

describe("Git diff tree actions", () => {
  it("runs exact-path stage and non-destructive unstage actions", async () => {
    const actions = indexActions();
    const file = changedFile({ file: "src/both.ts", stage_state: FileStageState.both });
    clipboard.copyToClipboard.mockClear();
    const { user } = render(
      <GitDiffTreeContextMenu
        item={{ kind: "file", name: "both.ts", path: file.file }}
        context={menuContext()}
        file={file}
        expanded
        indexActions={actions}
        onToggleExpand={vi.fn()}
        onOpenFileInEditor={vi.fn()}
      />,
    );

    const stageItem = screen.getByRole("menuitem", { name: "Stage file" });
    const unstageItem = screen.getByRole("menuitem", {
      name: "Unstage file (keeps worktree changes)",
    });
    expect(stageItem.querySelector(".lucide-plus")).toBeInTheDocument();
    expect(unstageItem.querySelector(".lucide-minus")).toBeInTheDocument();
    await user.click(stageItem);
    await user.click(
      screen.getByRole("menuitem", { name: "Unstage file (keeps worktree changes)" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Copy path" }));

    expect(actions.stage).toHaveBeenCalledWith("src/both.ts", { conflicted: false });
    expect(actions.reset).toHaveBeenCalledWith("src/both.ts");
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith("src/both.ts", "Path copied");
  });

  it("keeps exact paths for filename-only rows", async () => {
    const actions = indexActions();
    const file = changedFile({ file: "src/deep/file.ts", stage_state: FileStageState.both });
    clipboard.copyToClipboard.mockClear();
    const { user } = render(
      <GitDiffTreeContextMenu
        item={{ kind: "file", name: "file.ts", path: "file--flat.ts" }}
        context={menuContext()}
        file={file}
        expanded
        indexActions={actions}
        onToggleExpand={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("menuitem", { name: "Stage file" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy path" }));

    expect(actions.stage).toHaveBeenCalledWith("src/deep/file.ts", { conflicted: false });
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith("src/deep/file.ts", "Path copied");
  });

  it("shows per-file pending state and disables concurrent mutations", () => {
    const file = changedFile({ file: "src/both.ts", stage_state: FileStageState.both });
    render(
      <GitDiffTreeContextMenu
        item={{ kind: "file", name: "both.ts", path: file.file }}
        context={menuContext()}
        file={file}
        expanded
        indexActions={indexActions({
          isPending: true,
          pendingAction: "stage",
          pendingPath: file.file,
        })}
        onToggleExpand={vi.fn()}
      />,
    );

    expect(screen.getByRole("menuitem", { name: "Staging…" })).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Unstage file (keeps worktree changes)" }),
    ).toBeDisabled();
  });

  it("explains delete-conflict Editor unavailability and allows staging the deletion", async () => {
    const actions = indexActions();
    const file = changedFile({
      file: "deleted.ts",
      status: "DD",
      stage_state: FileStageState.conflicted,
      conflict_kind: ConflictKind.dd,
    });
    const { user } = render(
      <GitDiffTreeContextMenu
        item={{ kind: "file", name: "deleted.ts", path: file.file }}
        context={menuContext()}
        file={file}
        expanded
        indexActions={actions}
        onToggleExpand={vi.fn()}
        onOpenFileInEditor={vi.fn()}
      />,
    );

    expect(screen.getByRole("menuitem", { name: "Open in Editor" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("both sides deleted");
    expect(
      screen.queryByRole("menuitem", { name: "Unstage file (keeps worktree changes)" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Stage deletion" }));
    expect(actions.stage).toHaveBeenCalledWith("deleted.ts", { conflicted: true });
  });

  it("keeps Stage and removes Unstage from an unresolved-conflict context menu", () => {
    const file = changedFile({
      file: "conflict.ts",
      status: "UU",
      stage_state: FileStageState.conflicted,
      conflict_kind: ConflictKind.uu,
    });
    render(
      <GitDiffTreeContextMenu
        item={{ kind: "file", name: file.file, path: file.file }}
        context={menuContext()}
        file={file}
        expanded
        indexActions={indexActions()}
        onToggleExpand={vi.fn()}
      />,
    );

    expect(screen.getByRole("menuitem", { name: "Stage file" })).toBeEnabled();
    expect(
      screen.queryByRole("menuitem", { name: "Unstage file (keeps worktree changes)" }),
    ).not.toBeInTheDocument();
  });
});

describe("Git conflict Editor handoff", () => {
  it("opens Pierre's built-in search from the stable tree header", async () => {
    const openSearch = vi.fn();
    const collapse = vi.fn();
    const model = { getFocusedPath: () => null, openSearch } as unknown as FileTree;
    const { user } = render(
      <GitDiffFileTree
        model={model}
        files={[changedFile({ file: "conflict.ts" })]}
        expandedFiles={new Set()}
        indexActions={indexActions()}
        displayMode="tree"
        isDisplayModePending={false}
        onDisplayModeChange={vi.fn()}
        resolveFilePath={(treePath) => treePath}
        onToggleExpand={vi.fn()}
        onCollapse={collapse}
      />,
    );

    const searchButton = screen.getByRole("button", { name: "Search changed files" });
    expect(searchButton.querySelector(".lucide-search")).toBeInTheDocument();
    fireEvent.pointerEnter(searchButton.parentElement!, { pointerType: "mouse" });
    expect(screen.getByText("Search changed files", { selector: "span" })).toBeInTheDocument();
    fireEvent.pointerLeave(searchButton.parentElement!, { pointerType: "mouse" });
    await user.click(searchButton);
    expect(openSearch).toHaveBeenCalledOnce();
    const collapseButton = screen.getByRole("button", { name: "Collapse Git file list" });
    expect(collapseButton.querySelector(".lucide-panel-left-close")).toBeInTheDocument();
    fireEvent.pointerEnter(collapseButton.parentElement!, { pointerType: "mouse" });
    expect(screen.getByText("Collapse changed-files sidebar")).toBeInTheDocument();
    await user.click(collapseButton);
    expect(collapse).toHaveBeenCalledOnce();
  });

  it("toggles between the directory tree and filenames-only list", async () => {
    const onDisplayModeChange = vi.fn();
    const model = { getFocusedPath: () => null, openSearch: vi.fn() } as unknown as FileTree;
    const { user, rerender } = render(
      <GitDiffFileTree
        model={model}
        files={[changedFile({ file: "conflict.ts" })]}
        expandedFiles={new Set()}
        indexActions={indexActions()}
        displayMode="tree"
        isDisplayModePending={false}
        onDisplayModeChange={onDisplayModeChange}
        resolveFilePath={(treePath) => treePath}
        onToggleExpand={vi.fn()}
      />,
    );

    const filenamesButton = screen.getByRole("button", { name: "Show filenames only" });
    fireEvent.pointerEnter(filenamesButton.parentElement!, { pointerType: "mouse" });
    expect(screen.getByText("Show filenames only — hide directory folders")).toBeInTheDocument();
    fireEvent.pointerLeave(filenamesButton.parentElement!, { pointerType: "mouse" });
    await user.click(filenamesButton);
    expect(onDisplayModeChange).toHaveBeenCalledWith("filenames");
    rerender(
      <GitDiffFileTree
        model={model}
        files={[changedFile({ file: "conflict.ts" })]}
        expandedFiles={new Set()}
        indexActions={indexActions()}
        displayMode="filenames"
        isDisplayModePending={false}
        onDisplayModeChange={onDisplayModeChange}
        resolveFilePath={(treePath) => treePath}
        onToggleExpand={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Show filenames only" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Show filenames only" }).querySelector(".lucide-files"),
    ).toBeInTheDocument();
  });

  it("shows and disables the filename-layout control while its global setting is pending", () => {
    const model = { getFocusedPath: () => null, openSearch: vi.fn() } as unknown as FileTree;
    render(
      <GitDiffFileTree
        model={model}
        files={[changedFile({ file: "conflict.ts" })]}
        expandedFiles={new Set()}
        indexActions={indexActions()}
        displayMode="tree"
        isDisplayModePending
        onDisplayModeChange={vi.fn()}
        resolveFilePath={(treePath) => treePath}
        onToggleExpand={vi.fn()}
      />,
    );

    const filenamesButton = screen.getByRole("button", { name: "Show filenames only" });
    expect(filenamesButton).toBeDisabled();
    expect(filenamesButton.querySelector(".lucide-loader-circle")).toHaveClass("animate-spin");
  });

  it("shows the aggregate conflict count with accessible copy", () => {
    const model = { getFocusedPath: () => null, openSearch: vi.fn() } as unknown as FileTree;
    render(
      <GitDiffFileTree
        model={model}
        files={[
          changedFile({
            file: "conflict.ts",
            stage_state: FileStageState.conflicted,
            conflict_kind: ConflictKind.uu,
          }),
        ]}
        expandedFiles={new Set()}
        indexActions={indexActions()}
        displayMode="tree"
        isDisplayModePending={false}
        onDisplayModeChange={vi.fn()}
        resolveFilePath={(treePath) => treePath}
        onToggleExpand={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("1 unresolved Git conflict")).toHaveTextContent("1");
  });

  it("opens a conflict through the existing Editor callback on row activation", async () => {
    const openInEditor = vi.fn();
    const file = changedFile({
      file: "conflict.ts",
      stage_state: FileStageState.conflicted,
      conflict_kind: ConflictKind.uu,
    });
    const model = {
      getFocusedPath: () => "conflict.ts",
      openSearch: vi.fn(),
    } as unknown as FileTree;
    const { user } = render(
      <GitDiffFileTree
        model={model}
        files={[file]}
        expandedFiles={new Set([file.file])}
        indexActions={indexActions()}
        displayMode="tree"
        isDisplayModePending={false}
        onDisplayModeChange={vi.fn()}
        resolveFilePath={(treePath) => treePath}
        onToggleExpand={vi.fn()}
        onOpenFileInEditor={openInEditor}
      />,
    );

    await user.dblClick(screen.getByRole("button", { name: "conflict.ts" }));
    expect(openInEditor).toHaveBeenCalledWith("conflict.ts");
  });

  it("does not hand a both-deleted conflict to Editor", async () => {
    const openInEditor = vi.fn();
    const file = changedFile({
      file: "conflict.ts",
      status: "DD",
      stage_state: FileStageState.conflicted,
      conflict_kind: ConflictKind.dd,
    });
    const model = {
      getFocusedPath: () => "conflict.ts",
      openSearch: vi.fn(),
    } as unknown as FileTree;
    const { user } = render(
      <GitDiffFileTree
        model={model}
        files={[file]}
        expandedFiles={new Set([file.file])}
        indexActions={indexActions()}
        displayMode="tree"
        isDisplayModePending={false}
        onDisplayModeChange={vi.fn()}
        resolveFilePath={(treePath) => treePath}
        onToggleExpand={vi.fn()}
        onOpenFileInEditor={openInEditor}
      />,
    );

    await user.dblClick(screen.getByRole("button", { name: "conflict.ts" }));
    expect(openInEditor).not.toHaveBeenCalled();
  });
});
