import { translateUi } from "@/lib/i18n/ui";
import { useCallback } from "react";
import { type CommitBody, useCommit } from "@/api/generated";
import { selectCommitStatus, useCommitOutputStore } from "@/stores/useCommitOutputStore";
import {
  useGitOutputSubmission,
  type GitOutputSubmissionController,
  type GitOutputSubmissionCopy,
} from "./useGitOutputSubmission";

interface UseCommitSubmissionOptions {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export type CommitSubmissionController = GitOutputSubmissionController<CommitBody>;

function submissionCopy(): GitOutputSubmissionCopy {
  return {
    failure: translateUi("workspace.git.useCommitSubmission.commitFailed", "Commit failed"),
    failureHint: translateUi(
      "workspace.git.useCommitSubmission.openTheCommitOutputToInspectThe",
      "Open the commit output to inspect the pre-commit error.",
    ),
    success: translateUi("workspace.git.useCommitSubmission.committed", "Committed"),
    backgroundSuccess: translateUi(
      "workspace.git.useCommitSubmission.backgroundCommitCompleted",
      "Background commit completed",
    ),
  };
}

export function useCommitSubmission({
  featureId,
  open,
  onOpenChange,
}: UseCommitSubmissionOptions): CommitSubmissionController {
  const commit = useCommit();
  const run = useCallback((body: CommitBody) => commit.mutateAsync({ data: body }), [commit]);

  return useGitOutputSubmission<CommitBody>({
    featureId,
    open,
    onOpenChange,
    useStore: useCommitOutputStore,
    selectStatus: selectCommitStatus,
    isPending: commit.isPending,
    run,
    copy: submissionCopy,
  });
}
