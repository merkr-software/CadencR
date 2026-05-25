import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, within } from "@/test-utils";

const mocks = vi.hoisted(() => {
  const useGetDiffMock = vi.fn(() => ({ data: undefined as unknown, isLoading: false }));
  const useMutationMock = vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn() }));
  const useGetFileContentMock = vi.fn(() => ({ data: undefined }));
  const useGetFileBlobShasMock = vi.fn<() => { data: unknown[] }>(() => ({ data: [] }));
  const useListDiffViewedMock = vi.fn<() => { data: unknown[] }>(() => ({ data: [] }));
  const patchDiffViewMock = vi.fn(
    ({
      patch,
      renderHeaderPrefix,
      renderHeaderMetadata,
    }: {
      patch: string;
      renderHeaderPrefix?: () => ReactNode;
      renderHeaderMetadata?: () => ReactNode;
    }) => (
      <div data-testid="patch-diff-view" data-patch={patch}>
        {renderHeaderPrefix?.()}
        <span>src/foo.ts</span>
        {renderHeaderMetadata?.()}
        PatchDiffView
      </div>
    ),
  );
  const persistFileListCollapsedMock = vi.fn();
  const useDebouncedSettingMock = vi.fn<
    (
      key: string,
      debounceMs?: number,
    ) => {
      value: string | null;
      setValue: typeof persistFileListCollapsedMock;
      isLoading?: boolean;
    }
  >(() => ({
    value: null as string | null,
    setValue: persistFileListCollapsedMock,
  }));
  return {
    useGetDiffMock,
    useMutationMock,
    useGetFileContentMock,
    useGetFileBlobShasMock,
    useListDiffViewedMock,
    patchDiffViewMock,
    persistFileListCollapsedMock,
    useDebouncedSettingMock,
  };
});

vi.mock("@/api/generated", () => ({
  useGetDiff: mocks.useGetDiffMock,
  useGetFileBlobShas: mocks.useGetFileBlobShasMock,
  useGetCommitLog: vi.fn(() => ({ data: { commits: [], is_on_base_branch: true } })),
  useGetChangedFiles: vi.fn(() => ({ data: [] })),
  useGetFileContent: mocks.useGetFileContentMock,
  // Orval emits a mutation hook for batch endpoints — mirror the mutation
  // shape so call sites that read `.mutate` and `.data` don't blow up.
  useGetFileContentBatch: mocks.useMutationMock,
  getGetFileContentQueryKey: vi.fn(() => ["git", "file-content"]),
  getListDiffViewedQueryKey: vi.fn((id?: number) => ["/api/features", id, "diff-viewed"]),
  getListDiffCommentsQueryKey: vi.fn((id?: number) => ["/api/features", id, "diff-comments"]),
  useListDiffViewed: mocks.useListDiffViewedMock,
  useMarkDiffViewed: mocks.useMutationMock,
  useUnmarkDiffViewed: mocks.useMutationMock,
  useListDiffComments: vi.fn(() => ({ data: [] })),
  useCreateDiffComment: mocks.useMutationMock,
  useUpdateDiffComment: mocks.useMutationMock,
  useDeleteDiffComment: mocks.useMutationMock,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: vi.fn(() => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() })),
  };
});

vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: (key: string, debounceMs?: number) =>
    mocks.useDebouncedSettingMock(key, debounceMs),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ theme: { id: "dracula", appearance: "dark" } }),
}));

vi.mock("./PatchDiffView", () => ({
  PatchDiffView: (props: Parameters<typeof mocks.patchDiffViewMock>[0]) =>
    mocks.patchDiffViewMock(props),
}));

import { DiffViewer } from "./DiffViewer";

const singleFileDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+line2
`;

beforeEach(() => {
  mocks.persistFileListCollapsedMock.mockReset();
  mocks.patchDiffViewMock.mockClear();
  mocks.useDebouncedSettingMock.mockReset();
  mocks.useGetFileBlobShasMock.mockReset();
  mocks.useGetFileBlobShasMock.mockReturnValue({ data: [] });
  mocks.useListDiffViewedMock.mockReset();
  mocks.useListDiffViewedMock.mockReturnValue({ data: [] });
  mocks.useDebouncedSettingMock.mockReturnValue({
    value: null,
    setValue: mocks.persistFileListCollapsedMock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiffViewer", () => {
  it("shows loading state", () => {
    mocks.useGetDiffMock.mockReturnValue({ data: undefined as unknown, isLoading: true });
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(screen.getByText("Loading diff...")).toBeInTheDocument();
  });

  it("keeps hook order stable when loading diff resolves", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.useGetDiffMock.mockReturnValue({ data: undefined as unknown, isLoading: true });

    const { rerender } = render(<DiffViewer featureId={1} mode="worktree" />);

    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    expect(() => rerender(<DiffViewer featureId={1} mode="worktree" />)).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("React has detected a change in the order of Hooks"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("keeps hook order stable when switching from loaded diff back to loading", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    const { rerender } = render(<DiffViewer featureId={1} mode="worktree" />);

    mocks.useGetDiffMock.mockReturnValue({ data: undefined as unknown, isLoading: true });

    expect(() => rerender(<DiffViewer featureId={2} mode="worktree" />)).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("React has detected a change in the order of Hooks"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("shows 'No changes detected' when diff is empty", () => {
    mocks.useGetDiffMock.mockReturnValue({ data: { diff: "" } as unknown, isLoading: false });
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(screen.getByText("No changes detected")).toBeInTheDocument();
  });

  it("renders diff content when data is present", () => {
    const mockDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
`;
    mocks.useGetDiffMock.mockReturnValue({ data: { diff: mockDiff } as unknown, isLoading: false });
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });

  it("renders the file copy button in Pierre header prefix", () => {
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });
    render(<DiffViewer featureId={1} mode="worktree" />);

    const fileHeader = screen.getByTestId("patch-diff-view");
    expect(within(fileHeader).getByRole("button", { name: /copy path/i })).toBeInTheDocument();
    expect(
      within(fileHeader).getByRole("button", { name: /collapse src\/foo.ts/i }),
    ).toBeInTheDocument();
  });

  it("does not render editor-open actions without an editor-open provider", () => {
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(
      screen.queryByRole("button", { name: "Open src/foo.ts in editor" }),
    ).not.toBeInTheDocument();
  });

  it("renders split/unified toggle buttons", () => {
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });
    render(<DiffViewer featureId={1} mode="worktree" />);
    expect(screen.getByRole("button", { name: "Split" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unified" })).toBeInTheDocument();
  });

  it("uses a workspace-level git file list collapse setting", () => {
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(mocks.useDebouncedSettingMock).toHaveBeenCalledWith("git_sidebar_collapsed", 0);
  });

  it("collapses and persists the git file list", async () => {
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    const { user } = render(<DiffViewer featureId={1} mode="worktree" />);
    await user.click(screen.getByRole("button", { name: "Collapse Git file list" }));

    expect(mocks.persistFileListCollapsedMock).toHaveBeenCalledWith("true");
  });

  it("keeps patch diff instances mounted when toggling the file list", async () => {
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    const { user } = render(<DiffViewer featureId={1} mode="worktree" />);
    const initialRenderCount = mocks.patchDiffViewMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Collapse Git file list" }));

    expect(mocks.patchDiffViewMock.mock.calls.length).toBe(initialRenderCount);
  });

  it("starts with the git file list collapsed when persisted", async () => {
    mocks.useDebouncedSettingMock.mockReturnValue({
      value: "true",
      setValue: mocks.persistFileListCollapsedMock,
    });
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(await screen.findByRole("button", { name: "Expand Git file list" })).toBeInTheDocument();
    // `ResizableSidebarLayout` keeps the sidebar mounted (hidden via
    // CSS + `aria-hidden`) so state inside it survives collapse/expand,
    // so we check the visibility contract instead of DOM presence.
    const filterInput = screen.queryByPlaceholderText("Filter files...");
    expect(filterInput?.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("expands a previously viewed file when its blob SHA changes", async () => {
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });
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

    expect(await screen.findByTestId("patch-diff-view")).toHaveAttribute(
      "data-patch",
      singleFileDiff,
    );
  });

  it("does not emit nested button warnings for file headers", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("cannot be a descendant of <button>"),
    );
  });
});

describe("DiffViewer patch rendering", () => {
  it("does not fetch full file contents for normal Git tab rendering", () => {
    mocks.useGetFileContentMock.mockClear();
    mocks.useGetDiffMock.mockReturnValue({
      data: { diff: singleFileDiff } as unknown,
      isLoading: false,
    });

    render(<DiffViewer featureId={1} mode="worktree" />);

    expect(mocks.useGetFileContentMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("patch-diff-view")).toHaveAttribute("data-patch", singleFileDiff);
  });
});
