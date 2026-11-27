import { translateUi, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useMemo, useRef, useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useGetChangedFiles,
  getGetFileContentQueryKey,
  type FileContent,
  type FileContentBatchItem,
  type GetFileContentBatchBody,
} from "@/api/generated";
import { findStalePendingCommentIds } from "@/lib/diff-comment-validity";
import {
  apiErrorCode,
  apiErrorMessage,
  WORKTREE_UNAVAILABLE,
  worktreeUnavailableMessage,
} from "@/lib/api-errors";
import {
  selectGitCheckoutPending,
  selectGitWorktreeError,
  useGitStatusStore,
} from "@/stores/useGitStatusStore";
import { useCommentActions, useViewedFiles } from "./useDiffReviewQueries";

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

export function changedFilesErrorMessage(
  isError: boolean,
  error: unknown,
  t: UiTranslator = translateUi,
): string | null {
  return isError
    ? apiErrorMessage(
        error,
        t("workspace.git.useDiffData.failedToLoadChangedFiles", "Failed to load changed files"),
        t,
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
  const { t } = useUiTranslation();
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
  const errorMessage = checkoutError
    ? worktreeUnavailableMessage(t)
    : changedFilesErrorMessage(query.isError, query.error, t);
  const isLoading = !unavailable && (checkingCheckout || query.isLoading || !diffParamsReady);
  return useMemo(
    () => ({ changedFiles, fileNames, errorMessage, isLoading }),
    [changedFiles, errorMessage, fileNames, isLoading],
  );
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
