import { useMemo, useRef, useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useGetFileBlobShas,
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
import { findStalePendingCommentIds } from "@/lib/diff-comment-validity";
import { apiErrorMessage } from "@/lib/api-errors";

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

/**
 * Diff endpoint mode values. `"uncommitted"` is the new Git-tab segmented
 * control's working-tree alias (backed by the same `worktree` codepath on the
 * server, including untracked-as-new-file synthesis); `"worktree"` remains the
 * legacy value still passed by other call sites; `"branch"` is the
 * commits-vs-target-branch view.
 */
export type DiffMode = "worktree" | "branch" | "uncommitted";

export function changedFilesErrorMessage(isError: boolean, error: unknown): string | null {
  return isError ? apiErrorMessage(error, "Failed to load changed files") : null;
}

function useChangedFiles(
  featureId: number,
  mode: DiffMode,
  targetBranch: string | undefined,
  selectedCommit: string | null,
) {
  const diffParamsReady = mode !== "branch" || !!targetBranch || !!selectedCommit;
  const query = useGetChangedFiles(
    {
      feature_id: featureId,
      mode: mode === "uncommitted" ? "worktree" : mode,
      target_branch: targetBranch,
      commit_sha: selectedCommit ?? undefined,
    },
    { query: { enabled: diffParamsReady } },
  );
  const changedFiles = useMemo(() => query.data ?? [], [query.data]);
  const fileNames = useMemo(() => changedFiles.map((file) => file.file), [changedFiles]);
  const errorMessage = changedFilesErrorMessage(query.isError, query.error);
  const isLoading = query.isLoading || !diffParamsReady;
  return useMemo(
    () => ({ changedFiles, fileNames, errorMessage, isLoading }),
    [changedFiles, errorMessage, fileNames, isLoading],
  );
}

function useViewedFiles(featureId: number, queryClient: QueryClient) {
  const blobShasQuery = useGetFileBlobShas({ feature_id: featureId });
  const blobShas: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of blobShasQuery.data ?? []) {
      if (item.sha) map[item.file_path] = item.sha;
    }
    return map;
  }, [blobShasQuery.data]);
  const blobShasError = blobShasQuery.isError
    ? apiErrorMessage(blobShasQuery.error, "Failed to read file versions")
    : null;
  useEffect(() => {
    if (!blobShasError) return;
    toast.error(`Review comment checks paused: ${blobShasError}`, {
      id: `diff-blob-shas-${featureId}`,
    });
  }, [blobShasError, featureId]);
  const viewedQuery = useListDiffViewed(featureId);
  const viewedFilesSet = useMemo(() => {
    const set = new Set<string>();
    for (const viewed of viewedQuery.data ?? []) {
      const currentSha = blobShas[viewed.file_path];
      if (currentSha && currentSha !== viewed.blob_sha) continue;
      set.add(viewed.file_path);
    }
    return set;
  }, [blobShas, viewedQuery.data]);
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
  const viewed = useMemo(
    () => ({ blobShas, viewedFilesSet, markViewed, unmarkViewed }),
    [blobShas, markViewed, unmarkViewed, viewedFilesSet],
  );
  // Kept out of the memo: the timestamp moves on every refetch, and only the
  // stale-comment gate reads it.
  return { viewed, blobShasUpdatedAt: successfulAt(blobShasQuery) };
}

/** When the query last succeeded, or `null` while loading or after an error. */
function successfulAt(query: { isSuccess: boolean; dataUpdatedAt: number }): number | null {
  return query.isSuccess ? query.dataUpdatedAt : null;
}

function useCommentActions(featureId: number, queryClient: QueryClient) {
  const commentsQuery = useListDiffComments(featureId);
  const comments = useMemo(() => commentsQuery.data ?? [], [commentsQuery.data]);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListDiffCommentsQueryKey(featureId) });
  const createComment = useCreateDiffComment({ mutation: { onSuccess: invalidate } });
  const updateComment = useUpdateDiffComment({ mutation: { onSuccess: invalidate } });
  const deleteComment = useDeleteDiffComment({ mutation: { onSuccess: invalidate } });
  const actions = useMemo(
    () => ({ comments, createComment, updateComment, deleteComment }),
    [comments, createComment, deleteComment, updateComment],
  );
  return { actions, commentsUpdatedAt: successfulAt(commentsQuery) };
}

/**
 * A pending comment whose file is missing from `blobShas`, or whose SHA
 * differs, gets deleted. So the map must come from a successful response
 * (never the empty map shown while loading or after an error) that is at
 * least as recent as the comment list: a cached map older than a comment
 * stamped by another client would retire it.
 */
function staleCommentCheckReady(
  blobShasUpdatedAt: number | null,
  commentsUpdatedAt: number | null,
): boolean {
  return (
    blobShasUpdatedAt !== null &&
    commentsUpdatedAt !== null &&
    blobShasUpdatedAt >= commentsUpdatedAt
  );
}

interface StaleCommentInputs {
  comments: ReturnType<typeof useCommentActions>["actions"]["comments"];
  blobShas: Record<string, string>;
  /** See {@link staleCommentCheckReady}. */
  ready: boolean;
}

function useStaleCommentInvalidation(
  featureId: number,
  { comments, blobShas, ready }: StaleCommentInputs,
  deleteComment: ReturnType<typeof useCommentActions>["actions"]["deleteComment"],
): void {
  const deleteCommentMutate = deleteComment.mutate;
  useEffect(() => {
    if (!ready || comments.length === 0) return;
    const staleIds = findStalePendingCommentIds(comments, blobShas).filter(
      (id) => !inFlightStaleDeleteIds.has(id),
    );
    if (staleIds.length === 0) return;
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
          onError: (error: unknown) => {
            const message = apiErrorMessage(error, "Unknown error");
            toast.error(`Failed to remove stale comment: ${message}`);
          },
        },
      );
    }
  }, [blobShas, comments, deleteCommentMutate, featureId, ready]);
}

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
  const changed = useChangedFiles(featureId, mode, targetBranch, selectedCommit);
  const { viewed, blobShasUpdatedAt } = useViewedFiles(featureId, queryClient);
  const { actions: commentActions, commentsUpdatedAt } = useCommentActions(featureId, queryClient);
  useStaleCommentInvalidation(
    featureId,
    {
      comments: commentActions.comments,
      blobShas: viewed.blobShas,
      ready: staleCommentCheckReady(blobShasUpdatedAt, commentsUpdatedAt),
    },
    commentActions.deleteComment,
  );
  const hasInitializedCollapse = useRef(false);
  return useMemo(
    () => ({
      isLoading: changed.isLoading,
      errorMessage: changed.errorMessage,
      changedFiles: changed.changedFiles,
      fileNames: changed.fileNames,
      selectedCommit,
      blobShas: viewed.blobShas,
      viewedFilesSet: viewed.viewedFilesSet,
      markViewed: viewed.markViewed,
      unmarkViewed: viewed.unmarkViewed,
      createComment: commentActions.createComment,
      updateComment: commentActions.updateComment,
      deleteComment: commentActions.deleteComment,
      comments: commentActions.comments,
      hasInitializedCollapse,
    }),
    [changed, commentActions, selectedCommit, viewed],
  );
}
