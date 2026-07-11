import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { type CommitBody, useCommit } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { selectCommitStatus, useCommitOutputStore } from "@/stores/useCommitOutputStore";
import type { GitOutputOutcome } from "@/stores/createGitOutputStore";

interface UseCommitSubmissionOptions {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface CommitSubmissionController {
  outcome: GitOutputOutcome;
  submitting: boolean;
  submit: (body: CommitBody) => Promise<void>;
  onDialogOpenChange: (open: boolean) => void;
}

export function useCommitSubmission({
  featureId,
  open,
  onOpenChange,
}: UseCommitSubmissionOptions): CommitSubmissionController {
  const commit = useCommit();
  const status = useCommitOutputStore(selectCommitStatus(featureId));
  const outcome: GitOutputOutcome = status === "success" || status === "error" ? status : null;
  const openRef = useRef(open);
  openRef.current = open;
  const submitting = commit.isPending || status === "running";

  const onDialogOpenChange = useCallback(
    (nextOpen: boolean): void => {
      openRef.current = nextOpen;
      if (!nextOpen && !submitting && outcome === "error") {
        useCommitOutputStore.getState().reset(featureId);
      }
      onOpenChange(nextOpen);
    },
    [featureId, onOpenChange, outcome, submitting],
  );

  const showBackgroundFailure = useCallback((): void => {
    toast.error("Commit failed", {
      description: "Open the commit output to inspect the pre-commit error.",
      action: { label: "View output", onClick: () => onDialogOpenChange(true) },
    });
  }, [onDialogOpenChange]);

  const submit = useCallback(
    async (body: CommitBody): Promise<void> => {
      const store = useCommitOutputStore.getState();
      if (store.byFeature[featureId]?.status === "running") {
        onDialogOpenChange(false);
        return;
      }
      store.start(featureId);
      try {
        const result = await commit.mutateAsync({ data: body });
        if (!result.success) {
          store.fail(featureId, result.error ?? "Commit failed.");
          if (!openRef.current) showBackgroundFailure();
          return;
        }
        store.complete(featureId, true);
        toast.success(openRef.current ? "Committed" : "Background commit completed");
        onDialogOpenChange(false);
      } catch (error) {
        store.fail(featureId, apiErrorMessage(error, "Commit failed."));
        if (!openRef.current) showBackgroundFailure();
      }
    },
    [commit, featureId, onDialogOpenChange, showBackgroundFailure],
  );

  return useMemo(
    () => ({ outcome, submitting, submit, onDialogOpenChange }),
    [onDialogOpenChange, outcome, submit, submitting],
  );
}
