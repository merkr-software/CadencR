import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";

import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import {
  selectGitStatus,
  selectGitStatusHealth,
  selectGitWorktreeError,
  useGitStatusStore,
} from "@/stores/useGitStatusStore";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { getCompareUrl, getGetGitStatusQueryKey, type GitStatusSnapshot } from "@/api/generated";
import { toastError, WORKTREE_UNAVAILABLE, worktreeUnavailableMessage } from "@/lib/api-errors";
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
import type { GitActionDialog, GitActionDialogsProps } from "./GitActionDialogs";
import type { GitStatusRetry } from "./GitActionPopoverContent";
import { useGitActionShortcuts } from "./useGitActionShortcuts";
import { useStashMutationCoordinator } from "../diff/useStashMutationCoordinator";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";

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
  const { t } = useUiTranslation();
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
      ? {
          label: t("workspace.git.status.liveUpdatesUnavailable", "Git live updates unavailable"),
          detail: health.watcherError,
        }
      : undefined;
    if (!health?.statusError) return { run, pending, issue: watch };
    const unavailable = health.statusErrorCode === WORKTREE_UNAVAILABLE;
    const label = unavailable
      ? t("workspace.git.status.worktreeUnavailable", "Worktree unavailable")
      : t("workspace.git.status.unavailable", "Git status unavailable");
    const statusDetail = unavailable ? worktreeUnavailableMessage(t) : health.statusError;
    const detail = watch
      ? `${statusDetail}\n${t("workspace.git.status.issueWithDetail", "{{label}}. {{detail}}", watch)}`
      : statusDetail;
    return { run, pending, issue: { label, detail } };
  }, [health, pending, run, t]);
}

/** Submitting ⇒ running; a failed run stays discoverable until dismissed. */
function toActivity(submitting: boolean, outcome: "success" | "error" | null): GitActivity {
  if (submitting) return "running";
  return outcome === "error" ? "failed" : null;
}

export interface GitActionController {
  snapshot: GitStatusSnapshot | undefined;
  state: GitActionState;
  activities: GitActivities;
  /** Git status or live updates failed: what to say, and how to retry. */
  statusRetry: GitStatusRetry;
  /** The action picker (the desktop popover, the phone's conversation sheet). */
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  /**
   * Runs an action from the picker: closes it, then opens the action's dialog.
   * True when a dialog opened (not for a blocked action, nor the PR link), so a
   * picker knows whether focus is handed to that dialog.
   */
  runAction: (action: GitAction) => boolean;
  dialogs: GitActionDialogsProps;
}

/**
 * Both submissions live above the dialogs, so closing a dialog backgrounds its
 * run instead of cancelling it. A worktree that is gone shows no run.
 */
function useGitSubmissions(
  featureId: number,
  activeDialog: GitActionDialog,
  onOpenChange: (open: boolean) => void,
  worktreeError: unknown,
) {
  const commitSubmission = useCommitSubmission({
    featureId,
    open: activeDialog === "commit",
    onOpenChange,
  });
  const pushSubmission = usePushSubmission({
    featureId,
    open: activeDialog === "push",
    onOpenChange,
  });
  const hidden = Boolean(worktreeError);
  const activities: GitActivities = useMemo(
    () => ({
      commit: hidden ? null : toActivity(commitSubmission.submitting, commitSubmission.outcome),
      push: hidden ? null : toActivity(pushSubmission.submitting, pushSubmission.outcome),
    }),
    [
      commitSubmission.outcome,
      commitSubmission.submitting,
      hidden,
      pushSubmission.outcome,
      pushSubmission.submitting,
    ],
  );
  return { commitSubmission, pushSubmission, activities };
}

/**
 * Everything a Git actions control needs, apart from its trigger: the derived
 * state, the background runs, the picker's open state, the dialogs' props and
 * the shortcuts. The dialogs must render outside the picker, so closing the
 * picker (or a dialog) backgrounds a run instead of cancelling it.
 */
export function useGitActionController(featureId: number): GitActionController {
  const { snapshot, state, prUrl, getStashMutationBlockedReason } =
    useGitActionButtonState(featureId);
  const worktreeError = useGitStatusStore(selectGitWorktreeError(featureId));
  const statusRetry = useGitStatusRetry(featureId);
  const [activeDialog, setActiveDialog] = useState<GitActionDialog>(null);
  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setActiveDialog(null);
  }, []);

  const { commitSubmission, pushSubmission, activities } = useGitSubmissions(
    featureId,
    activeDialog,
    handleDialogOpenChange,
    worktreeError,
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const openCommit = useCallback(() => setActiveDialog("commit"), []);
  const openPush = useCallback(() => setActiveDialog("push"), []);
  const openPicker = useCallback(() => setPickerOpen(true), []);
  const runOpenCompare = useOpenCompare(featureId, prUrl ?? snapshot?.compare_url);

  const runAction = useCallback(
    (action: GitAction): boolean => {
      setPickerOpen(false);
      // A backgrounded run always wins: the row means "show me that run",
      // even when the snapshot would otherwise disable the action.
      if (isActivityAction(action) && activities[action]) {
        setActiveDialog(action);
        return true;
      }
      if (state.disabled[action] !== null) return false;
      if (action === "stash") {
        const blockedReason = getStashMutationBlockedReason();
        if (blockedReason) {
          toast.error(
            translateUi("workspace.git.gitActionButton.cannotStashChanges", "Cannot stash changes"),
            { description: blockedReason },
          );
          return false;
        }
      }
      if (action === "pr") {
        void runOpenCompare();
        return false;
      }
      setActiveDialog(action);
      return true;
    },
    [activities, getStashMutationBlockedReason, state.disabled, runOpenCompare],
  );

  useGitActionShortcuts({
    state,
    activities,
    openCommit,
    openPush,
    openCompare: runOpenCompare,
    openPopover: openPicker,
  });

  const dialogs = useMemo<GitActionDialogsProps>(
    () => ({
      activeDialog: worktreeError ? null : activeDialog,
      featureId,
      snapshot,
      updateDisabledReason: state.disabled.update,
      commitSubmission,
      pushSubmission,
      onOpenChange: handleDialogOpenChange,
    }),
    [
      activeDialog,
      commitSubmission,
      featureId,
      handleDialogOpenChange,
      pushSubmission,
      snapshot,
      state.disabled.update,
      worktreeError,
    ],
  );
  return useMemo(
    () => ({
      snapshot,
      state,
      activities,
      statusRetry,
      pickerOpen,
      setPickerOpen,
      runAction,
      dialogs,
    }),
    [activities, dialogs, pickerOpen, runAction, snapshot, state, statusRetry],
  );
}
