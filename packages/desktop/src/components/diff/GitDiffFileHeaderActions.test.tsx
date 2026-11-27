import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { ConflictKind, FileStageState, type ChangedFile } from "@/api/generated";
import type { GitFileIndexActions } from "./useGitFileIndexActions";
import { GitDiffFileActionError, GitDiffFileHeaderActions } from "./GitDiffFileHeaderActions";

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    file: "src/file.ts",
    status: "M",
    additions: 1,
    deletions: 0,
    stage_state: FileStageState.unstaged,
    ...overrides,
  };
}

function actions(overrides: Partial<GitFileIndexActions> = {}): GitFileIndexActions {
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

describe("GitDiffFileHeaderActions", () => {
  it("leaves conflict staging to the per-file banner", async () => {
    const indexActions = actions();
    const open = vi.fn();
    const conflict = file({
      stage_state: FileStageState.conflicted,
      conflict_kind: ConflictKind.uu,
    });
    const { user } = render(
      <GitDiffFileHeaderActions
        file={conflict}
        indexActions={indexActions}
        onOpenFileInEditor={open}
      />,
    );

    expect(screen.getByLabelText("Conflict: both modified")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Unstage src/file.ts; worktree content is preserved",
      }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open src/file.ts in editor" }));
    expect(screen.queryByRole("button", { name: "Stage src/file.ts" })).not.toBeInTheDocument();
    expect(open).toHaveBeenCalledOnce();
    expect(indexActions.stage).not.toHaveBeenCalled();
  });

  it("shows a spinner on only the pending file and disables mutation actions", () => {
    render(
      <GitDiffFileHeaderActions
        file={file({ stage_state: FileStageState.both })}
        indexActions={actions({
          isPending: true,
          pendingAction: "reset",
          pendingPath: "src/file.ts",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Stage src/file.ts" })).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Unstage src/file.ts; worktree content is preserved",
      }),
    ).toBeDisabled();
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("uses clear stage/unstage icons and explains each action on hover", () => {
    const { container } = render(
      <GitDiffFileHeaderActions
        file={file({ stage_state: FileStageState.both })}
        indexActions={actions()}
        onOpenFileInEditor={vi.fn()}
      />,
    );

    const stageButton = screen.getByRole("button", { name: "Stage src/file.ts" });
    const unstageButton = screen.getByRole("button", {
      name: "Unstage src/file.ts; worktree content is preserved",
    });
    expect(container.querySelector(".lucide-file-pen-line")).toBeInTheDocument();
    expect(stageButton.querySelector(".lucide-plus")).toBeInTheDocument();
    expect(unstageButton.querySelector(".lucide-minus")).toBeInTheDocument();

    fireEvent.pointerEnter(stageButton.parentElement!, { pointerType: "mouse" });
    expect(screen.getByText("Stage file — add it to the next commit")).toBeInTheDocument();
    fireEvent.pointerLeave(stageButton.parentElement!, { pointerType: "mouse" });
    fireEvent.pointerEnter(unstageButton.parentElement!, { pointerType: "mouse" });
    expect(screen.getByText("Unstage file — keeps worktree changes intact")).toBeInTheDocument();
  });

  it("disables Editor for both-deleted conflicts and leaves deletion staging to the banner", () => {
    render(
      <GitDiffFileHeaderActions
        file={file({
          status: "DD",
          stage_state: FileStageState.conflicted,
          conflict_kind: ConflictKind.dd,
        })}
        indexActions={actions()}
        onOpenFileInEditor={vi.fn()}
      />,
    );

    const unavailableEditor = screen.getByRole("button", {
      name: "Editor unavailable for deleted conflict src/file.ts",
    });
    expect(unavailableEditor).toBeDisabled();
    fireEvent.pointerEnter(unavailableEditor.parentElement!, { pointerType: "mouse" });
    expect(
      screen.getByText(
        "Editor unavailable: both sides deleted this file. Stage the deletion to resolve it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stage deletion src/file.ts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Unstage src/file.ts; worktree content is preserved",
      }),
    ).not.toBeInTheDocument();
  });

  it("renders the retained mutation error inline", () => {
    const changedFile = file();
    render(
      <GitDiffFileActionError
        file={changedFile}
        indexActions={actions({
          error: { action: "stage", filePath: changedFile.file, message: "index is locked" },
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Stage failed: index is locked");
  });

  it("leaves conflict mutation errors to the per-file banner", () => {
    const conflict = file({
      stage_state: FileStageState.conflicted,
      conflict_kind: ConflictKind.uu,
    });
    render(
      <GitDiffFileActionError
        file={conflict}
        indexActions={actions({
          error: { action: "stage", filePath: conflict.file, message: "index is locked" },
        })}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
