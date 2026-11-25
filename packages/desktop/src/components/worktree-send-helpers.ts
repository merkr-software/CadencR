import { translateUi } from "@/lib/i18n/ui";
/**
 * First-prompt worktree side effects for the agent send handler: switching the
 * project repo to a picked branch ("On branch"), and persisting the feature
 * settings the backend's `ensure_worktree` reads for the provisioning modes.
 * Extracted from `WebSocketSessionFeatureBlockTabs` to keep that file small.
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  getGetBranchQueryKey,
  getGetGitStatusQueryKey,
  getListBranchesQueryKey,
  useCheckoutBranch,
  useSetFeatureSetting,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import type { ResolvedWorktreeChoice } from "@/lib/worktree-mode";

/** Invalidate the branch list + git status after the project repo's HEAD moves
 *  (checkout / new branch), so the UI reflects the new branch. */
function invalidateAfterBranchMove(
  queryClient: QueryClient,
  projectId: number,
  featureId: number,
): void {
  queryClient.invalidateQueries({ queryKey: getGetBranchQueryKey({ project_id: projectId }) });
  queryClient.invalidateQueries({ queryKey: getListBranchesQueryKey({ project_id: projectId }) });
  queryClient.invalidateQueries({ queryKey: getGetGitStatusQueryKey({ feature_id: featureId }) });
}

/**
 * `git checkout` the picked branch in the project repo, refreshing the
 * branch/status queries. Returns false (and toasts) when checkout fails.
 */
export async function checkoutSelectedBranch(params: {
  branch: string;
  projectId: number;
  featureId: number;
  queryClient: QueryClient;
  checkoutMutateAsync: ReturnType<typeof useCheckoutBranch>["mutateAsync"];
}): Promise<boolean> {
  const { branch, projectId, featureId, queryClient, checkoutMutateAsync } = params;
  try {
    await checkoutMutateAsync({ data: { project_id: projectId, feature_id: featureId, branch } });
    invalidateAfterBranchMove(queryClient, projectId, featureId);
    return true;
  } catch (err) {
    toast.error(
      apiErrorMessage(
        err,
        translateUi("conversation.worktreeSendHelpers.gitCheckoutFailed", "git checkout failed"),
      ),
    );
    return false;
  }
}

/** Persist the feature settings for a worktree-provisioning mode (`reuse` /
 *  `new`). Throws (after toasting) on failure so the caller can abort the send. */
export async function saveWorktreeChoice(params: {
  choice: Extract<ResolvedWorktreeChoice, { backendMode: "reuse" | "new" }>;
  featureId: number;
  setFeatureSetting: ReturnType<typeof useSetFeatureSetting>;
}): Promise<void> {
  const { choice, featureId, setFeatureSetting } = params;
  try {
    if (choice.backendMode === "reuse") {
      await setFeatureSetting.mutateAsync({
        id: featureId,
        data: { key: "worktree_reuse_branch", value: choice.reuseBranch },
      });
    } else if (choice.baseBranch) {
      // `new` forks from the picked base; null means current HEAD.
      await setFeatureSetting.mutateAsync({
        id: featureId,
        data: { key: "worktree_base_branch", value: choice.baseBranch },
      });
    }
    await setFeatureSetting.mutateAsync({
      id: featureId,
      data: { key: "worktree_mode", value: choice.backendMode },
    });
  } catch (err) {
    const message = apiErrorMessage(
      err,
      translateUi("conversation.worktreeSendHelpers.unknownError", "Unknown error"),
    );
    toast.error(
      translateUi(
        "conversation.worktree-send-helpers.couldNotSaveWorktreeSettings",
        "Could not save worktree settings: {{message}}",
        { message },
      ),
    );
    throw err;
  }
}
