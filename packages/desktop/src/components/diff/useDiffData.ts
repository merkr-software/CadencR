import { translateUi } from "@/lib/i18n/ui";
import { useMemo, useRef, useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useGetFileBlobShas,
  getGetFileBlobShasQueryKey,
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
import { apiErrorCode, apiErrorMessage, WORKTREE_UNAVAILABLE } from "@/lib/api-errors";
import { useQueryErrorToast } from "@/hooks/useQueryErrorToast";
import {
  selectGitCheckoutPending,
  selectGitMissingTargetBranch,
  selectGitWorktreeError,
  useGitStatusStore,
} from "@/stores/useGitStatusStore";

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
  return isError
    ? apiErrorMessage(
        error,
        translateUi(
          "workspace.git.useDiffData.failedToLoadChangedFiles",
          "Failed to load changed files",
        ),
      )
    : null;
}

function useChangedFiles(
  featureId: number,
  mode: DiffMode,
  targetBranch: string | undefined,
  selectedCommit: string | null,
  checkoutError: string | undefined,
  checkingCheckout: boolean,
) {
  const diffParamsReady = mode !== "branch" || !!targetBranch || !!selectedCommit;
  const query = useGetChangedFiles(
    {
      feature_id: featureId,
      mode: mode === "uncommitted" ? "worktree" : mode,
      target_branch: targetBranch,
      commit_sha: selectedCommit ?? undefined,
    },
    { query: { enabled: diffParamsReady && !checkoutError && !checkingCheckout } },
  );
  const unavailable = checkoutError || apiErrorCode(query.error) === WORKTREE_UNAVAILABLE;
  const data = unavailable || checkingCheckout ? undefined : query.data;
  const changedFiles = useMemo(() => data ?? [], [data]);
  const fileNames = useMemo(() => changedFiles.map((file) => file.file), [changedFiles]);
  const errorMessage = checkoutError ?? changedFilesErrorMessage(query.isError, query.error);
  const isLoading = !unavailable && (checkingCheckout || query.isLoading || !diffParamsReady);
  return useMemo(
    () => ({ changedFiles, fileNames, errorMessage, isLoading }),
    [changedFiles, errorMessage, fileNames, isLoading],
  );
}

function useViewedFiles(featureId: number, queryClient: QueryClient, checkoutReady: boolean) {
  const missingTargetBranch = useGitStatusStore(selectGitMissingTargetBranch(featureId));
  const canCheckComments = checkoutReady && missingTargetBranch === undefined;
  const blobShasQuery = useGetFileBlobShas(
    { feature_id: featureId },
    { query: { enabled: canCheckComments } },
  );
  useEffect(() => {
    if (missingTargetBranch === undefined) return;
    const filters = {
      queryKey: getGetFileBlobShasQueryKey({ feature_id: featureId }),
      exact: true,
    };
    // A SHA read from before target loss cannot authorize cleanup on recovery.
    void queryClient.cancelQueries(filters);
    void queryClient.invalidateQueries({ ...filters, refetchType: "none" });
  }, [missingTargetBranch, featureId, queryClient]);
  const shaErrorCode = apiErrorCode(blobShasQuery.error);
  const missingTargetError = shaErrorCode === "MISSING_TARGET_BRANCH";
  const missingCheckoutError = shaErrorCode === WORKTREE_UNAVAILABLE;
  const commentChecksPaused = !canCheckComments || missingTargetError || missingCheckoutError;
  useQueryErrorToast(
    {
      isError:
        canCheckComments && blobShasQuery.isError && !missingTargetError && !missingCheckoutError,
      error: blobShasQuery.error,
    },
    "Review comment checks paused",
    `diff-blob-shas-${featureId}`,
  );
  const blobShaItems = commentChecksPaused ? undefined : blobShasQuery.data;
  const blobShas: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of blobShaItems ?? []) {
      if (item.sha) map[item.file_path] = item.sha;
    }
    return map;
  }, [blobShaItems]);
  const viewedQuery = useListDiffViewed(featureId);
  useQueryErrorToast(viewedQuery, "Could not load viewed files", `diff-viewed-${featureId}`);
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
  const commentChecksNotice =
    checkoutReady && missingCheckoutError
      ? "Review comment checks paused. The feature's worktree is unavailable."
      : checkoutReady && commentChecksPaused
        ? missingTargetBranch
          ? `Review comment checks paused. The target branch “${missingTargetBranch}” is unavailable.`
          : "Review comment checks paused. The target branch is unavailable."
        : null;
  return {
    viewed,
    commentChecksNotice,
    blobShasUpdatedAt: commentChecksPaused ? null : successfulAt(blobShasQuery),
  };
}

/** Only settled successful reads can confirm a comment is stale. */
function successfulAt(query: {
  isSuccess: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
  dataUpdatedAt: number;
}): number | null {
  return query.isSuccess && query.fetchStatus === "idle" ? query.dataUpdatedAt : null;
}

function useCommentActions(featureId: number, queryClient: QueryClient) {
  const commentsQuery = useListDiffComments(featureId);
  useQueryErrorToast(commentsQuery, "Could not load review comments", `diff-comments-${featureId}`);
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
    const git = useGitStatusStore.getState();
    if (
      !ready ||
      comments.length === 0 ||
      selectGitCheckoutPending(featureId)(git) ||
      selectGitWorktreeError(featureId)(git)
    )
      return;
    const staleIds = findStalePendingCommentIds(comments, blobShas).filter(
      (id) => !inFlightStaleDeleteIds.has(id),
    );
    if (staleIds.length === 0) return;
    const batchKey = [...staleIds].sort((a, b) => a - b).join(",");
    if (lastToastedStaleBatchKeys.get(featureId) !== batchKey) {
      lastToastedStaleBatchKeys.set(featureId, batchKey);
      toast.info(
        translateUi(
          "workspace.git.useDiffData.removedStaleComments",
          "Removed {{count, number}} comments on changed files",
          {
            count: staleIds.length,
            defaultValue_one: "Removed {{count, number}} comment on changed files",
          },
        ),
      );
    }
    for (const id of staleIds) {
      inFlightStaleDeleteIds.add(id);
      deleteCommentMutate(
        { id },
        {
          onSettled: () => inFlightStaleDeleteIds.delete(id),
          onError: (error: unknown) => {
            const message = apiErrorMessage(
              error,
              translateUi("workspace.git.useDiffData.unknownError", "Unknown error"),
            );
            toast.error(
              translateUi(
                "workspace.git.useDiffData.failedToRemoveStaleCommentError",
                "Failed to remove stale comment: {{error}}",
                { error: message },
              ),
            );
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
  const checkoutError = useGitStatusStore(selectGitWorktreeError(featureId));
  const checkingCheckout = useGitStatusStore(selectGitCheckoutPending(featureId));
  const changed = useChangedFiles(
    featureId,
    mode,
    targetBranch,
    selectedCommit,
    checkoutError,
    checkingCheckout,
  );
  const { viewed, blobShasUpdatedAt, commentChecksNotice } = useViewedFiles(
    featureId,
    queryClient,
    !checkoutError && !checkingCheckout,
  );
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
      commentChecksNotice,
      hasInitializedCollapse,
    }),
    [changed, commentActions, commentChecksNotice, selectedCommit, viewed],
  );
}
