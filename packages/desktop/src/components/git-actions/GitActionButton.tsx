import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";

import { selectGitStatus, useGitStatusStore } from "@/stores/useGitStatusStore";
import { getCompareUrl, type GitStatusSnapshot } from "@/api/generated";
import { useIsMobile } from "@/hooks/useIsMobile";
import { toastError } from "@/lib/api-errors";
import { openExternalUrl } from "@/lib/open-external";
import {
  isActivityAction,
  useGitAction,
  type GitAction,
  type GitActionState,
  type GitActivities,
  type GitActivity,
} from "./useGitAction";
import { useCommitSubmission } from "./useCommitSubmission";
import { usePushSubmission } from "./usePushSubmission";
import { useGitUpdatePending } from "./useGitUpdatePending";
import { GitActionDialogs, type GitActionDialog } from "./GitActionDialogs";
import { GitActionControls } from "./GitActionControls";
import { useGitActionShortcuts } from "./useGitActionShortcuts";
import { useStashMutationCoordinator } from "../diff/useStashMutationCoordinator";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";

interface GitActionButtonProps {
  featureId: number;
  projectId: number;
}

function useOpenCompare(
  featureId: number,
  compareUrl: string | null | undefined,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    let url = compareUrl ?? null;
    if (!url) {
      try {
        const response = await getCompareUrl({ feature_id: featureId });
        if (response.available) url = response.url;
      } catch (error) {
        toastError(error, "Failed to resolve compare URL.");
        return;
      }
    }
    if (!url) {
      toast.error("Compare URL not available for this remote.");
      return;
    }
    await openExternalUrl(url, "Couldn't open compare URL.");
  }, [compareUrl, featureId]);
}

function useGitActionButtonState(featureId: number): {
  snapshot: GitStatusSnapshot | undefined;
  state: GitActionState;
  prUrl: string | undefined;
  getStashMutationBlockedReason: () => string | null;
} {
  const snapshot = useGitStatusStore(selectGitStatus(featureId));
  const pr = usePrStatusStore(selectPrStatus(featureId))?.pr ?? undefined;
  const updatePending = useGitUpdatePending(featureId);
  const { blockedReason: stashBlockedReason, getBlockedReason: getStashMutationBlockedReason } =
    useStashMutationCoordinator(featureId);
  const state = useGitAction(snapshot, updatePending, stashBlockedReason, pr);
  return useMemo(
    () => ({ snapshot, state, prUrl: pr?.url, getStashMutationBlockedReason }),
    [getStashMutationBlockedReason, pr?.url, snapshot, state],
  );
}

/** Submitting ⇒ running; a failed run stays discoverable until dismissed. */
function toActivity(submitting: boolean, outcome: "success" | "error" | null): GitActivity {
  if (submitting) return "running";
  return outcome === "error" ? "failed" : null;
}

export const GitActionButton = memo(function GitActionButton({
  featureId,
  projectId,
}: GitActionButtonProps): ReactElement | null {
  const { snapshot, state, prUrl, getStashMutationBlockedReason } =
    useGitActionButtonState(featureId);
  const isMobile = useIsMobile();
  const [activeDialog, setActiveDialog] = useState<GitActionDialog>(null);
  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setActiveDialog(null);
  }, []);

  // Both submissions live here, above the dialogs, so closing a dialog
  // backgrounds its run instead of cancelling it.
  const commitSubmission = useCommitSubmission({
    featureId,
    open: activeDialog === "commit",
    onOpenChange: handleDialogOpenChange,
  });
  const pushSubmission = usePushSubmission({
    featureId,
    open: activeDialog === "push",
    onOpenChange: handleDialogOpenChange,
  });
  const activities: GitActivities = useMemo(
    () => ({
      commit: toActivity(commitSubmission.submitting, commitSubmission.outcome),
      push: toActivity(pushSubmission.submitting, pushSubmission.outcome),
    }),
    [
      commitSubmission.outcome,
      commitSubmission.submitting,
      pushSubmission.outcome,
      pushSubmission.submitting,
    ],
  );

  const [popoverOpen, setPopoverOpen] = useState(false);
  const openCommit = useCallback(() => setActiveDialog("commit"), []);
  const openPush = useCallback(() => setActiveDialog("push"), []);
  const openPopover = useCallback(() => setPopoverOpen(true), []);
  const runOpenCompare = useOpenCompare(featureId, prUrl ?? snapshot?.compare_url);

  const runAction = useCallback(
    (action: GitAction) => {
      setPopoverOpen(false);
      // A backgrounded run always wins: the row means "show me that run",
      // even when the snapshot would otherwise disable the action.
      if (isActivityAction(action) && activities[action]) {
        setActiveDialog(action);
        return;
      }
      if (state.disabled[action] !== null) return;
      if (action === "stash") {
        const blockedReason = getStashMutationBlockedReason();
        if (blockedReason) {
          toast.error("Cannot stash changes", { description: blockedReason });
          return;
        }
      }
      if (action === "pr") void runOpenCompare();
      else setActiveDialog(action);
    },
    [activities, getStashMutationBlockedReason, state.disabled, runOpenCompare],
  );

  useGitActionShortcuts({
    state,
    activities,
    openCommit,
    openPush,
    openCompare: runOpenCompare,
    openPopover,
  });

  return (
    <>
      <GitActionControls
        featureId={featureId}
        projectId={projectId}
        isMobile={isMobile}
        checkedOut={snapshot?.current_branch || undefined}
        state={state}
        activities={activities}
        popoverOpen={popoverOpen}
        onPopoverOpenChange={setPopoverOpen}
        onAction={runAction}
      />
      <GitActionDialogs
        activeDialog={activeDialog}
        featureId={featureId}
        snapshot={snapshot}
        updateDisabledReason={state.disabled.update}
        commitSubmission={commitSubmission}
        pushSubmission={pushSubmission}
        onOpenChange={handleDialogOpenChange}
      />
    </>
  );
});
