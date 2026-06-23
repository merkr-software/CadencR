import { useMemo, useRef, useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useGetFileBlobShas,
  useGetDiff,
  useGetChangedFiles,
  getGetFileContentQueryKey,
  useListDiffViewed,
  useMarkDiffViewed,
  useUnmarkDiffViewed,
  useListDiffComments,
  useCreateDiffComment,
  useUpdateDiffComment,
  useDeleteDiffComment,
  type FileContent,
  type FileContentBatchItem,
  type GetFileContentBatchBody,
  getListDiffViewedQueryKey,
  getListDiffCommentsQueryKey,
} from "@/api/generated";
import type { ParsedFileMeta } from "@/lib/parse-unified-diff";
import { useParsedDiff } from "./useParsedDiff";
import { findStalePendingCommentIds } from "@/lib/diff-comment-validity";

// Module-scoped dedupe state for the auto-invalidation effect below. Multiple
// `DiffViewer`s can mount simultaneously; using
// hook-local refs would let each instance fire its own delete + toast for the
// same stale batch. A shared set + per-feature last-batch key collapses both.
const inFlightStaleDeleteIds = new Set<number>();
const lastToastedStaleBatchKeys = new Map<number, string>();

/**
 * Seed individual `useGetFileContent` caches from a batch response. Keys are
 * derived from the request variables (`params`) — *not* from any React state
 * the caller might be holding — so a late response from a previous
 * commit/branch/mode cannot poison the cache for the current view.
 *
 * For files whose content is byte-identical to what's already cached, we skip
 * the `setQueryData` call entirely. React Query notifies subscribers on every
 * `setQueryData` regardless of value equality (its `structuralSharing` only
 * applies to query-function results), so writing identical content would
 * needlessly re-render the corresponding `DiffFileBlock` and remount its
 * CodeMirror editor. Skipping the write keeps unchanged files inert when
 * a single file in the diff actually changes.
 *
 * Exposed for unit testing: this is the surface that the original race bug
 * lived on, and it must stay verifiable without standing up a full hook.
 */
export function seedBatchFileContentCache(
  client: QueryClient,
  items: FileContentBatchItem[],
  params: GetFileContentBatchBody,
): void {
  for (const item of items) {
    const queryKey = getGetFileContentQueryKey({
      feature_id: params.feature_id,
      file_path: item.file_path,
      mode: params.mode,
      // Batch body uses `string | null`; query params use `string | undefined` —
      // coerce so the seeded key matches what `useGetFileContent` computes.
      target_branch: params.target_branch ?? undefined,
      commit_sha: params.commit_sha ?? undefined,
    });
    const next: FileContent = {
      old_content: item.old_content,
      new_content: item.new_content,
      old_size: item.old_size,
      new_size: item.new_size,
      is_binary: item.is_binary,
      is_large: item.is_large,
    };
    const existing = client.getQueryData<FileContent>(queryKey);
    if (
      existing &&
      existing.old_content === next.old_content &&
      existing.new_content === next.new_content &&
      existing.old_size === next.old_size &&
      existing.new_size === next.new_size &&
      existing.is_binary === next.is_binary &&
      existing.is_large === next.is_large
    ) {
      continue;
    }
    client.setQueryData(queryKey, next);
  }
}

export type FileMeta = ParsedFileMeta;

/**
 * Diff endpoint mode values. `"uncommitted"` is the new Git-tab segmented
 * control's working-tree alias (backed by the same `worktree` codepath on the
 * server, including untracked-as-new-file synthesis); `"worktree"` remains the
 * legacy value still passed by other call sites; `"branch"` is the
 * commits-vs-target-branch view.
 */
export type DiffMode = "worktree" | "branch" | "uncommitted";

export function useDiffData(
  featureId: number,
  mode: DiffMode,
  targetBranch?: string,
  /**
   * Controlled commit selection. When set, the diff query targets that single
   * commit (`commit_sha`); the Git-tab Graph view drives this when a commit is
   * opened. Left `undefined`/`null`, the diff shows the working-tree / branch
   * comparison for `mode`.
   */
  commitSha?: string | null,
) {
  const queryClient = useQueryClient();
  const selectedCommit = commitSha ?? null;

  // ---- Diff & file content ----
  // In branch mode the target branch resolves asynchronously (the Git tab
  // reads it from a snapshot query). Firing before it's known triggers a
  // throwaway fetch of the default-branch diff — potentially huge — that is
  // immediately refetched once the real target arrives, doubling the network +
  // parse + render cost on open. Gate the query until the target (or a pinned
  // commit) is known.
  const diffParamsReady = mode !== "branch" || !!targetBranch || !!selectedCommit;
  const { data: diffResponse, isLoading } = useGetDiff(
    {
      feature_id: featureId,
      mode,
      target_branch: targetBranch,
      commit_sha: selectedCommit ?? undefined,
    },
    { query: { enabled: diffParamsReady } },
  );
  const rawDiff = diffResponse?.diff;

  // Parsing + line-stat'ing the whole diff is O(diff size); for large diffs it
  // runs off the main thread so the Git tab doesn't jank on open.
  const { fileMeta, fileNames, isParsing } = useParsedDiff(rawDiff);

  // Per-file staging state. Only meaningful in the working-tree views; in
  // `branch` mode the set stays empty so the badge never renders.
  const isUncommittedView = mode === "uncommitted" || mode === "worktree";
  const { data: changedFiles = [] } = useGetChangedFiles(
    {
      feature_id: featureId,
      mode,
      target_branch: targetBranch,
    },
    { query: { enabled: isUncommittedView && !selectedCommit } },
  );
  const stagedFiles: Set<string> = useMemo(() => {
    const set = new Set<string>();
    if (!isUncommittedView) return set;
    for (const f of changedFiles) {
      if (f.is_staged) set.add(f.file);
    }
    return set;
  }, [changedFiles, isUncommittedView]);

  // ---- Blob SHAs & viewed tracking ----
  const { data: blobShasList = [] } = useGetFileBlobShas({ feature_id: featureId });
  const blobShas: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of blobShasList) {
      if (item.sha) map[item.file_path] = item.sha;
    }
    return map;
  }, [blobShasList]);

  const { data: viewedList = [] } = useListDiffViewed(featureId);
  const viewedFilesSet = useMemo(() => {
    const set = new Set<string>();
    for (const v of viewedList) {
      const currentSha = blobShas[v.file_path];
      if (currentSha && currentSha !== v.blob_sha) continue;
      set.add(v.file_path);
    }
    return set;
  }, [viewedList, blobShas]);

  const markViewed = useMarkDiffViewed({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: getListDiffViewedQueryKey(featureId) }),
    },
  });
  const unmarkViewed = useUnmarkDiffViewed({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: getListDiffViewedQueryKey(featureId) }),
    },
  });

  // ---- Comments ----
  const { data: comments = [] } = useListDiffComments(featureId);

  const createComment = useCreateDiffComment({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: getListDiffCommentsQueryKey(featureId) }),
    },
  });
  const updateComment = useUpdateDiffComment({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: getListDiffCommentsQueryKey(featureId) }),
    },
  });
  const deleteComment = useDeleteDiffComment({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: getListDiffCommentsQueryKey(featureId) }),
    },
  });

  // ---- Auto-invalidate pending comments on changed files ----
  // Product rule: if any pending comment on a file is stale (its recorded
  // `original_blob_sha` no longer matches the file's current SHA), drop *all*
  // pending comments on that file. State below is module-scoped so two
  // simultaneously-mounted `DiffViewer`s don't double-fire
  // deletes or double-toast for the same batch.
  const deleteCommentMutate = deleteComment.mutate;
  useEffect(() => {
    if (comments.length === 0) return;
    const staleIds = findStalePendingCommentIds(comments, blobShas).filter(
      (id) => !inFlightStaleDeleteIds.has(id),
    );
    if (staleIds.length === 0) return;

    // Sorted-id key dedupes re-renders within a batch and across hook instances.
    const batchKey = [...staleIds].sort((a, b) => a - b).join(",");
    if (lastToastedStaleBatchKeys.get(featureId) !== batchKey) {
      lastToastedStaleBatchKeys.set(featureId, batchKey);
      const noun = staleIds.length === 1 ? "comment" : "comments";
      toast.info(`Removed ${staleIds.length} ${noun} on changed files`);
    }

    for (const id of staleIds) {
      inFlightStaleDeleteIds.add(id);
      deleteCommentMutate(
        { id },
        {
          onSettled: () => inFlightStaleDeleteIds.delete(id),
          onError: (err: unknown) => {
            const message = err instanceof Error ? err.message : "Unknown error";
            toast.error(`Failed to remove stale comment: ${message}`);
          },
        },
      );
    }
  }, [featureId, comments, blobShas, deleteCommentMutate]);

  // ---- Auto-collapse viewed files ----
  const hasInitializedCollapse = useRef(false);

  return {
    // Surface off-thread parsing — and the branch-mode target-resolution gate —
    // as loading so the diff view shows its loader (and never a momentary empty
    // body) while a large diff is fetched or parsed.
    isLoading: isLoading || isParsing || !diffParamsReady,
    rawDiff,
    fileMeta,
    fileNames,
    stagedFiles,
    selectedCommit,
    blobShas,
    viewedFilesSet,
    markViewed,
    unmarkViewed,
    createComment,
    updateComment,
    deleteComment,
    comments,
    hasInitializedCollapse,
  };
}
