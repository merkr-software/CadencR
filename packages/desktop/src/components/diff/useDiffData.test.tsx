import { onlineManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatusSnapshot } from "@/api/generated";
import { useGitStatusStore } from "@/stores/useGitStatusStore";

interface QueryState {
  data: unknown[] | undefined;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  dataUpdatedAt: number;
  fetchStatus?: "idle" | "fetching" | "paused";
}

const mocks = vi.hoisted(() => ({
  blobShas:
    vi.fn<
      (params: { feature_id: number }, options?: { query: { enabled: boolean } }) => QueryState
    >(),
  comments: vi.fn<() => QueryState>(),
  viewed: vi.fn<() => QueryState>(),
  deleteMutate: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    info: mocks.toastInfo,
    success: vi.fn(),
    error: mocks.toastError,
    dismiss: mocks.toastDismiss,
  },
}));

vi.mock("@/api/generated", () => ({
  useGetFileBlobShas: mocks.blobShas,
  getGetFileBlobShasQueryKey: (params: { feature_id: number }) => ["blob-shas", params],
  useGetChangedFiles: () => ({ data: [], isLoading: false, isError: false, error: null }),
  getGetFileContentQueryKey: () => ["file-content"],
  useListDiffViewed: mocks.viewed,
  useMarkDiffViewed: () => ({ mutate: vi.fn() }),
  useUnmarkDiffViewed: () => ({ mutate: vi.fn() }),
  useListDiffComments: mocks.comments,
  useCreateDiffComment: () => ({ mutate: vi.fn() }),
  useUpdateDiffComment: () => ({ mutate: vi.fn() }),
  useDeleteDiffComment: () => ({ mutate: mocks.deleteMutate }),
  getListDiffViewedQueryKey: () => ["viewed"],
  getListDiffCommentsQueryKey: () => ["comments"],
}));

import { useDiffData } from "./useDiffData";

const pendingComment = {
  id: 41,
  feature_id: 7,
  file_path: "src/foo.ts",
  line_number: 3,
  side: "RIGHT",
  content: "keep me",
  status: "pending",
  created_at: "now",
  original_blob_sha: "sha-at-comment-time",
};

const snapshot: GitStatusSnapshot = {
  feature_id: 7,
  current_branch: "topic",
  target_branch: "main",
  uncommitted_count: 1,
  staged_count: 0,
  unstaged_count: 1,
  untracked_count: 0,
  ahead_of_remote: 0,
  behind_remote: 0,
  ahead_of_target: 0,
  has_remote: false,
  computed_at: 1,
};

const settled = (data: unknown[], dataUpdatedAt = 100): QueryState => ({
  data,
  isSuccess: true,
  isError: false,
  error: null,
  dataUpdatedAt,
  fetchStatus: "idle",
});
const failed = (data: unknown[] | undefined): QueryState => ({
  data,
  isSuccess: false,
  isError: true,
  error: new Error("git exploded"),
  dataUpdatedAt: data ? 100 : 0,
});

function renderDiffData(client = new QueryClient()) {
  return renderHook(() => useDiffData(7, "worktree"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

describe("useDiffData stale comment invalidation", () => {
  beforeEach(() => {
    mocks.deleteMutate.mockReset();
    mocks.toastInfo.mockReset();
    mocks.toastError.mockReset();
    mocks.toastDismiss.mockReset();
    mocks.viewed.mockReturnValue(settled([]));
    mocks.comments.mockReturnValue(settled([pendingComment]));
    useGitStatusStore.setState(useGitStatusStore.getInitialState());
  });

  it.each<[string, QueryState]>([
    [
      "still loading",
      { data: undefined, isSuccess: false, isError: false, error: null, dataUpdatedAt: 0 },
    ],
    ["failed", failed(undefined)],
    // React Query keeps the last data after a failed refetch.
    ["failed on refetch", failed([])],
  ])("keeps comments while the blob-SHA query is %s", (_label, state) => {
    mocks.blobShas.mockReturnValue(state);

    renderDiffData();

    expect(mocks.deleteMutate).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("waits for a blob-SHA map at least as recent as the comment list", () => {
    // Cached map from before another client stamped the comment with the
    // file's new SHA: comparing them would retire a fresh comment.
    mocks.blobShas.mockReturnValue(settled([{ file_path: "src/foo.ts", sha: "old" }], 50));
    mocks.comments.mockReturnValue(settled([pendingComment], 100));

    renderDiffData();

    expect(mocks.deleteMutate).not.toHaveBeenCalled();
  });

  it("keeps comments when the comment list failed to refresh", () => {
    mocks.blobShas.mockReturnValue(settled([]));
    mocks.comments.mockReturnValue(failed([pendingComment]));

    renderDiffData();

    expect(mocks.deleteMutate).not.toHaveBeenCalled();
  });

  it("surfaces a blob-SHA failure instead of hiding it", () => {
    mocks.blobShas.mockReturnValue(failed(undefined));

    renderDiffData();

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Review comment checks paused"),
      { id: "diff-blob-shas-7" },
    );
  });

  it("preserves comments during target loss and while the restored target is being checked", () => {
    const git = useGitStatusStore.getState();
    git.setStatus({ ...snapshot, target_resolved: true });
    const matching = settled([
      { file_path: pendingComment.file_path, sha: pendingComment.original_blob_sha },
    ]);
    mocks.blobShas.mockReturnValue(matching);
    const { result, rerender } = renderDiffData();
    expect(result.current.commentChecksNotice).toBeNull();

    mocks.blobShas.mockReturnValue(settled([]));
    act(() => git.setStatus({ ...snapshot, computed_at: 2 }));
    expect(result.current.commentChecksNotice).toContain("“main” is unavailable");
    expect(mocks.deleteMutate).not.toHaveBeenCalled();

    mocks.blobShas.mockReturnValue({ ...settled([]), fetchStatus: "fetching" });
    act(() => git.setStatus({ ...snapshot, target_resolved: true, computed_at: 3 }));
    expect(mocks.deleteMutate).not.toHaveBeenCalled();
    mocks.blobShas.mockReturnValue(matching);
    rerender();
    expect(result.current.commentChecksNotice).toBeNull();
    expect(result.current.comments).toEqual([pendingComment]);
    expect(mocks.deleteMutate).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("reports a missing target from the SHA query without a duplicate toast", () => {
    const error = new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 409,
      statusText: "Conflict",
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { error: "Target branch 'main' does not exist", code: "MISSING_TARGET_BRANCH" },
    });
    mocks.blobShas.mockReturnValue({ ...failed(undefined), error });
    const { result } = renderDiffData();
    expect(result.current.commentChecksNotice).toBe(
      "Review comment checks paused. The target branch is unavailable.",
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.deleteMutate).not.toHaveBeenCalled();
  });

  it("reports a missing worktree with its original error", () => {
    const error = new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 409,
      statusText: "Conflict",
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { error: "The feature's worktree is no longer available", code: "CONFLICT" },
    });
    mocks.blobShas.mockReturnValue({ ...failed(undefined), error });
    const { result } = renderDiffData();
    expect(result.current.commentChecksNotice).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Review comment checks paused: The feature's worktree is no longer available",
      { id: "diff-blob-shas-7" },
    );
  });

  it("waits for a fresh successful SHA read after a paused target recovery", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const key = ["blob-shas", { feature_id: 7 }];
    const fetchShas = vi
      .fn()
      .mockResolvedValue([
        { file_path: pendingComment.file_path, sha: pendingComment.original_blob_sha },
      ]);
    mocks.blobShas.mockImplementation(function useTestBlobShas(_params, options) {
      return useQuery({ queryKey: key, queryFn: fetchShas, ...options?.query });
    });
    const git = useGitStatusStore.getState();
    git.setStatus(snapshot);
    client.setQueryData(key, []);
    onlineManager.setOnline(false);
    try {
      const { result } = renderDiffData(client);
      expect(result.current.commentChecksNotice).toContain("“main” is unavailable");
      act(() => git.setStatus({ ...snapshot, target_resolved: true, computed_at: 2 }));
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe("paused"));
      expect(fetchShas).not.toHaveBeenCalled();
      expect(mocks.deleteMutate).not.toHaveBeenCalled();
      act(() => onlineManager.setOnline(true));
      await waitFor(() =>
        expect(result.current.blobShas[pendingComment.file_path]).toBe(
          pendingComment.original_blob_sha,
        ),
      );
      expect(fetchShas).toHaveBeenCalledOnce();
      expect(result.current.comments).toEqual([pendingComment]);
      expect(mocks.deleteMutate).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("dismisses scoped secondary-query errors on recovery", () => {
    mocks.blobShas.mockReturnValue(failed(undefined));
    mocks.viewed.mockReturnValue(failed(undefined));
    mocks.comments.mockReturnValue(failed(undefined));
    const { rerender } = renderDiffData();
    for (const id of ["diff-blob-shas-7", "diff-viewed-7", "diff-comments-7"]) {
      expect(mocks.toastError).toHaveBeenCalledWith(expect.any(String), { id });
    }
    mocks.blobShas.mockReturnValue(settled([]));
    mocks.viewed.mockReturnValue(settled([]));
    mocks.comments.mockReturnValue(settled([]));
    rerender();
    expect(mocks.toastDismiss.mock.calls.flat()).toEqual(
      expect.arrayContaining(["diff-blob-shas-7", "diff-viewed-7", "diff-comments-7"]),
    );
  });

  it("keeps a comment whose file still has its original blob SHA", () => {
    mocks.blobShas.mockReturnValue(
      settled([{ file_path: "src/foo.ts", sha: "sha-at-comment-time" }]),
    );

    renderDiffData();

    expect(mocks.deleteMutate).not.toHaveBeenCalled();
  });

  it("removes a comment once a settled response shows its file changed", () => {
    mocks.blobShas.mockReturnValue(settled([{ file_path: "src/foo.ts", sha: "new-sha" }]));

    renderDiffData();

    expect(mocks.deleteMutate).toHaveBeenCalledWith({ id: 41 }, expect.any(Object));
    expect(mocks.toastInfo).toHaveBeenCalledWith("Removed 1 comment on changed files");
  });
});
