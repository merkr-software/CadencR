import { describe, it, expect, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { changedFilesErrorMessage, seedBatchFileContentCache } from "./useDiffData";
import type { FileContent, FileContentBatchItem, GetFileContentBatchBody } from "@/api/generated";

function makeBatchItem(file_path: string, suffix: string): FileContentBatchItem {
  return {
    file_path,
    old_content: `old-${suffix}`,
    new_content: `new-${suffix}`,
    old_size: 1,
    new_size: 1,
    is_binary: false,
    is_large: false,
  };
}

function makeBody(overrides: Partial<GetFileContentBatchBody> = {}): GetFileContentBatchBody {
  return {
    feature_id: 1,
    file_paths: ["a.ts"],
    mode: "worktree",
    target_branch: undefined,
    commit_sha: undefined,
    ...overrides,
  };
}

function fakeClient(existing?: FileContent): QueryClient {
  return {
    setQueryData: vi.fn(),
    getQueryData: vi.fn().mockReturnValue(existing),
  } as unknown as QueryClient;
}

/**
 * Race-condition regression: a batch response that arrives AFTER the user
 * has switched commits/branches must seed the cache under the *original*
 * request's key, not under whatever the React state currently holds. The
 * previous implementation read commit/branch/mode from a render-time closure,
 * which guaranteed cache poisoning whenever a request was in flight while
 * the user navigated.
 */
describe("seedBatchFileContentCache", () => {
  it("derives cache keys from the request body, not from any caller-side state", () => {
    const client = fakeClient();
    const items = [makeBatchItem("a.ts", "1")];

    seedBatchFileContentCache(client, items, makeBody({ commit_sha: "old-sha", mode: "branch" }));

    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    const [key, value] = (client.setQueryData as ReturnType<typeof vi.fn>).mock.calls[0];
    // The key must include the params that were sent with the request.
    expect(key).toEqual([
      "/api/git/file-content",
      { feature_id: 1, file_path: "a.ts", mode: "branch", commit_sha: "old-sha" },
    ]);
    expect(value).toMatchObject({ old_content: "old-1", new_content: "new-1" });
  });

  it("coerces nullable batch-body fields to undefined so keys match useGetFileContent", () => {
    const client = fakeClient();
    const items = [makeBatchItem("a.ts", "1")];

    // Backend's `GetFileContentBatchBody` types `target_branch`/`commit_sha`
    // as `string | null`. The query-side `getGetFileContentQueryKey` types
    // them as `string | undefined`. If we forwarded `null` straight through,
    // the seeded key would NOT match the key `useGetFileContent` computes
    // (object equality differs on `null` vs missing), and consumers would
    // fall through to a network fetch despite the seed.
    seedBatchFileContentCache(client, items, makeBody({ commit_sha: null, target_branch: null }));

    const [key] = (client.setQueryData as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(key).toEqual([
      "/api/git/file-content",
      { feature_id: 1, file_path: "a.ts", mode: "worktree" },
    ]);
  });

  it("seeds one entry per item, isolating per-file cache writes", () => {
    const client = fakeClient();
    const items = [makeBatchItem("a.ts", "1"), makeBatchItem("b.ts", "2")];

    seedBatchFileContentCache(client, items, makeBody({ file_paths: ["a.ts", "b.ts"] }));

    expect(client.setQueryData).toHaveBeenCalledTimes(2);
    const calls = (client.setQueryData as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toMatchObject({ old_content: "old-1" });
    expect(calls[1][1]).toMatchObject({ old_content: "old-2" });
  });

  /**
   * Live-update perf: when the WS-triggered batch refetch returns content
   * identical to what's already cached, skip the `setQueryData` write so
   * React Query doesn't notify subscribers — `DiffFileBlock`'s `React.memo`
   * keeps the same `fileContent` reference and CodeMirror doesn't re-render
   * for files whose hunks didn't actually change.
   */
  it("skips setQueryData when the cached entry already matches the batch item", () => {
    const item = makeBatchItem("a.ts", "1");
    const existing: FileContent = {
      old_content: item.old_content,
      new_content: item.new_content,
      old_size: item.old_size,
      new_size: item.new_size,
      is_binary: item.is_binary,
      is_large: item.is_large,
    };
    const client = fakeClient(existing);

    seedBatchFileContentCache(client, [item], makeBody());

    expect(client.setQueryData).not.toHaveBeenCalled();
    expect(client.getQueryData).toHaveBeenCalledTimes(1);
  });

  it("writes when at least one field differs from the cached entry", () => {
    const item = makeBatchItem("a.ts", "1");
    // Same key but stale `new_content` — must trigger a write.
    const stale: FileContent = {
      old_content: item.old_content,
      new_content: "stale-new",
      old_size: item.old_size,
      new_size: item.new_size,
      is_binary: item.is_binary,
      is_large: item.is_large,
    };
    const client = fakeClient(stale);

    seedBatchFileContentCache(client, [item], makeBody());

    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    const value = (client.setQueryData as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(value).toMatchObject({ new_content: "new-1" });
  });
});

describe("changedFilesErrorMessage", () => {
  it("retains the actual changed-file query failure", () => {
    expect(changedFilesErrorMessage(true, new Error("git status exploded"))).toBe(
      "git status exploded",
    );
  });

  it("does not synthesize an error for a successful empty list", () => {
    expect(changedFilesErrorMessage(false, undefined)).toBeNull();
  });
});
