import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, within } from "@/test-utils";
import type { ReactElement, ReactNode } from "react";
import type { FileDiffSection } from "@/lib/parse-unified-diff";

const singleFileDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+line2
`;

const fooFile = {
  file: "src/foo.ts",
  status: "M",
  additions: 1,
  deletions: 1,
  is_staged: false,
  stage_state: "unstaged" as const,
};

const fooSection: FileDiffSection = {
  oldFileName: "src/foo.ts",
  newFileName: "src/foo.ts",
  hunks: [singleFileDiff],
};

const mocks = vi.hoisted(() => {
  const scrollFileToTopMock = vi.fn(() => vi.fn());
  const useGetChangedFilesMock = vi.fn(
    () =>
      ({ data: [] as unknown[], isLoading: false }) as {
        data: unknown[];
        isLoading: boolean;
        isError?: boolean;
        error?: unknown;
      },
  );
  const useMutationMock = vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn() }));
  const stageMutate = vi.fn();
  const resetMutate = vi.fn();
  const markViewedMutate = vi.fn();
  const unmarkViewedMutate = vi.fn();
  const useMarkViewedMock = vi.fn(() => ({ mutate: markViewedMutate, isPending: false }));
  const useUnmarkViewedMock = vi.fn(() => ({ mutate: unmarkViewedMutate, isPending: false }));
  const useGetFileContentMock = vi.fn(() => ({ data: undefined }));
  const useGetFileBlobShasMock = vi.fn<() => { data: unknown[] }>(() => ({ data: [] }));
  const useListDiffViewedMock = vi.fn<() => { data: unknown[] }>(() => ({ data: [] }));
  // Stands in for the lazy per-file diff fetch. Returns the section only when
  // the row is enabled (expanded + on screen), mirroring the real hook.
  const useFileDiffSectionMock = vi.fn(({ enabled }: { enabled: boolean }) => ({
    section: enabled ? fooSection : null,
    isLoading: false,
    errorMessage: null,
  }));
  const patchDiffViewMock = vi.fn(({ patch }: { patch: string }) => (
    <div data-testid="patch-diff-view" data-patch={patch}>
      PatchDiffView
    </div>
  ));
  const persistFileListCollapsedMock = vi.fn();
  const persistTreeDisplayModeMock = vi.fn();
  const useTreeDisplaySettingMock = vi.fn(() => ({
    displayMode: "tree" as const,
    setDisplayMode: persistTreeDisplayModeMock,
    isPending: false,
  }));
  const shortcutCallbacks = new Map<string, (event: KeyboardEvent) => void>();
  const toastInfo = vi.fn();
  const useSettingMock = vi.fn<
    (key: string) => {
      value: string | null;
      setValue: typeof persistFileListCollapsedMock;
      isLoading?: boolean;
      isSaving?: boolean;
    }
  >(() => ({
    value: null as string | null,
    setValue: persistFileListCollapsedMock,
  }));
  return {
    useGetChangedFilesMock,
    useMutationMock,
    stageMutate,
    resetMutate,
    markViewedMutate,
    unmarkViewedMutate,
    useMarkViewedMock,
    useUnmarkViewedMock,
    useGetFileContentMock,
    useGetFileBlobShasMock,
    useListDiffViewedMock,
    useFileDiffSectionMock,
    patchDiffViewMock,
    persistFileListCollapsedMock,
    persistTreeDisplayModeMock,
    useTreeDisplaySettingMock,
    useSettingMock,
    shortcutCallbacks,
    toastInfo,
    scrollFileToTopMock,
    stageSettled: { current: null as (() => void) | null },
  };
});

vi.mock("./scroll-to-file", () => ({
  scrollFileToTop: mocks.scrollFileToTopMock,
}));

vi.mock("sonner", () => ({
  toast: { info: mocks.toastInfo, success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useShortcut", () => ({
  useScopedGlobalShortcutById: (id: string, callback: (event: KeyboardEvent) => void): void => {
    mocks.shortcutCallbacks.set(id, callback);
  },
}));

// A project at its repository root: Git paths are editor paths.
vi.mock("@/hooks/useGitPathPrefix", () => ({ useGitPathPrefix: () => "" }));
vi.mock("@/api/generated", () => ({
  FileStageState: {
    not_applicable: "not_applicable",
    untracked: "untracked",
    unstaged: "unstaged",
    staged: "staged",
    both: "both",
    conflicted: "conflicted",
  },
  ConflictKind: { dd: "dd", au: "au", ud: "ud", ua: "ua", du: "du", aa: "aa", uu: "uu" },
  useGetChangedFiles: mocks.useGetChangedFilesMock,
  useGetFileBlobShas: mocks.useGetFileBlobShasMock,
  useGetFileContent: mocks.useGetFileContentMock,
  // Orval emits a mutation hook for batch endpoints — mirror the mutation
  // shape so call sites that read `.mutate` and `.data` don't blow up.
  useGetFileContentBatch: mocks.useMutationMock,
  getGetFileContentQueryKey: vi.fn(() => ["git", "file-content"]),
  getListDiffViewedQueryKey: vi.fn((id?: number) => ["/api/features", id, "diff-viewed"]),
  getListDiffCommentsQueryKey: vi.fn((id?: number) => ["/api/features", id, "diff-comments"]),
  useListDiffViewed: mocks.useListDiffViewedMock,
  useMarkDiffViewed: mocks.useMarkViewedMock,
  useUnmarkDiffViewed: mocks.useUnmarkViewedMock,
  useListDiffComments: vi.fn(() => ({ data: [] })),
  useCreateDiffComment: mocks.useMutationMock,
  useUpdateDiffComment: mocks.useMutationMock,
  useDeleteDiffComment: mocks.useMutationMock,
  useStageFile: (options: { mutation?: { onSettled?: () => void } }) => {
    mocks.stageSettled.current = options.mutation?.onSettled ?? null;
    return { mutate: mocks.stageMutate };
  },
  useResetFile: () => ({ mutate: mocks.resetMutate }),
}));

vi.mock("./useFileDiffSection", () => ({
  useFileDiffSection: mocks.useFileDiffSectionMock,
}));

// Treat every row as on-screen so lazy per-file diffs load in tests.
vi.mock("@/hooks/useInViewport", () => ({
  useInViewport: () => ({ setRef: () => {}, inView: true }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: vi.fn(() => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() })),
  };
});

vi.mock("@/hooks/useSetting", () => ({
  useSetting: (key: string) => mocks.useSettingMock(key),
}));

vi.mock("./useGitDiffTreeDisplaySetting", () => ({
  useGitDiffTreeDisplaySetting: mocks.useTreeDisplaySettingMock,
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ theme: { id: "dracula", appearance: "dark" } }),
}));

vi.mock("./PatchDiffView", () => ({
  PatchDiffView: (props: Parameters<typeof mocks.patchDiffViewMock>[0]) =>
    mocks.patchDiffViewMock(props),
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));

// Virtuoso measures nothing in happy-dom: render every row, and record the
// scroll position the list is restored to.
const virtuoso = vi.hoisted(() => ({
  initialScrollTop: [] as (number | undefined)[],
  initialTopMostItemIndex: [] as unknown[],
  scroller: { scrollTop: 0 } as { scrollTop: number },
}));
vi.mock("react-virtuoso", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Virtuoso: <T, C>({
    data,
    context,
    itemContent,
    initialScrollTop,
    initialTopMostItemIndex,
    scrollerRef,
  }: {
    data: T[];
    context: C;
    itemContent: (index: number, item: T, context: C) => ReactNode;
    initialScrollTop?: number;
    initialTopMostItemIndex?: unknown;
    scrollerRef?: (element: HTMLElement | null) => void;
  }): ReactElement => {
    virtuoso.initialScrollTop.push(initialScrollTop);
    virtuoso.initialTopMostItemIndex.push(initialTopMostItemIndex);
    return (
      <div
        data-testid="virtuoso"
        ref={(element) => {
          if (!element) return scrollerRef?.(null);
          Object.defineProperty(element, "scrollTop", {
            configurable: true,
            get: () => virtuoso.scroller.scrollTop,
          });
          scrollerRef?.(element);
        }}
      >
        {data.map((item, index) => (
          <div key={index}>{itemContent(index, item, context)}</div>
        ))}
      </div>
    );
  },
}));

const runShortcutActionOutcome = vi.hoisted(() => vi.fn(() => "handled" as const));
vi.mock("@/lib/command-palette/shortcut-actions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runShortcutActionOutcome,
}));

import { DiffViewer } from "./DiffViewer";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import type { GitStatusSnapshot } from "@/api/generated";
import type { ReviewNavigationTarget } from "@/lib/pr-review-threads";
import type { GitNavigationAdapter } from "./gitNavigation";

const barFile = { ...fooFile, file: "src/bar.ts", additions: 3, deletions: 0 };
const stagedFile = {
  ...fooFile,
  file: "lib/zed.ts",
  stage_state: "staged" as const,
  is_staged: true,
};

function withFiles(files: unknown[]): void {
  mocks.useGetChangedFilesMock.mockReturnValue({ data: files, isLoading: false });
}

function setUncommitted(featureId: number, count: number): void {
  const snapshot = {
    feature_id: featureId,
    current_branch: "feature/x",
    target_branch: "main",
    uncommitted_count: count,
    staged_count: 0,
    unstaged_count: count,
    untracked_count: 0,
    ahead_of_remote: 0,
    behind_remote: 0,
    ahead_of_target: 0,
    behind_target: 0,
    target_resolved: true,
    conflict_count: 0,
    operation: null,
    has_remote: false,
    compare_url: null,
    action_label: "Commit",
    computed_at: 1,
  } as GitStatusSnapshot;
  useGitStatusStore.getState().setStatus(snapshot);
}

beforeEach(() => {
  mocks.useGetChangedFilesMock.mockReset();
  mocks.useSettingMock.mockReset();
  mocks.useSettingMock.mockReturnValue({ value: "split", setValue: vi.fn() });
  mocks.useListDiffViewedMock.mockReturnValue({ data: [] });
  mocks.useGetFileBlobShasMock.mockReturnValue({ data: [] });
  mocks.useMarkViewedMock.mockReturnValue({ mutate: mocks.markViewedMutate, isPending: false });
  mocks.useUnmarkViewedMock.mockReturnValue({ mutate: mocks.unmarkViewedMutate, isPending: false });
  mocks.stageMutate.mockReset();
  mocks.resetMutate.mockReset();
  mocks.patchDiffViewMock.mockClear();
  runShortcutActionOutcome.mockClear();
  virtuoso.initialScrollTop.length = 0;
  virtuoso.initialTopMostItemIndex.length = 0;
  virtuoso.scroller.scrollTop = 0;
  useGitStatusStore.setState({ byFeature: {}, healthByFeature: {}, watcherEpoch: {} });
});

afterEach(() => vi.clearAllMocks());

const rowButton = (path: string) => screen.getByRole("button", { name: `Open ${path}` });

describe("DiffViewer on the phone layout", () => {
  it("lists every changed file full width, with no tree, no Split and no file header", () => {
    withFiles([fooFile, barFile]);
    render(<DiffViewer featureId={1} mode="uncommitted" />);

    expect(rowButton("src/bar.ts")).toBeInTheDocument();
    expect(rowButton("src/foo.ts")).toBeInTheDocument();
    expect(screen.getByText("2 changed files")).toBeInTheDocument();
    expect(screen.getByText("0/2 viewed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split" })).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Diff display" })).not.toBeInTheDocument();
    // No per-file diff is fetched while the list is on screen.
    expect(mocks.useFileDiffSectionMock).not.toHaveBeenCalled();
  });

  it("opens a file's diff full width, unified even when Split is the setting", async () => {
    withFiles([fooFile, barFile]);
    const { user } = render(<DiffViewer featureId={1} mode="uncommitted" />);

    await user.click(rowButton("src/foo.ts"));

    const step = document.querySelector("[data-phone-diff-step]");
    expect(step).toHaveAttribute("data-phone-diff-step", "src/foo.ts");
    expect(screen.getByTestId("patch-diff-view")).toBeInTheDocument();
    expect(mocks.patchDiffViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "unified" }),
    );
    expect(screen.queryByRole("button", { name: "Open src/bar.ts" })).not.toBeInTheDocument();
  });

  it("steps to the previous and next file in list order", async () => {
    withFiles([fooFile, barFile]);
    const { user } = render(<DiffViewer featureId={1} mode="uncommitted" />);
    await user.click(rowButton("src/bar.ts"));

    expect(screen.getByRole("button", { name: "Previous file" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next file" }));
    expect(document.querySelector("[data-phone-diff-step]")).toHaveAttribute(
      "data-phone-diff-step",
      "src/foo.ts",
    );
    expect(screen.getByRole("button", { name: "Next file" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous file" }));
    expect(document.querySelector("[data-phone-diff-step]")).toHaveAttribute(
      "data-phone-diff-step",
      "src/bar.ts",
    );
  });

  it("goes back to the list where it was scrolled", async () => {
    withFiles([fooFile, barFile]);
    const { user } = render(<DiffViewer featureId={1} mode="uncommitted" />);
    expect(virtuoso.initialScrollTop.at(-1)).toBe(0);

    virtuoso.scroller.scrollTop = 120;
    await user.click(rowButton("src/foo.ts"));
    await user.click(screen.getByRole("button", { name: "Back to Changes" }));

    expect(rowButton("src/foo.ts")).toBeInTheDocument();
    expect(virtuoso.initialScrollTop.at(-1)).toBe(120);
  });

  it("names the branch diff's list after its target", async () => {
    withFiles([fooFile]);
    const { user } = render(<DiffViewer featureId={1} mode="branch" targetBranch="main" />);
    await user.click(rowButton("src/foo.ts"));
    expect(screen.getByRole("button", { name: "Back to vs main" })).toBeInTheDocument();
  });

  it("stages and unstages from a row's 44px box, without ticking it before Git answers", async () => {
    withFiles([fooFile, stagedFile]);
    const { user } = render(<DiffViewer featureId={3} mode="uncommitted" />);

    const stage = screen.getByRole("checkbox", { name: "Stage src/foo.ts" });
    // The shared checkbox, its 44px target the slot it sits in.
    expect(stage).toHaveAttribute("data-slot", "checkbox");
    expect(stage).toHaveClass("phone:hit-area");
    expect(stage.closest("[data-phone-stage-slot]")).toHaveClass("size-11");
    expect(stage).toHaveAttribute("aria-checked", "false");
    await user.click(stage);
    expect(mocks.stageMutate).toHaveBeenCalledWith({
      data: { feature_id: 3, file_path: "src/foo.ts" },
    });
    // A spinner until Git answers, never a tick.
    expect(screen.getByRole("status", { name: "Staging src/foo.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Stage src/foo.ts" })).not.toBeInTheDocument();
  });

  it("unstages a staged file from its box", async () => {
    withFiles([stagedFile]);
    const { user } = render(<DiffViewer featureId={3} mode="uncommitted" />);
    const box = screen.getByRole("checkbox", { name: "Stage lib/zed.ts" });
    expect(box).toHaveAttribute("aria-checked", "true");
    await user.click(box);
    expect(mocks.resetMutate).toHaveBeenCalledWith({
      data: { feature_id: 3, file_path: "lib/zed.ts" },
    });
  });

  it("has no stage boxes on a read-only diff", () => {
    withFiles([fooFile]);
    render(<DiffViewer featureId={1} mode="branch" targetBranch="main" />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("holds the file's actions in its sheet", async () => {
    withFiles([fooFile]);
    const { user } = render(<DiffViewer featureId={5} mode="uncommitted" />);
    await user.click(rowButton("src/foo.ts"));
    await user.click(screen.getByRole("button", { name: "Actions for src/foo.ts" }));

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("button", { name: /Copy path/ })).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: /Stage file/ }));
    expect(mocks.stageMutate).toHaveBeenCalledWith({
      data: { feature_id: 5, file_path: "src/foo.ts" },
    });
  });

  it("shows the Commit bar on the working tree's list only while it has changes", async () => {
    withFiles([fooFile]);
    const { user, rerender } = render(<DiffViewer featureId={9} mode="uncommitted" />);
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();

    act(() => setUncommitted(9, 2));
    expect(screen.getByText("2 uncommitted changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Commit" }));
    // The header's commit, through the shortcut only the workspace on screen registers.
    expect(runShortcutActionOutcome).toHaveBeenCalledWith("git-commit");

    // Not on the diff step, nor on a branch diff.
    await user.click(rowButton("src/foo.ts"));
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
    rerender(<DiffViewer featureId={9} mode="branch" targetBranch="main" />);
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
  });

  it("returns to the list when the open file leaves it", async () => {
    withFiles([fooFile, barFile]);
    const { user, rerender } = render(<DiffViewer featureId={1} mode="uncommitted" />);
    await user.click(rowButton("src/foo.ts"));
    withFiles([barFile]);
    // A new prop stands in for the query's own re-render (DiffViewer is memoized).
    rerender(<DiffViewer featureId={1} mode="uncommitted" afterToolbar={<span />} />);
    expect(rowButton("src/bar.ts")).toBeInTheDocument();
  });

  it("stays on the list once the open file leaves it, even if it comes back", async () => {
    withFiles([fooFile, barFile]);
    const { user, rerender } = render(<DiffViewer featureId={1} mode="uncommitted" />);
    await user.click(rowButton("src/foo.ts"));
    withFiles([barFile]);
    rerender(<DiffViewer featureId={1} mode="uncommitted" afterToolbar={<span />} />);
    withFiles([fooFile, barFile]);
    rerender(<DiffViewer featureId={1} mode="uncommitted" afterToolbar={<b />} />);
    expect(document.querySelector("[data-phone-diff-step]")).toBeNull();
    expect(rowButton("src/foo.ts")).toBeInTheDocument();
  });

  it("goes back to the file stepped to, not where the list was", async () => {
    withFiles([fooFile, barFile]);
    const { user } = render(<DiffViewer featureId={1} mode="uncommitted" />);
    await user.click(rowButton("src/bar.ts"));
    await user.click(screen.getByRole("button", { name: "Next file" }));
    await user.click(screen.getByRole("button", { name: "Back to Changes" }));
    expect(virtuoso.initialTopMostItemIndex.at(-1)).toEqual({ index: 1, align: "center" });
  });
});

describe("a review thread on the phone layout", () => {
  const target = (filePath: string): ReviewNavigationTarget => ({
    threadId: `thread-${filePath}`,
    filePath,
    lineNumber: 1,
    side: "RIGHT" as ReviewNavigationTarget["side"],
  });

  it("opens its file once: Back and a view switch keep the list", async () => {
    withFiles([fooFile, barFile]);
    const linked = target("src/foo.ts");
    const { user, rerender } = render(
      <DiffViewer featureId={1} mode="branch" targetBranch="main" reviewTarget={linked} />,
    );
    expect(document.querySelector("[data-phone-diff-step]")).toHaveAttribute(
      "data-phone-diff-step",
      "src/foo.ts",
    );
    await user.click(screen.getByRole("button", { name: "Back to vs main" }));
    // Another view, then back: the list remounts with the same target.
    rerender(<DiffViewer featureId={1} mode="uncommitted" reviewTarget={null} />);
    rerender(<DiffViewer featureId={1} mode="branch" targetBranch="main" reviewTarget={linked} />);
    expect(document.querySelector("[data-phone-diff-step]")).toBeNull();

    // A thread picked next opens its file.
    rerender(
      <DiffViewer
        featureId={1}
        mode="branch"
        targetBranch="main"
        reviewTarget={target("src/bar.ts")}
      />,
    );
    expect(document.querySelector("[data-phone-diff-step]")).toHaveAttribute(
      "data-phone-diff-step",
      "src/bar.ts",
    );
  });
});

describe("Git keys on the phone layout", () => {
  function renderWithAdapter() {
    const adapters: GitNavigationAdapter[] = [];
    const register = vi.fn((adapter: GitNavigationAdapter) => {
      adapters.push(adapter);
      return () => undefined;
    });
    const view = render(
      <DiffViewer featureId={3} mode="uncommitted" registerNavigationAdapter={register} />,
    );
    const adapter = (): GitNavigationAdapter => {
      const last = adapters.at(-1);
      if (!last) throw new Error("no adapter");
      return last;
    };
    return { ...view, adapters, adapter };
  }

  it("acts on nothing while the list is on screen", () => {
    withFiles([fooFile, barFile]);
    const { adapter } = renderWithAdapter();
    expect(adapter().getActiveItem()).toBeNull();
    expect(adapter().stage?.()).toBe(false);
    expect(adapter().moveSelection(1)).toBe(false);
    expect(adapter().back()).toBe(false);
    expect(mocks.stageMutate).not.toHaveBeenCalled();
  });

  it("moves between files, stages the one shown and goes back", async () => {
    withFiles([fooFile, barFile]);
    const { user, adapter, adapters } = renderWithAdapter();
    await user.click(rowButton("src/foo.ts"));
    expect(adapter().getActiveItem()).toBe("src/foo.ts");

    act(() => void adapter().moveSelection(-1));
    expect(document.querySelector("[data-phone-diff-step]")).toHaveAttribute(
      "data-phone-diff-step",
      "src/bar.ts",
    );
    act(() => void adapter().stage?.());
    expect(mocks.stageMutate).toHaveBeenCalledWith({
      data: { feature_id: 3, file_path: "src/bar.ts" },
    });
    act(() => void adapter().back());
    expect(rowButton("src/foo.ts")).toBeInTheDocument();
    // Only the phone adapter is registered: one, stable.
    expect(new Set(adapters).size).toBe(1);
  });

  it("holds the sheet's Stage until Git confirms, as the list's box does", async () => {
    withFiles([fooFile]);
    const { user, rerender } = render(<DiffViewer featureId={5} mode="uncommitted" />);
    await user.click(rowButton("src/foo.ts"));
    const openSheet = async (): Promise<HTMLElement> => {
      await user.click(screen.getByRole("button", { name: "Actions for src/foo.ts" }));
      return screen.findByRole("dialog");
    };
    await user.click(within(await openSheet()).getByRole("button", { name: /Stage file/ }));
    // The request answered, the file list not yet: still held.
    act(() => mocks.stageSettled.current?.());
    expect(within(await openSheet()).getByRole("button", { name: /Stage file/ })).toBeDisabled();
    await user.keyboard("{Escape}");

    // The list confirms it: staged now, so the sheet offers Unstage.
    withFiles([{ ...fooFile, stage_state: "staged", is_staged: true }]);
    rerender(<DiffViewer featureId={5} mode="uncommitted" afterToolbar={<span />} />);
    expect(within(await openSheet()).getByRole("button", { name: /Unstage file/ })).toBeEnabled();
  });
});
