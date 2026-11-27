import { uiI18n } from "@/lib/i18n/ui";
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { FileTreeDirectoryHandle } from "@pierre/trees";
import { describe, expect, it, vi } from "vitest";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { CadencrFileTree } from "@/components/file-tree/CadencrFileTree";

vi.mock("@/hooks/useFileTreeIconSet", () => ({
  useFileTreeIconSet: () => ({ iconSet: "standard", setIconSet: vi.fn(), isLoading: false }),
}));

vi.mock("./useGitDiffTreeDisplaySetting", async () => {
  const React = await import("react");
  return {
    useGitDiffTreeDisplaySetting: () => {
      const [displayMode, setDisplayMode] = React.useState<"tree" | "filenames">("tree");
      return React.useMemo(
        () => ({ displayMode, setDisplayMode, isPending: false }),
        [displayMode],
      );
    },
  };
});

import { sortChangedFilesForDiff, useGitDiffFileTreeModel } from "./useGitDiffFileTreeModel";

function changedFile(file: string): ChangedFile {
  return {
    file,
    status: "M",
    additions: 1,
    deletions: 0,
    stage_state: FileStageState.unstaged,
  };
}

describe("useGitDiffFileTreeModel display mode", () => {
  it("shows open-thread counts only on rows in filenames mode", async () => {
    const files = [changedFile("src/nested/a.ts"), changedFile("src/nested/b.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({
        files,
        onSelectionChange: vi.fn(),
        reviewCountsByFile: new Map([["src/nested/a.ts", 2]]),
      }),
    );
    const tree = render(<CadencrFileTree model={result.current.model} />);
    const shadowRoot = result.current.model.getFileTreeContainer()?.shadowRoot;

    expect(shadowRoot?.textContent).not.toContain("2 open");
    act(() => result.current.setDisplayMode("filenames"));
    await waitFor(() => expect(shadowRoot?.textContent).toContain("2 open"));
    expect(shadowRoot?.querySelector('[data-item-type="folder"]')).toBeNull();

    tree.unmount();
    unmount();
  });

  it("updates stage state without resetting an unchanged path tree", () => {
    const initialFile = changedFile("src/file.ts");
    const { result, rerender, unmount } = renderHook(
      ({ currentFile }: { currentFile: ChangedFile }) =>
        useGitDiffFileTreeModel({
          files: [currentFile],
          onSelectionChange: vi.fn(),
        }),
      { initialProps: { currentFile: initialFile } },
    );
    const tree = render(<CadencrFileTree model={result.current.model} />);
    const shadowRoot = result.current.model.getFileTreeContainer()?.shadowRoot;
    expect(result.current.model.getItem("src/file.ts")).not.toBeNull();
    const resetPaths = vi.spyOn(result.current.model, "resetPaths");

    rerender({
      currentFile: {
        ...initialFile,
        stage_state: FileStageState.staged,
      },
    });

    expect(shadowRoot?.textContent).not.toMatch(/Staged|Unstaged/);
    expect(resetPaths).not.toHaveBeenCalled();
    tree.unmount();
    unmount();
  });

  it("preserves exact selection and deliberate directory collapse across modes", () => {
    const files = [changedFile("src/nested/a.ts"), changedFile("tests/a.ts")];
    const { result, rerender, unmount } = renderHook(
      ({ currentFiles }: { currentFiles: readonly ChangedFile[] }) =>
        useGitDiffFileTreeModel({
          files: currentFiles,
          onSelectionChange: vi.fn(),
        }),
      { initialProps: { currentFiles: files } },
    );

    act(() => {
      result.current.navigation.selectPath("src/nested/a.ts");
      const directory = result.current.model.getItem("src/") as FileTreeDirectoryHandle;
      directory.collapse();
    });
    expect((result.current.model.getItem("src/") as FileTreeDirectoryHandle).isExpanded()).toBe(
      false,
    );

    act(() => result.current.setDisplayMode("filenames"));
    const flatFocusedPath = result.current.model.getFocusedPath();
    expect(result.current.displayMode).toBe("filenames");
    expect(flatFocusedPath).toBe("src/nested/a.ts");
    expect(result.current.resolveFilePath(flatFocusedPath ?? "")).toBe("src/nested/a.ts");
    expect(result.current.activePath).toBe("src/nested/a.ts");
    expect(result.current.model.getVisiblePaths()).toEqual(["src/nested/a.ts", "tests/a.ts"]);

    rerender({ currentFiles: [...files, changedFile("new/fresh.ts")] });

    act(() => result.current.setDisplayMode("tree"));
    const restoredDirectory = result.current.model.getItem("src/") as FileTreeDirectoryHandle;
    const newDirectory = result.current.model.getItem("new/") as FileTreeDirectoryHandle;
    expect(result.current.activePath).toBe("src/nested/a.ts");
    expect(result.current.model.getFocusedPath()).toBe("src/nested/a.ts");
    expect(restoredDirectory.isExpanded()).toBe(false);
    expect(newDirectory.isExpanded()).toBe(true);

    unmount();
  });

  // Pierre sorts these rows by basename ("alpha.ts" before "zeta.ts"), while
  // the diff pane renders them by full path ("a/zeta.ts" first). Navigation
  // has to follow the diff, or `j` scrolls the pane upwards.
  it("moves through the diff pane's order, not Pierre's presentation order", () => {
    const files = [changedFile("a/zeta.ts"), changedFile("z/alpha.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({
        files,
        onSelectionChange: vi.fn(),
      }),
    );

    act(() => result.current.setDisplayMode("filenames"));
    act(() => result.current.navigation.selectPath("a/zeta.ts"));

    let movedPath: string | null = null;
    act(() => {
      movedPath = result.current.navigation.moveSelection(1);
    });

    expect(movedPath).toBe("z/alpha.ts");
    expect(result.current.model.getFocusedPath()).toBe("z/alpha.ts");
    expect(result.current.activePath).toBe("z/alpha.ts");

    act(() => {
      movedPath = result.current.navigation.moveSelection(-1);
    });
    expect(movedPath).toBe("a/zeta.ts");
    expect(result.current.model.getFocusedPath()).toBe("a/zeta.ts");
    expect(result.current.activePath).toBe("a/zeta.ts");
    unmount();
  });

  it("clamps at the ends of the diff instead of wrapping", () => {
    const files = [changedFile("a.ts"), changedFile("b.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({ files, onSelectionChange: vi.fn() }),
    );

    act(() => result.current.navigation.selectPath("a.ts"));
    let movedPath: string | null = null;
    act(() => {
      movedPath = result.current.navigation.moveSelection(-1);
    });

    // Still "handled" so the key never falls through to the tree's type-ahead
    // search, which is what used to hijack the next `j`/`k`.
    expect(movedPath).toBe("a.ts");
    expect(result.current.activePath).toBe("a.ts");
    unmount();
  });

  it("navigates a large virtualized list without projecting Pierre's rows", () => {
    const files = Array.from({ length: 2_000 }, (_, index) =>
      changedFile(`src/file-${String(index).padStart(4, "0")}.ts`),
    );
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({
        files,
        onSelectionChange: vi.fn(),
      }),
    );

    act(() => result.current.setDisplayMode("filenames"));
    expect(result.current.model.getFileTreeContainer()).toBeUndefined();
    const visiblePaths = result.current.model.getVisiblePaths();
    expect(visiblePaths).toHaveLength(2_000);
    (visiblePaths as string[]).pop();
    expect(result.current.model.getVisiblePaths()).toHaveLength(2_000);

    act(() => result.current.navigation.selectPath("src/file-0000.ts"));
    const getVisiblePaths = vi.spyOn(result.current.model, "getVisiblePaths");
    let movedPath: string | null = null;
    act(() => {
      movedPath = result.current.navigation.moveSelection(1);
    });

    // With no search query to scope the walk, moving never has to ask Pierre
    // to materialize its full row projection.
    expect(getVisiblePaths).not.toHaveBeenCalled();
    expect(movedPath).toBe("src/file-0001.ts");
    expect(result.current.model.getFileTreeContainer()).toBeUndefined();
    getVisiblePaths.mockRestore();
    unmount();
  });

  it("renders duplicate basenames as flat labels while preserving literal row identities", async () => {
    const files = [changedFile("src/index.ts"), changedFile("tests/index.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({
        files,
        onSelectionChange: vi.fn(),
      }),
    );
    act(() => result.current.setDisplayMode("filenames"));
    const tree = render(<CadencrFileTree model={result.current.model} />);
    const shadowRoot = result.current.model.getFileTreeContainer()?.shadowRoot;

    await waitFor(() =>
      expect(shadowRoot?.querySelectorAll('[data-item-type="file"]')).toHaveLength(2),
    );
    expect(shadowRoot?.querySelector('[data-item-path="src/index.ts"]')).toHaveAttribute(
      "aria-label",
      "index.ts",
    );
    expect(shadowRoot?.querySelector('[data-item-path="tests/index.ts"]')).toHaveAttribute(
      "aria-label",
      "index.ts",
    );
    expect(shadowRoot?.querySelector('[data-item-type="folder"]')).toBeNull();
    expect(result.current.resolveFilePath("src/index.ts")).toBe("src/index.ts");
    expect(result.current.resolveFilePath("index.ts")).toBeNull();

    tree.unmount();
    unmount();
  });

  it("skips hidden nonmatches after a retained Pierre search loses focus", () => {
    const files = [
      changedFile("src/alpha-match.ts"),
      changedFile("src/beta-hidden.ts"),
      changedFile("src/zeta-match.ts"),
    ];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({
        files,
        onSelectionChange: vi.fn(),
      }),
    );

    act(() => result.current.model.setSearch("match"));
    const tree = render(<CadencrFileTree model={result.current.model} />);
    const searchInput = result.current.model
      .getFileTreeContainer()
      ?.shadowRoot?.querySelector<HTMLInputElement>("[data-file-tree-search-input]");
    expect(searchInput).not.toBeNull();
    fireEvent.blur(searchInput as HTMLInputElement);
    expect(result.current.model.getSearchValue()).toBe("match");

    act(() => result.current.navigation.selectPath("src/alpha-match.ts"));
    let movedPath: string | null = null;
    act(() => {
      movedPath = result.current.navigation.moveSelection(1);
    });

    expect(movedPath).toBe("src/zeta-match.ts");
    expect(result.current.model.getFocusedPath()).toBe("src/zeta-match.ts");
    expect(result.current.activePath).toBe("src/zeta-match.ts");
    tree.unmount();
    unmount();
  });

  it("renders no rows and does not move selection after a retained zero-result search", async () => {
    const files = [changedFile("src/alpha.ts"), changedFile("src/beta.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({
        files,
        onSelectionChange: vi.fn(),
      }),
    );

    act(() => {
      result.current.navigation.selectPath("src/alpha.ts");
      result.current.model.setSearch("alpha");
    });
    const tree = render(<CadencrFileTree model={result.current.model} />);
    const shadowRoot = result.current.model.getFileTreeContainer()?.shadowRoot;
    const searchInput = shadowRoot?.querySelector<HTMLInputElement>(
      "[data-file-tree-search-input]",
    );
    expect(searchInput).not.toBeNull();
    expect(shadowRoot?.querySelector('[data-item-path="src/alpha.ts"]')).not.toBeNull();

    act(() => result.current.model.setSearch("no-results"));
    fireEvent.blur(searchInput as HTMLInputElement);
    expect(result.current.model.getSearchValue()).toBe("no-results");
    await waitFor(() => expect(shadowRoot?.querySelectorAll("[data-item-path]")).toHaveLength(0));

    const selectedBeforeMove = result.current.model.getSelectedPaths();
    const focusedBeforeMove = result.current.model.getFocusedPath();
    let movedPath: string | null = "unexpected";
    act(() => {
      movedPath = result.current.navigation.moveSelection(1);
    });

    expect(movedPath).toBeNull();
    expect(result.current.model.getSelectedPaths()).toEqual(selectedBeforeMove);
    expect(result.current.model.getFocusedPath()).toBe(focusedBeforeMove);
    tree.unmount();
    unmount();
  });

  it("reaches files hidden by a collapsed directory, opening the way", () => {
    const files = [changedFile("a/alpha.ts"), changedFile("b/beta.ts"), changedFile("root.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({
        files,
        onSelectionChange: vi.fn(),
      }),
    );

    act(() => {
      (result.current.model.getItem("b/") as FileTreeDirectoryHandle).collapse();
      result.current.navigation.selectPath("a/alpha.ts");
    });

    let movedPath: string | null = null;
    act(() => {
      movedPath = result.current.navigation.moveSelection(1);
    });

    // The file is in the diff, so `j` must land on it — a collapsed folder is
    // a view of the tree, not a filter on the changed-file set.
    expect(movedPath).toBe("b/beta.ts");
    expect((result.current.model.getItem("b/") as FileTreeDirectoryHandle).isExpanded()).toBe(true);
    expect(result.current.model.getSelectedPaths()).toEqual(["b/beta.ts"]);
    unmount();
  });

  it("announces the new selection before moveSelection returns", () => {
    // `useDiffNavigationAdapter` relies on this: it lets the selection listener
    // do the scrolling instead of scrolling again itself. If the notification
    // ever became async, the scan flag would be back to false by the time it
    // arrived and `j` would *open* files instead of scanning past them.
    const onSelectionChange = vi.fn();
    const files = [changedFile("a.ts"), changedFile("b.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({ files, onSelectionChange }),
    );

    act(() => result.current.navigation.selectPath("a.ts"));
    onSelectionChange.mockClear();

    let calledSynchronously = 0;
    let movedPath: string | null = null;
    act(() => {
      movedPath = result.current.navigation.moveSelection(1);
      calledSynchronously = onSelectionChange.mock.calls.length;
    });

    expect(movedPath).toBe("b.ts");
    expect(calledSynchronously).toBe(1);
    expect(onSelectionChange).toHaveBeenCalledWith("b.ts");
    unmount();
  });

  it("shows a name holding a newline escaped in the tree, and reports the real path", () => {
    const onSelectionChange = vi.fn();
    const files = [changedFile("a\nb.txt"), changedFile("dir\tx/c.ts"), changedFile("ok.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({ files, onSelectionChange }),
    );
    const tree = render(<CadencrFileTree model={result.current.model} />);
    const shadowRoot = result.current.model.getFileTreeContainer()?.shadowRoot;
    const names = [...(shadowRoot?.querySelectorAll("[data-item-path]") ?? [])].map((row) =>
      row.getAttribute("data-item-path"),
    );
    expect(names).toEqual(expect.arrayContaining(['"a\\nb.txt"', '"dir\\tx"/c.ts', "ok.ts"]));
    expect(result.current.resolveFilePath('"a\\nb.txt"')).toBe("a\nb.txt");
    expect(result.current.resolveFilePath("ok.ts")).toBe("ok.ts");

    act(() => {
      result.current.navigation.selectPath("a\nb.txt");
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith("a\nb.txt");
    expect(result.current.navigation.getActivePath()).toBe("a\nb.txt");
    tree.unmount();
    unmount();
  });

  it("walks escaped names in the diff pane's order", () => {
    const files = [changedFile("a\nb.txt"), changedFile("0.ts")];
    const { result, unmount } = renderHook(() =>
      useGitDiffFileTreeModel({ files, onSelectionChange: vi.fn() }),
    );
    // The diff pane sorts real paths: "0.ts" comes first.
    expect(sortChangedFilesForDiff(files).map((file) => file.file)).toEqual(["0.ts", "a\nb.txt"]);
    let next: string | null = null;
    act(() => {
      result.current.navigation.selectPath("0.ts");
      next = result.current.navigation.moveSelection(1);
    });
    expect(next).toBe("a\nb.txt");
    unmount();
  });

  it("sorts conflicted files ahead of other changes", () => {
    const ordered = sortChangedFilesForDiff([
      { ...changedFile("z.ts"), stage_state: FileStageState.unstaged },
      { ...changedFile("a.ts"), stage_state: FileStageState.conflicted },
      { ...changedFile("m.ts"), stage_state: FileStageState.staged },
      { ...changedFile("b.ts"), stage_state: FileStageState.conflicted },
    ]);
    expect(ordered.map((file) => file.file)).toEqual(["a.ts", "b.ts", "m.ts", "z.ts"]);
  });
});

it("repaints Git decorations on locale changes only when there is localized row text", async () => {
  const file = changedFile("src/a.ts");
  const files = [file];
  const conflicts = [{ ...file, stage_state: FileStageState.conflicted }];
  const onSelectionChange = vi.fn();
  const { result, rerender } = renderHook(
    ({ currentFiles }) => useGitDiffFileTreeModel({ files: currentFiles, onSelectionChange }),
    { initialProps: { currentFiles: files } },
  );
  const setGitStatus = vi.spyOn(result.current.model, "setGitStatus");
  try {
    await act(async () => {
      await uiI18n.changeLanguage("fr");
    });
    expect(setGitStatus).not.toHaveBeenCalled();

    rerender({ currentFiles: conflicts });
    setGitStatus.mockClear();
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
    expect(setGitStatus).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
  }
});
