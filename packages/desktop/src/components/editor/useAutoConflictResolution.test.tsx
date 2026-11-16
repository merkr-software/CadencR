import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";

const mocks = vi.hoisted(() => ({
  changedFiles: { data: undefined as unknown, isError: false, error: null as unknown },
  useGetChangedFiles: vi.fn(),
  toastError: vi.fn(),
  gitPrefix: "" as string | null | undefined,
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/hooks/useGitPathPrefix", () => ({ useGitPathPrefix: () => mocks.gitPrefix }));
vi.mock("@/api/generated", () => ({
  FileStageState: { conflicted: "conflicted" },
  useGetChangedFiles: (params: unknown, options: unknown) => {
    mocks.useGetChangedFiles(params, options);
    return mocks.changedFiles;
  },
}));

import {
  ConfirmedConflictPathsProvider,
  useActiveConflict,
  useConfirmedConflictPaths,
} from "./useAutoConflictResolution";

function ActiveConflict({ filePath, dirty }: { filePath: string; dirty: boolean }) {
  const conflict = useActiveConflict(filePath, dirty);
  return <output data-testid={filePath}>{conflict ? filePath : "ordinary"}</output>;
}

function Harness({ filePath, dirty = false }: { filePath: string; dirty?: boolean }) {
  const conflicts = useConfirmedConflictPaths(3);
  return (
    <ConfirmedConflictPathsProvider conflicts={conflicts}>
      <ActiveConflict filePath={filePath} dirty={dirty} />
      <ActiveConflict filePath="other.ts" dirty={false} />
    </ConfirmedConflictPathsProvider>
  );
}

beforeEach(() => {
  mocks.changedFiles.data = undefined;
  mocks.changedFiles.isError = false;
  mocks.changedFiles.error = null;
  mocks.useGetChangedFiles.mockReset();
  mocks.toastError.mockReset();
  mocks.gitPrefix = "";
});

describe("confirmed conflict paths", () => {
  it("uses one changed-files source for multiple active-path consumers", () => {
    mocks.changedFiles.data = [
      { file: "a.ts", status: "UU", stage_state: "conflicted", conflict_kind: "uu" },
      { file: "other.ts", status: "M", stage_state: "unstaged" },
    ];
    render(<Harness filePath="a.ts" />);

    expect(screen.getByTestId("a.ts")).toHaveTextContent("a.ts");
    expect(screen.getByTestId("other.ts")).toHaveTextContent("ordinary");
    expect(mocks.useGetChangedFiles).toHaveBeenCalledTimes(1);
    expect(mocks.useGetChangedFiles.mock.calls[0]?.[0]).toEqual({
      feature_id: 3,
      mode: "worktree",
    });
  });

  it("keys a monorepo subdirectory's conflicts by their editor path", () => {
    mocks.gitPrefix = "packages/app";
    mocks.changedFiles.data = [
      { file: "packages/app/a.ts", status: "UU", stage_state: "conflicted", conflict_kind: "uu" },
      { file: "other.ts", status: "UU", stage_state: "conflicted", conflict_kind: "uu" },
    ];
    render(<Harness filePath="a.ts" />);

    expect(screen.getByTestId("a.ts")).toHaveTextContent("a.ts");
    // `other.ts` is the repository root's, outside this editor.
    expect(screen.getByTestId("other.ts")).toHaveTextContent("ordinary");
  });

  it("waits for the Git prefix before matching any path", () => {
    mocks.gitPrefix = undefined;
    mocks.changedFiles.data = [
      { file: "a.ts", status: "UU", stage_state: "conflicted", conflict_kind: "uu" },
    ];
    render(<Harness filePath="a.ts" />);
    expect(screen.getByTestId("a.ts")).toHaveTextContent("ordinary");
  });

  it("matches unusual literal paths exactly", () => {
    const literalPath = "odd:0|[conflict] -> name\npart.ts";
    mocks.changedFiles.data = [
      { file: literalPath, status: "UU", stage_state: "conflicted", conflict_kind: "uu" },
    ];
    const view = render(<Harness filePath={literalPath} />);
    expect(view.container.querySelector("output")?.textContent).toBe(literalPath);
  });

  it("exits on watcher confirmation unless a dirty Result still needs protection", () => {
    mocks.changedFiles.data = [
      { file: "a.ts", status: "UU", stage_state: "conflicted", conflict_kind: "uu" },
    ];
    const view = render(<Harness filePath="a.ts" />);
    expect(screen.getByTestId("a.ts")).toHaveTextContent("a.ts");

    view.rerender(<Harness filePath="a.ts" dirty />);
    mocks.changedFiles.data = [];
    view.rerender(<Harness filePath="a.ts" dirty />);
    expect(screen.getByTestId("a.ts")).toHaveTextContent("a.ts");

    view.rerender(<Harness filePath="a.ts" dirty={false} />);
    expect(screen.getByTestId("a.ts")).toHaveTextContent("ordinary");
  });

  it("retains a dirty exact-path Result across an A to B to A tab switch", () => {
    mocks.changedFiles.data = [
      { file: "a.ts", status: "UU", stage_state: "conflicted", conflict_kind: "uu" },
    ];
    const view = render(<Harness filePath="a.ts" dirty />);
    expect(screen.getByTestId("a.ts")).toHaveTextContent("a.ts");

    mocks.changedFiles.data = [];
    view.rerender(<Harness filePath="a.ts" dirty />);
    expect(screen.getByTestId("a.ts")).toHaveTextContent("a.ts");

    view.rerender(<Harness filePath="b.ts" />);
    expect(screen.getByTestId("b.ts")).toHaveTextContent("ordinary");

    view.rerender(<Harness filePath="a.ts" dirty />);
    expect(screen.getByTestId("a.ts")).toHaveTextContent("a.ts");

    view.rerender(<Harness filePath="a.ts" dirty={false} />);
    expect(screen.getByTestId("a.ts")).toHaveTextContent("ordinary");
  });

  it("surfaces conflict-detection failures", () => {
    mocks.changedFiles.isError = true;
    mocks.changedFiles.error = new Error("status failed");
    render(<Harness filePath="a.ts" />);
    expect(mocks.toastError).toHaveBeenCalledWith("Could not detect Git conflicts", {
      description: "status failed",
    });
  });
});
