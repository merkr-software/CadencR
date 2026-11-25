import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  useAbortUpdateBranch,
  useContinueUpdateBranch,
  type GitOperationKind,
  type GitOperationResponse,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { describeGitUpdateConflictFiles } from "./gitUpdateMessages";
import { gitUpdateMutationKey, useGitUpdatePending } from "./useGitUpdatePending";

export type GitUpdateControlAction = "continue" | "abort";

interface UseGitUpdateRecoveryActionsOptions {
  featureId: number;
  operation: GitOperationKind | null;
  conflictCount: number;
}

export interface GitUpdateRecoveryActions {
  pending: boolean;
  pendingAction: GitUpdateControlAction | null;
  error: string | null;
  continueUpdate: () => Promise<void>;
  abortUpdate: () => Promise<void>;
}

export function useGitUpdateRecoveryActions({
  featureId,
  operation,
  conflictCount,
}: UseGitUpdateRecoveryActionsOptions): GitUpdateRecoveryActions {
  const mutation = { mutationKey: gitUpdateMutationKey(featureId) };
  const { mutateAsync: continueBranch, isPending: continuePending } = useContinueUpdateBranch({
    mutation,
  });
  const { mutateAsync: abortBranch, isPending: abortPending } = useAbortUpdateBranch({ mutation });
  const pending = useGitUpdatePending(featureId);
  const [error, setError] = useState<string | null>(null);

  const handleResponse = useCallback(
    (result: GitOperationResponse, action: GitUpdateControlAction): void => {
      if (!operation) return;
      if (result.outcome === "conflicts") {
        toast.warning(
          translateUi(
            "workspace.git.useGitUpdateRecoveryActions.updatePausedForConflicts",
            "Update paused for conflicts",
          ),
          {
            description: describeGitUpdateConflictFiles(result.conflict_files),
          },
        );
        return;
      }
      toast.success(
        action === "abort"
          ? translateUi("workspace.git.useGitUpdateRecoveryActions.updateAborted", "Update aborted")
          : translateUi(
              "workspace.git.useGitUpdateRecoveryActions.updateCompleted",
              "Update completed",
            ),
      );
    },
    [operation],
  );

  const continueUpdate = useCallback(async (): Promise<void> => {
    if (!operation || pending || conflictCount > 0) return;
    setError(null);
    try {
      const result = await continueBranch({ data: { feature_id: featureId } });
      handleResponse(result, "continue");
    } catch (caught) {
      const message = apiErrorMessage(
        caught,
        translateUi(
          "workspace.git.useGitUpdateRecoveryActions.couldNotContinueTheUpdateDetail",
          "Could not continue the update.",
        ),
      );
      setError(message);
      toast.error(
        translateUi(
          "workspace.git.useGitUpdateRecoveryActions.couldNotContinueTheUpdate",
          "Could not continue the update",
        ),
        { description: message },
      );
    }
  }, [conflictCount, continueBranch, featureId, handleResponse, operation, pending]);

  const abortUpdate = useCallback(async (): Promise<void> => {
    if (!operation || pending) return;
    setError(null);
    try {
      const result = await abortBranch({ data: { feature_id: featureId } });
      handleResponse(result, "abort");
    } catch (caught) {
      const message = apiErrorMessage(
        caught,
        translateUi(
          "workspace.git.useGitUpdateRecoveryActions.couldNotAbortTheUpdateDetail",
          "Could not abort the update.",
        ),
      );
      setError(message);
      toast.error(
        translateUi(
          "workspace.git.useGitUpdateRecoveryActions.couldNotAbortTheUpdate",
          "Could not abort the update",
        ),
        { description: message },
      );
    }
  }, [abortBranch, featureId, handleResponse, operation, pending]);

  const pendingAction = continuePending ? "continue" : abortPending ? "abort" : null;

  return useMemo(
    () => ({ pending, pendingAction, error, continueUpdate, abortUpdate }),
    [abortUpdate, continueUpdate, error, pending, pendingAction],
  );
}
