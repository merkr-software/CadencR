import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Feature } from "@/api/generated";
import type { useArchiveCleanupState } from "@/components/archive-cleanup-state";
import type { useArchiveRelativeOptions } from "@/components/ArchiveRelativeOptions";
import type { useKillTerminalsState } from "@/components/use-kill-terminals-state";
import type { ArchiveFeatureOptions } from "@/hooks/useArchiveFeatureAction";

interface ConfirmationLock {
  isConfirming: boolean;
  lockConfirm: () => boolean;
}

interface ArchiveSubmissionArgs {
  feature: Feature | undefined;
  onArchive: (featureId: number, options: ArchiveFeatureOptions) => void;
  onOpenChange: (open: boolean) => void;
  cleanupState: ReturnType<typeof useArchiveCleanupState>;
  killState: ReturnType<typeof useKillTerminalsState>;
  relativeState: ReturnType<typeof useArchiveRelativeOptions>;
  confirmationLock: ConfirmationLock;
}

/** The single archive request: relatives, then the cleanup the service runs. */
function archiveOptions(
  relativeState: Pick<ReturnType<typeof useArchiveRelativeOptions>, "selection">,
  killState: Pick<
    ReturnType<typeof useKillTerminalsState>,
    "killTerminals" | "liveTerminalCount" | "liveBrowserCount"
  >,
  cleanupState: Pick<
    ReturnType<typeof useArchiveCleanupState>,
    "removeWorktree" | "removeBranch" | "forceWorktreeDelete" | "forceBranchDelete"
  >,
): ArchiveFeatureOptions {
  return {
    ...relativeState.selection,
    kill_terminals: killState.killTerminals && killState.liveTerminalCount > 0,
    close_browser_tabs: killState.killTerminals && killState.liveBrowserCount > 0,
    remove_worktree: cleanupState.removeWorktree,
    remove_branch: cleanupState.removeBranch,
    force_remove_worktree: cleanupState.forceWorktreeDelete,
    force_remove_branch: cleanupState.forceBranchDelete,
  };
}

/**
 * Hands the archive and its cleanup to the service as one request and closes
 * the dialog at once: the service archives, then runs and journals each step,
 * and a toast follows it from there (`useArchiveFeatureAction`).
 */
export function useArchiveSubmission(args: ArchiveSubmissionArgs): {
  isConfirming: boolean;
  confirm: () => void;
} {
  const {
    feature,
    relativeState,
    cleanupState,
    killState,
    confirmationLock,
    onArchive,
    onOpenChange,
  } = args;

  const confirm = useCallback((): void => {
    if (
      !feature ||
      relativeState.isPending ||
      cleanupState.isCheckingBranch ||
      cleanupState.isCheckingWorktree ||
      !confirmationLock.lockConfirm()
    )
      return;
    onArchive(feature.id, archiveOptions(relativeState, killState, cleanupState));
    onOpenChange(false);
  }, [cleanupState, confirmationLock, feature, killState, onArchive, onOpenChange, relativeState]);

  return useMemo(
    () => ({ isConfirming: confirmationLock.isConfirming, confirm }),
    [confirmationLock.isConfirming, confirm],
  );
}

export function useConfirmSubmissionLock(open: boolean): ConfirmationLock {
  const [isConfirming, setIsConfirming] = useState(false);
  const isConfirmingRef = useRef(false);
  useEffect(() => {
    if (open) return;
    isConfirmingRef.current = false;
    setIsConfirming(false);
  }, [open]);
  const lockConfirm = useCallback((): boolean => {
    if (isConfirmingRef.current) return false;
    isConfirmingRef.current = true;
    setIsConfirming(true);
    return true;
  }, []);
  return useMemo(() => ({ isConfirming, lockConfirm }), [isConfirming, lockConfirm]);
}
