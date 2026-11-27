import { useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  useGetFileBlobShas,
  getGetFileBlobShasQueryKey,
  useListDiffViewed,
  useMarkDiffViewed,
  useUnmarkDiffViewed,
  useListDiffComments,
  useCreateDiffComment,
  useUpdateDiffComment,
  useDeleteDiffComment,
  getListDiffViewedQueryKey,
  getListDiffCommentsQueryKey,
} from "@/api/generated";
import { useQueryErrorToast } from "@/hooks/useQueryErrorToast";
import { apiErrorCode, WORKTREE_UNAVAILABLE } from "@/lib/api-errors";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { selectGitMissingTargetBranch, useGitStatusStore } from "@/stores/useGitStatusStore";

const checksPausedErrorLabel = (t: UiTranslator): string =>
  t("workspace.git.useDiffData.reviewCommentChecksPaused", "Review comment checks paused");
const viewedFilesErrorLabel = (t: UiTranslator): string =>
  t("workspace.git.useDiffData.couldNotLoadViewedFiles", "Could not load viewed files");
const reviewCommentsErrorLabel = (t: UiTranslator): string =>
  t("workspace.git.useDiffData.couldNotLoadReviewComments", "Could not load review comments");

export function useViewedFiles(
  featureId: number,
  queryClient: QueryClient,
  checkoutReady: boolean,
) {
  const { t } = useUiTranslation();
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
    checksPausedErrorLabel,
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
  useQueryErrorToast(viewedQuery, viewedFilesErrorLabel, `diff-viewed-${featureId}`);
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
    checkoutReady && commentChecksPaused
      ? pausedCommentChecksNotice(missingCheckoutError, missingTargetBranch, t)
      : null;
  return {
    viewed,
    commentChecksNotice,
    blobShasUpdatedAt: commentChecksPaused ? null : successfulAt(blobShasQuery),
  };
}

function pausedCommentChecksNotice(
  missingCheckout: boolean,
  missingTargetBranch: string | undefined,
  t: UiTranslator,
): string {
  if (missingCheckout) {
    return t(
      "workspace.git.useDiffData.commentChecksPausedWorktreeUnavailable",
      "Review comment checks paused. The feature's worktree is unavailable.",
    );
  }
  return missingTargetBranch
    ? t(
        "workspace.git.useDiffData.commentChecksPausedNamedBranchUnavailable",
        "Review comment checks paused. The target branch “{{branch}}” is unavailable.",
        { branch: missingTargetBranch },
      )
    : t(
        "workspace.git.useDiffData.commentChecksPausedTargetUnavailable",
        "Review comment checks paused. The target branch is unavailable.",
      );
}

/** Only settled successful reads can confirm a comment is stale. */
function successfulAt(query: {
  isSuccess: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
  dataUpdatedAt: number;
}): number | null {
  return query.isSuccess && query.fetchStatus === "idle" ? query.dataUpdatedAt : null;
}

export function useCommentActions(featureId: number, queryClient: QueryClient) {
  const commentsQuery = useListDiffComments(featureId);
  useQueryErrorToast(commentsQuery, reviewCommentsErrorLabel, `diff-comments-${featureId}`);
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
