import { translateUi } from "@/lib/i18n/ui";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";

import {
  selectGitStatus,
  selectGitStatusHealth,
  selectGitWorktreeError,
  useGitStatusStore,
} from "@/stores/useGitStatusStore";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { getCompareUrl, getGetGitStatusQueryKey, type GitStatusSnapshot } from "@/api/generated";
import { useIsMobile } from "@/hooks/useIsMobile";
import { toastError, WORKTREE_UNAVAILABLE } from "@/lib/api-errors";
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
import type { GitStatusRetry } from "./GitActionPopoverContent";
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
        toastError(
          error,
          translateUi(
            "workspace.git.gitActionButton.failedToResolveCompareUrl",
            "Failed to resolve compare URL.",
          ),
        );
        return;
      }
    }
    if (!url) {
      toast.error(
        translateUi(
          "workspace.git.gitActionButton.compareUrlNotAvailableForThisRemote",
          "Compare URL not available for this remote.",
        ),
      );
      return;
    }
    await openExternalUrl(
      url,
      translateUi(
        "workspace.git.gitActionButton.couldnTOpenCompareUrl",
        "Couldn't open compare URL.",
      ),
    );
  }, [compareUrl, featureId]);
}

function useGitActionButtonState(featureId: number): {
  snapshot: GitStatusSnapshot | undefined;
  state: GitActionState;
  prUrl: string | undefined;
  getStashMutationBlockedReason: () => string | null;
} {
  const snapshot = useGitStatusStore(selectGitStatus(featureId));
  const statusError = useGitStatusStore((state) => state.healthByFeature[featureId]?.statusError);
  const pr = usePrStatusStore(selectPrStatus(featureId))?.pr ?? undefined;
  const updatePending = useGitUpdatePending(featureId);
  const { blockedReason: stashBlockedReason, getBlockedReason: getStashMutationBlockedReason } =
    useStashMutationCoordinator(featureId);
  const state = useGitAction(snapshot, {
    updatePending,
    stashMutationBlockedReason: stashBlockedReason,
    existingPr: pr,
    statusError,
  });
  return useMemo(
    () => ({ snapshot, state, prUrl: pr?.url, getStashMutationBlockedReason }),
    [getStashMutationBlockedReason, pr?.url, snapshot, state],
  );
}

function useGitStatusRetry(featureId: number): GitStatusRetry {
  const queryClient = useQueryClient();
  const health = useGitStatusStore(selectGitStatusHealth(featureId));
  const queryKey = useMemo(() => getGetGitStatusQueryKey({ feature_id: featureId }), [featureId]);
  const isFetching = useIsFetching({ queryKey, exact: true }) > 0;
  const isConnected = useSessionStatusStore((state) => state.isConnected);
  const subscribing = useGitStatusStore(
    (state) => state.subscriptionByFeature[featureId] === "pending",
  );
  const run = useCallback((): void => {
    const socket = useSessionStatusStore.getState();
    const git = useGitStatusStore.getState();
    if (socket.isConnected) {
      git.bumpWatcherEpoch(featureId);
    } else {
      void queryClient.refetchQueries({ queryKey, exact: true, type: "active" });
      const health = git.healthByFeature[featureId];
      if (health?.watcherError || health?.statusErrorCode === WORKTREE_UNAVAILABLE)
        socket.connect();
    }
  }, [featureId, queryClient, queryKey]);
  const pending = subscribing || (!isConnected && isFetching);
  return useMemo(() => {
    const watch = health?.watcherError
      ? { label: "Git live updates unavailable", detail: health.watcherError }
      : undefined;
    const issue = health?.statusError
      ? {
          label:
            health.statusErrorCode === WORKTREE_UNAVAILABLE
              ? "Worktree unavailable"
              : "Git status unavailable",
          detail: watch
            ? `${health.statusError}\n${watch.label}. ${watch.detail}`
            : health.statusError,
        }
      : watch;
    return { run, pending, issue };
  }, [health, pending, run]);
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
  const worktreeError = useGitStatusStore(selectGitWorktreeError(featureId));
  const isMobile = useIsMobile();
  const statusRetry = useGitStatusRetry(featureId);
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
    () =>
      worktreeError
        ? { commit: null, push: null }
        : {
            commit: toActivity(commitSubmission.submitting, commitSubmission.outcome),
            push: toActivity(pushSubmission.submitting, pushSubmission.outcome),
          },
    [
      commitSubmission.outcome,
      commitSubmission.submitting,
      pushSubmission.outcome,
      pushSubmission.submitting,
      worktreeError,
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
          toast.error(
            translateUi("workspace.git.gitActionButton.cannotStashChanges", "Cannot stash changes"),
            { description: blockedReason },
          );
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
        statusRetry={statusRetry}
        popoverOpen={popoverOpen}
        onPopoverOpenChange={setPopoverOpen}
        onAction={runAction}
      />
      <GitActionDialogs
        activeDialog={worktreeError ? null : activeDialog}
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
