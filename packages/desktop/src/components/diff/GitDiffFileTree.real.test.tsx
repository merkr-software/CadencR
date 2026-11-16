import { FileTree } from "@pierre/trees";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { ConflictKind, FileStageState, type ChangedFile } from "@/api/generated";
import type { GitFileIndexActions } from "./useGitFileIndexActions";
import { GitDiffFileTree } from "./GitDiffFileTree";
import { gitDiffTreeConflictDecoration } from "./useGitDiffFileTreeModel";

const file: ChangedFile = {
  file: "src/file.ts",
  status: "M",
  additions: 1,
  deletions: 0,
  stage_state: FileStageState.unstaged,
};

const indexActions: GitFileIndexActions = {
  stage: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  pendingAction: null,
  pendingPath: null,
  error: null,
};

function treeView(
  model: FileTree,
  files: readonly ChangedFile[],
  actions: GitFileIndexActions = indexActions,
  options: {
    displayMode?: "tree" | "filenames";
    expandedFiles?: ReadonlySet<string>;
    stageCheckboxesEnabled?: boolean;
  } = {},
): React.JSX.Element {
  return (
    <GitDiffFileTree
      model={model}
      files={files}
      expandedFiles={options.expandedFiles ?? new Set()}
      indexActions={actions}
      displayMode={options.displayMode ?? "tree"}
      isDisplayModePending={false}
      onDisplayModeChange={vi.fn()}
      resolveFilePath={(treePath) => treePath}
      onToggleExpand={vi.fn()}
      stageCheckboxesEnabled={options.stageCheckboxesEnabled}
    />
  );
}

describe("GitDiffFileTree with the real CadencrFileTree wrapper", () => {
  it("does not overlay the empty placeholder on a populated Pierre tree", () => {
    const model = new FileTree({ paths: ["src/", "src/file.ts"] });
    const { unmount } = render(
      treeView(model, [file], indexActions, { expandedFiles: new Set([file.file]) }),
    );

    expect(screen.getByText("1 changed file")).toBeInTheDocument();
    expect(screen.queryByText("No changed files")).not.toBeInTheDocument();
    expect(model.getItem(file.file)).not.toBeNull();
    unmount();
    model.cleanUp();
  });

  it("renders the loader and conflict icon without indent guides or state text", async () => {
    const conflictFile: ChangedFile = {
      ...file,
      file: "src/conflict.ts",
      stage_state: FileStageState.conflicted,
      conflict_kind: ConflictKind.uu,
    };
    const model = new FileTree({
      paths: ["src/", conflictFile.file],
      gitStatus: [{ path: conflictFile.file, status: "modified" }],
      initialExpansion: "open",
      renderRowDecoration: ({ item }) =>
        item.path === conflictFile.file ? gitDiffTreeConflictDecoration(conflictFile) : null,
    });
    const pendingStageActions: GitFileIndexActions = {
      ...indexActions,
      isPending: true,
      pendingAction: "stage",
      pendingPath: conflictFile.file,
    };
    const { rerender, unmount } = render(treeView(model, [conflictFile], pendingStageActions));
    const shadowRoot = model.getFileTreeContainer()?.shadowRoot;

    await waitFor(() =>
      expect(
        shadowRoot?.querySelector(
          `[data-cadencr-stage-loader][aria-label="Staging ${conflictFile.file}"]`,
        ),
      ).not.toBeNull(),
    );
    const row = shadowRoot?.querySelector(
      `[data-item-type="file"][data-item-path="${conflictFile.file}"]`,
    );
    expect(row?.querySelector(":scope > input[data-cadencr-stage-checkbox]")).toBeNull();
    expect(
      row?.querySelector(
        `[data-item-section="decoration"] > span[title="Conflict: both modified"]`,
      ),
    ).not.toBeNull();
    expect(row?.querySelector('[data-item-section="git"]')?.textContent).toBe("M");
    expect(row?.textContent).not.toMatch(/Staged|Unstaged|Viewed/);
    expect(shadowRoot?.querySelector("style[data-cadencr-git-diff-tree]")?.textContent).toContain(
      "border-inline-start-color: transparent",
    );

    rerender(
      treeView(model, [conflictFile], pendingStageActions, { stageCheckboxesEnabled: false }),
    );
    await waitFor(() =>
      expect(
        shadowRoot?.querySelector(`[data-cadencr-stage-loader], [data-cadencr-stage-checkbox]`),
      ).toBeNull(),
    );

    unmount();
    model.cleanUp();
  });

  it("stages a file whose name holds a newline by its real path", async () => {
    const odd: ChangedFile = { ...file, file: "a\nb.txt" };
    const treePath = '"a\\nb.txt"';
    const stage = vi.fn();
    const model = new FileTree({ paths: [treePath], initialExpansion: "open" });
    const { unmount } = render(
      <GitDiffFileTree
        model={model}
        files={[odd]}
        expandedFiles={new Set()}
        indexActions={{ ...indexActions, stage }}
        displayMode="tree"
        isDisplayModePending={false}
        onDisplayModeChange={vi.fn()}
        resolveFilePath={(path) => (path === treePath ? odd.file : null)}
        onToggleExpand={vi.fn()}
      />,
    );
    const shadowRoot = model.getFileTreeContainer()?.shadowRoot;
    // A CSS selector would read the backslash as an escape: match the label exactly instead.
    const checkbox = (): HTMLInputElement | undefined =>
      [
        ...(shadowRoot?.querySelectorAll<HTMLInputElement>("input[data-cadencr-stage-checkbox]") ??
          []),
      ].find((input) => input.getAttribute("aria-label") === `Stage ${treePath}`);
    await waitFor(() => expect(checkbox()).toBeDefined());

    act(() => checkbox()?.click());
    expect(stage).toHaveBeenCalledWith("a\nb.txt", { conflicted: false });
    unmount();
    model.cleanUp();
  });

  it("keeps the loader until stage and reset state changes are confirmed", async () => {
    const model = new FileTree({
      paths: ["src/", file.file],
      initialExpansion: "open",
    });
    const pendingStageActions: GitFileIndexActions = {
      ...indexActions,
      isPending: true,
      pendingAction: "stage",
      pendingPath: file.file,
    };
    const { rerender, unmount } = render(treeView(model, [file], pendingStageActions));
    const shadowRoot = model.getFileTreeContainer()?.shadowRoot;
    const stageLoader = `[data-cadencr-stage-loader][aria-label="Staging ${file.file}"]`;
    const resetLoader = `[data-cadencr-stage-loader][aria-label="Unstaging ${file.file}"]`;
    const checkbox = `input[data-cadencr-stage-checkbox][aria-label="Stage ${file.file}"]`;

    await waitFor(() => expect(shadowRoot?.querySelector(stageLoader)).not.toBeNull());
    rerender(treeView(model, [file]));
    await waitFor(() => expect(shadowRoot?.querySelector(stageLoader)).not.toBeNull());
    expect(shadowRoot?.querySelector(checkbox)).toBeNull();

    const stagedFile = { ...file, stage_state: FileStageState.staged };
    rerender(treeView(model, [stagedFile]));
    await waitFor(() => {
      expect(shadowRoot?.querySelector<HTMLInputElement>(checkbox)?.checked).toBe(true);
      expect(shadowRoot?.querySelector(`[data-cadencr-stage-loader]`)).toBeNull();
    });

    const pendingResetActions = { ...pendingStageActions, pendingAction: "reset" } as const;
    rerender(treeView(model, [stagedFile], pendingResetActions));
    await waitFor(() => expect(shadowRoot?.querySelector(resetLoader)).not.toBeNull());
    rerender(treeView(model, [stagedFile]));
    await waitFor(() => expect(shadowRoot?.querySelector(resetLoader)).not.toBeNull());
    expect(shadowRoot?.querySelector(checkbox)).toBeNull();

    rerender(treeView(model, [file]));
    await waitFor(() => {
      expect(shadowRoot?.querySelector<HTMLInputElement>(checkbox)?.checked).toBe(false);
      expect(shadowRoot?.querySelector(`[data-cadencr-stage-loader]`)).toBeNull();
    });

    unmount();
    model.cleanUp();
  });

  it("keeps stage checkboxes mounted while Pierre virtualizes rows during scroll", async () => {
    const files = Array.from({ length: 200 }, (_, index) => ({
      ...file,
      file: `file-${String(index).padStart(3, "0")}.ts`,
    }));
    const lastFile = files.at(-1)!;
    const model = new FileTree({
      paths: files.map((changedFile) => changedFile.file),
      filesOnly: true,
    });
    const { unmount } = render(treeView(model, files, indexActions, { displayMode: "filenames" }));
    const shadowRoot = model.getFileTreeContainer()?.shadowRoot;
    await waitFor(() =>
      expect(
        shadowRoot?.querySelector(
          'input[data-cadencr-stage-checkbox][aria-label="Stage file-000.ts"]',
        ),
      ).not.toBeNull(),
    );
    expect(shadowRoot?.querySelectorAll('[data-item-type="file"]').length).toBeLessThan(
      files.length,
    );

    act(() => model.scrollToPath(lastFile.file, { focus: true, offset: "top" }));
    await waitFor(() =>
      expect(
        shadowRoot?.querySelector(
          `input[data-cadencr-stage-checkbox][aria-label="Stage ${lastFile.file}"]`,
        ),
      ).not.toBeNull(),
    );

    unmount();
    model.cleanUp();
  });

  it("removes a recycled file checkbox when Pierre reuses the row for a folder", async () => {
    const nestedFiles = Array.from({ length: 200 }, (_, index) => ({
      ...file,
      file: `src/nested/file-${String(index).padStart(3, "0")}.ts`,
    }));
    const changedFolder = {
      ...file,
      file: "src/new-folder/",
      status: "A",
    };
    const files = [...nestedFiles, changedFolder];
    const model = new FileTree({
      paths: files.map((changedFile) => changedFile.file),
      initialExpansion: "open",
    });
    const { unmount } = render(treeView(model, files));
    const shadowRoot = model.getFileTreeContainer()?.shadowRoot;

    act(() => model.scrollToPath(changedFolder.file, { focus: true, offset: "top" }));
    await waitFor(() => {
      const folderRow = shadowRoot?.querySelector(
        `[data-item-type="folder"][data-item-path="${changedFolder.file}"]`,
      );
      expect(folderRow).not.toBeNull();
      expect(folderRow?.querySelector(":scope > input[data-cadencr-stage-checkbox]")).toBeNull();
    });

    unmount();
    model.cleanUp();
  });
});
