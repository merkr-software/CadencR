import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, within } from "@/test-utils";
import type { FileDiffSection } from "@/lib/parse-unified-diff";
import type { GitNavigationAdapter, GitNavigationAdapterRegistrar } from "./gitNavigation";

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
  useStageFile: () => ({ mutate: mocks.stageMutate }),
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

import { DiffViewer, visibleReviewThread } from "./DiffViewer";

/** Default: the changed-files list contains one modified file. */
function withFooFile(): void {
  mocks.useGetChangedFilesMock.mockReturnValue({ data: [fooFile], isLoading: false });
}

function createAdapterCapture(): {
  current: GitNavigationAdapter | null;
  register: GitNavigationAdapterRegistrar;
} {
  const capture: {
    current: GitNavigationAdapter | null;
    register: GitNavigationAdapterRegistrar;
  } = {
    current: null,
    register: (adapter) => {
      capture.current = adapter;
      return () => {
        if (capture.current === adapter) capture.current = null;
      };
    },
  };
  return capture;
}

beforeEach(() => {
  mocks.persistFileListCollapsedMock.mockReset();
  mocks.persistTreeDisplayModeMock.mockReset();
  mocks.useTreeDisplaySettingMock.mockClear();
  mocks.shortcutCallbacks.clear();
  mocks.toastInfo.mockReset();
  mocks.stageMutate.mockReset();
  mocks.resetMutate.mockReset();
  mocks.markViewedMutate.mockReset();
  mocks.unmarkViewedMutate.mockReset();
  mocks.useMarkViewedMock.mockReset();
  mocks.useMarkViewedMock.mockReturnValue({
    mutate: mocks.markViewedMutate,
    isPending: false,
  });
  mocks.useUnmarkViewedMock.mockReset();
  mocks.useUnmarkViewedMock.mockReturnValue({
    mutate: mocks.unmarkViewedMutate,
    isPending: false,
  });
  mocks.patchDiffViewMock.mockClear();
  mocks.useSettingMock.mockReset();
  mocks.useGetChangedFilesMock.mockReset();
  mocks.useGetChangedFilesMock.mockReturnValue({ data: [], isLoading: false });
  mocks.useGetFileBlobShasMock.mockReset();
  mocks.useGetFileBlobShasMock.mockReturnValue({ data: [] });
  mocks.useListDiffViewedMock.mockReset();
  mocks.useListDiffViewedMock.mockReturnValue({ data: [] });
  mocks.useSettingMock.mockReturnValue({
    value: null,
    setValue: mocks.persistFileListCollapsedMock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiffViewer", () => {
  it("shows loading state", () => {
    mocks.useGetChangedFilesMock.mockReturnValue({ data: [], isLoading: true });
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(screen.getByText("Loading diff...")).toBeInTheDocument();
    expect(mocks.useTreeDisplaySettingMock).not.toHaveBeenCalled();
  });

  it("reuses the worktree changed-files cache for the uncommitted alias", () => {
    render(<DiffViewer featureId={1} mode="uncommitted" />);

    expect(mocks.useGetChangedFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ feature_id: 1, mode: "worktree" }),
      expect.anything(),
    );
  });

  it("keeps hook order stable when the file list resolves", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.useGetChangedFilesMock.mockReturnValue({ data: [], isLoading: true });

    const { rerender } = render(<DiffViewer featureId={1} mode="worktree" />);

    withFooFile();

    expect(() => rerender(<DiffViewer featureId={1} mode="worktree" />)).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("React has detected a change in the order of Hooks"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("keeps hook order stable when switching from loaded list back to loading", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    withFooFile();

    const { rerender } = render(<DiffViewer featureId={1} mode="worktree" />);

    mocks.useGetChangedFilesMock.mockReturnValue({ data: [], isLoading: true });

    expect(() => rerender(<DiffViewer featureId={2} mode="worktree" />)).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("React has detected a change in the order of Hooks"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("shows 'No changes detected' when the file list is empty", () => {
    mocks.useGetChangedFilesMock.mockReturnValue({ data: [], isLoading: false });
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(screen.getByText("No changes detected")).toBeInTheDocument();
    expect(mocks.useTreeDisplaySettingMock).not.toHaveBeenCalled();
  });

  it("retains the changed-files query error instead of rendering an empty state", () => {
    mocks.useGetChangedFilesMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: true,
      error: new Error("porcelain failed"),
    });
    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(screen.getByRole("alert")).toHaveTextContent("porcelain failed");
    expect(screen.queryByText("No changes detected")).not.toBeInTheDocument();
  });

  it("renders diff content when files are present", () => {
    withFooFile();
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });

  it("does not re-render the diff tree for an identical parent render", () => {
    withFooFile();
    const { rerender } = render(<DiffViewer featureId={1} mode="worktree" />);
    const queryHookCalls = mocks.useGetChangedFilesMock.mock.calls.length;

    rerender(<DiffViewer featureId={1} mode="worktree" />);

    expect(mocks.useGetChangedFilesMock).toHaveBeenCalledTimes(queryHookCalls);
  });

  it("renders the file copy and collapse controls in the file header", () => {
    withFooFile();
    render(<DiffViewer featureId={1} mode="worktree" />);

    const fileHeader = document.querySelector<HTMLElement>("[data-diff-file-header]");
    expect(fileHeader).not.toBeNull();
    expect(
      within(fileHeader as HTMLElement).getByRole("button", { name: /copy path/i }),
    ).toBeInTheDocument();
    expect(
      within(fileHeader as HTMLElement).getByRole("button", { name: /collapse src\/foo.ts/i }),
    ).toBeInTheDocument();
  });

  it("does not render editor-open actions without an editor-open provider", () => {
    withFooFile();
    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(
      screen.queryByRole("button", { name: "Open src/foo.ts in editor" }),
    ).not.toBeInTheDocument();
  });

  it("blocks Mod+O Editor handoff for a both-deleted conflict and explains the resolution", () => {
    mocks.useGetChangedFilesMock.mockReturnValue({
      data: [
        {
          ...fooFile,
          file: "deleted.ts",
          status: "DD",
          stage_state: "conflicted",
          conflict_kind: "dd",
        },
      ],
      isLoading: false,
    });
    const openFileInEditor = vi.fn();
    const adapter = createAdapterCapture();
    render(
      <DiffViewer
        featureId={1}
        mode="uncommitted"
        onOpenFileInEditor={openFileInEditor}
        registerNavigationAdapter={adapter.register}
      />,
    );

    act(() => adapter.current?.moveSelection(1));
    act(() => adapter.current?.openInEditor?.());

    expect(openFileInEditor).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith("Cannot open deleted.ts in Editor", {
      description: "Both sides deleted this file. Stage the deletion to resolve the conflict.",
    });
  });

  it("stages only the exact selected eligible file", () => {
    const adapter = createAdapterCapture();
    withFooFile();
    render(
      <DiffViewer featureId={7} mode="uncommitted" registerNavigationAdapter={adapter.register} />,
    );

    act(() => adapter.current?.moveSelection(1));
    expect(adapter.current?.stage?.()).toBe(true);

    expect(mocks.stageMutate).toHaveBeenCalledOnce();
    expect(mocks.stageMutate).toHaveBeenCalledWith({
      data: { feature_id: 7, file_path: "src/foo.ts" },
    });
  });

  it("toggles viewed for only the selected supported file", () => {
    const adapter = createAdapterCapture();
    withFooFile();
    render(
      <DiffViewer featureId={8} mode="uncommitted" registerNavigationAdapter={adapter.register} />,
    );

    act(() => adapter.current?.moveSelection(1));
    expect(adapter.current?.toggleViewed?.()).toBe(true);

    expect(mocks.markViewedMutate).toHaveBeenCalledWith({
      featureId: 8,
      data: {
        feature_id: 8,
        file_path: "src/foo.ts",
        blob_sha: "",
      },
    });
    expect(mocks.unmarkViewedMutate).not.toHaveBeenCalled();
  });

  it("disables every Viewed control but announces pending state only once", async () => {
    mocks.useMarkViewedMock.mockReturnValue({
      mutate: mocks.markViewedMutate,
      isPending: true,
    });
    const adapter = createAdapterCapture();
    mocks.useGetChangedFilesMock.mockReturnValue({
      data: [fooFile, { ...fooFile, file: "src/bar.ts" }],
      isLoading: false,
    });
    const { user } = render(
      <DiffViewer featureId={8} mode="uncommitted" registerNavigationAdapter={adapter.register} />,
    );
    const checkboxes = screen.getAllByRole("checkbox", { name: "Viewed" });

    expect(checkboxes).toHaveLength(2);
    for (const checkbox of checkboxes) {
      expect(checkbox).toBeDisabled();
      expect(checkbox).toHaveAttribute("aria-busy", "true");
      expect(checkbox).toHaveAccessibleDescription("Updating viewed state");
    }
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Updating viewed state");
    await user.click(screen.getAllByText("Viewed")[0]);

    act(() => adapter.current?.moveSelection(1));
    expect(adapter.current?.toggleViewed?.()).toBe(false);
    expect(mocks.markViewedMutate).not.toHaveBeenCalled();
  });

  it("resets only the exact selected eligible staged file", () => {
    mocks.useGetChangedFilesMock.mockReturnValue({
      data: [{ ...fooFile, is_staged: true, stage_state: "staged" }],
      isLoading: false,
    });
    const adapter = createAdapterCapture();
    render(
      <DiffViewer featureId={9} mode="uncommitted" registerNavigationAdapter={adapter.register} />,
    );

    act(() => adapter.current?.moveSelection(1));
    expect(adapter.current?.reset?.()).toBe(true);

    expect(mocks.resetMutate).toHaveBeenCalledOnce();
    expect(mocks.resetMutate).toHaveBeenCalledWith({
      data: { feature_id: 9, file_path: "src/foo.ts" },
    });
  });

  it.each([
    ["DD", "dd"],
    ["AU", "au"],
    ["UD", "ud"],
    ["UA", "ua"],
    ["DU", "du"],
    ["AA", "aa"],
    ["UU", "uu"],
  ] as const)("keeps Stage and suppresses bare reset for a %s conflict", (status, conflictKind) => {
    mocks.useGetChangedFilesMock.mockReturnValue({
      data: [{ ...fooFile, status, stage_state: "conflicted", conflict_kind: conflictKind }],
      isLoading: false,
    });
    const adapter = createAdapterCapture();
    render(
      <DiffViewer featureId={11} mode="worktree" registerNavigationAdapter={adapter.register} />,
    );

    act(() => adapter.current?.moveSelection(1));
    expect(adapter.current?.reset?.()).toBe(false);
    expect(mocks.resetMutate).not.toHaveBeenCalled();
    expect(adapter.current?.stage?.()).toBe(true);
    expect(mocks.stageMutate).toHaveBeenCalledWith({
      data: { feature_id: 11, file_path: "src/foo.ts" },
    });
  });

  it("does not dispatch stage or reset for a read-only revision", () => {
    const adapter = createAdapterCapture();
    withFooFile();
    render(
      <DiffViewer
        featureId={13}
        mode="worktree"
        commitSha="abc123"
        registerNavigationAdapter={adapter.register}
      />,
    );

    act(() => adapter.current?.moveSelection(1));
    expect(adapter.current?.stage?.()).toBe(false);
    expect(adapter.current?.reset?.()).toBe(false);
    expect(adapter.current?.toggleViewed?.()).toBe(false);
    expect(mocks.stageMutate).not.toHaveBeenCalled();
    expect(mocks.resetMutate).not.toHaveBeenCalled();
  });

  it("scrolls to the newly selected file exactly once per move", () => {
    // The tree's selection listener already scrolls, so the adapter must not
    // scroll again: a second call cancels the animation the first one started
    // and re-registers the identical scroll. Asserting "once" rather than
    // ">= 1" is the whole point — this is the regression that hides.
    const adapter = createAdapterCapture();
    mocks.useGetChangedFilesMock.mockReturnValue({
      data: [fooFile, { ...fooFile, file: "src/bar.ts" }],
      isLoading: false,
    });
    render(
      <DiffViewer featureId={21} mode="uncommitted" registerNavigationAdapter={adapter.register} />,
    );
    mocks.scrollFileToTopMock.mockClear();

    act(() => adapter.current?.moveSelection(1));

    expect(adapter.current?.getActiveItem()).toBe("src/bar.ts");
    expect(mocks.scrollFileToTopMock).toHaveBeenCalledTimes(1);
    expect(mocks.scrollFileToTopMock).toHaveBeenCalledWith(expect.anything(), "src/bar.ts");
  });

  it("still scrolls when a clamped move re-selects the same file", () => {
    // At either end `moveSelection` returns the path it was already on, so the
    // tree never re-selects and never notifies — the adapter has to scroll.
    const adapter = createAdapterCapture();
    withFooFile();
    render(
      <DiffViewer featureId={22} mode="uncommitted" registerNavigationAdapter={adapter.register} />,
    );

    act(() => adapter.current?.moveSelection(1));
    mocks.scrollFileToTopMock.mockClear();
    act(() => adapter.current?.moveSelection(1));

    expect(adapter.current?.getActiveItem()).toBe("src/foo.ts");
    expect(mocks.scrollFileToTopMock).toHaveBeenCalledWith(expect.anything(), "src/foo.ts");
  });

  it("navigates VS Target while keeping index mutations unavailable", () => {
    const adapter = createAdapterCapture();
    withFooFile();
    render(
      <DiffViewer
        featureId={14}
        mode="branch"
        targetBranch="origin/main"
        registerNavigationAdapter={adapter.register}
      />,
    );

    expect(adapter.current?.moveSelection(1)).toBe(true);
    expect(adapter.current?.getActiveItem()).toBe("src/foo.ts");
    expect(adapter.current?.open()).toBe(true);
    expect(adapter.current?.stage?.()).toBe(false);
    expect(adapter.current?.reset?.()).toBe(false);
    expect(mocks.stageMutate).not.toHaveBeenCalled();
    expect(mocks.resetMutate).not.toHaveBeenCalled();
  });

  it("keeps stage/reset single-flight while the exact row is pending", () => {
    const adapter = createAdapterCapture();
    withFooFile();
    render(
      <DiffViewer featureId={15} mode="uncommitted" registerNavigationAdapter={adapter.register} />,
    );

    act(() => adapter.current?.moveSelection(1));
    act(() => {
      adapter.current?.stage?.();
      adapter.current?.stage?.();
      adapter.current?.reset?.();
    });

    expect(mocks.stageMutate).toHaveBeenCalledOnce();
    expect(mocks.resetMutate).not.toHaveBeenCalled();
  });

  it("renders split/unified toggle buttons", () => {
    withFooFile();
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(screen.getByRole("button", { name: "Split" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unified" })).toBeInTheDocument();
  });

  it("reads the workspace-level git diff view mode setting", () => {
    withFooFile();
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(mocks.useSettingMock).toHaveBeenCalledWith("git_diff_view_mode");
  });

  it("persists the diff view mode when toggling Split", async () => {
    const setDiffMode = vi.fn();
    mocks.useSettingMock.mockImplementation((key: string) => ({
      value: null,
      setValue: key === "git_diff_view_mode" ? setDiffMode : mocks.persistFileListCollapsedMock,
    }));
    withFooFile();

    const { user } = render(<DiffViewer featureId={1} mode="worktree" />);
    await user.click(screen.getByRole("button", { name: "Split" }));

    expect(setDiffMode).toHaveBeenCalledWith("split");
  });

  it("uses a workspace-level git file list collapse setting", () => {
    withFooFile();
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(mocks.useSettingMock).toHaveBeenCalledWith("git_sidebar_collapsed");
  });

  it("collapses and persists the git file list", async () => {
    withFooFile();
    const { user } = render(<DiffViewer featureId={1} mode="worktree" />);
    await user.click(screen.getByRole("button", { name: "Collapse Git file list" }));

    expect(mocks.persistFileListCollapsedMock).toHaveBeenCalledWith("true");
  });

  it("keeps patch diff instances mounted when toggling the file list", async () => {
    withFooFile();
    const { user } = render(<DiffViewer featureId={1} mode="worktree" />);
    const initialRenderCount = mocks.patchDiffViewMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Collapse Git file list" }));

    expect(mocks.patchDiffViewMock.mock.calls.length).toBe(initialRenderCount);
  });

  it("starts with the git file list collapsed when persisted", async () => {
    mocks.useSettingMock.mockReturnValue({
      value: "true",
      setValue: mocks.persistFileListCollapsedMock,
    });
    withFooFile();

    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(await screen.findByRole("button", { name: "Expand Git file list" })).toBeInTheDocument();
    // `ResizableSidebarLayout` keeps the sidebar mounted (hidden via
    // CSS + `aria-hidden`) so state inside it survives collapse/expand,
    // so we check the visibility contract instead of DOM presence.
    const filterInput = screen.queryByPlaceholderText("Filter files...");
    expect(filterInput?.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("keeps a collapsed file collapsed when its viewed blob SHA changes", async () => {
    withFooFile();
    mocks.useGetFileBlobShasMock.mockReturnValue({
      data: [{ file_path: "src/foo.ts", sha: "old-sha" }],
    });
    mocks.useListDiffViewedMock.mockReturnValue({
      data: [
        {
          id: 1,
          feature_id: 1,
          file_path: "src/foo.ts",
          blob_sha: "old-sha",
          viewed_at: "now",
        },
      ],
    });

    const { rerender } = render(<DiffViewer featureId={1} mode="worktree" />);
    await vi.waitFor(() => expect(screen.queryByTestId("patch-diff-view")).not.toBeInTheDocument());

    mocks.useGetFileBlobShasMock.mockReturnValue({
      data: [{ file_path: "src/foo.ts", sha: "new-sha" }],
    });
    rerender(<DiffViewer featureId={1} mode="worktree" />);

    await vi.waitFor(() => expect(screen.queryByTestId("patch-diff-view")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Expand src/foo.ts" })).toBeInTheDocument();
  });

  it("scans past a collapsed file without opening it, and opens it on demand", async () => {
    withFooFile();
    mocks.useGetFileBlobShasMock.mockReturnValue({
      data: [{ file_path: "src/foo.ts", sha: "sha" }],
    });
    mocks.useListDiffViewedMock.mockReturnValue({
      data: [{ id: 1, feature_id: 1, file_path: "src/foo.ts", blob_sha: "sha", viewed_at: "now" }],
    });
    const adapter = createAdapterCapture();

    render(
      <DiffViewer featureId={1} mode="worktree" registerNavigationAdapter={adapter.register} />,
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Expand src/foo.ts" })).toBeInTheDocument(),
    );

    // `j`/`k` are a scan: the diff scrolls to the file, but a file the user
    // collapsed (or marked viewed) stays shut.
    act(() => {
      adapter.current?.moveSelection(1);
    });
    expect(screen.getByRole("button", { name: "Expand src/foo.ts" })).toBeInTheDocument();

    // `l` is the explicit open.
    act(() => {
      adapter.current?.open();
    });
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Collapse src/foo.ts" })).toBeInTheDocument(),
    );
  });

  it("does not emit nested button warnings for file headers", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    withFooFile();

    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("cannot be a descendant of <button>"),
    );
  });
});

describe("DiffViewer patch rendering", () => {
  it("does not fetch full file contents for normal Git tab rendering", () => {
    mocks.useGetFileContentMock.mockClear();
    withFooFile();

    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(mocks.useGetFileContentMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("patch-diff-view")).toHaveAttribute("data-patch", singleFileDiff);
  });
});

describe("visibleReviewThread", () => {
  it("waits for a lazy annotation to have layout before completing a jump", () => {
    const container = document.createElement("div");
    const annotation = document.createElement("section");
    annotation.dataset.reviewThreadId = "thread-1";
    container.appendChild(annotation);

    annotation.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    expect(visibleReviewThread(container, "thread-1")).toBeNull();

    annotation.getBoundingClientRect = () => ({ width: 320, height: 120 }) as DOMRect;
    expect(visibleReviewThread(container, "thread-1")).toBe(annotation);
  });
});
