import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface QueryState {
  data: unknown[] | undefined;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  dataUpdatedAt: number;
}

const mocks = vi.hoisted(() => ({
  blobShas: vi.fn<() => QueryState>(),
  comments: vi.fn<() => QueryState>(),
  deleteMutate: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { info: mocks.toastInfo, success: vi.fn(), error: mocks.toastError },
}));

vi.mock("@/api/generated", () => ({
  useGetFileBlobShas: mocks.blobShas,
  useGetChangedFiles: () => ({ data: [], isLoading: false, isError: false, error: null }),
  getGetFileContentQueryKey: () => ["file-content"],
  useListDiffViewed: () => ({ data: [] }),
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

const settled = (data: unknown[], dataUpdatedAt = 100): QueryState => ({
  data,
  isSuccess: true,
  isError: false,
  error: null,
  dataUpdatedAt,
});
const failed = (data: unknown[] | undefined): QueryState => ({
  data,
  isSuccess: false,
  isError: true,
  error: new Error("git exploded"),
  dataUpdatedAt: data ? 100 : 0,
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function renderDiffData() {
  return renderHook(() => useDiffData(7, "worktree"), { wrapper });
}

describe("useDiffData stale comment invalidation", () => {
  beforeEach(() => {
    mocks.deleteMutate.mockReset();
    mocks.toastInfo.mockReset();
    mocks.toastError.mockReset();
    mocks.comments.mockReturnValue(settled([pendingComment]));
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
