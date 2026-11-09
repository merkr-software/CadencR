import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Feature } from "@/api/generated";
import type { useArchiveCleanupState } from "@/components/archive-cleanup-state";
import type { useArchiveRelativeOptions } from "@/components/ArchiveRelativeOptions";
import { isArchivedInCachedLists } from "@/components/project-feature-navigation";
import type { useKillTerminalsState } from "@/components/use-kill-terminals-state";
import type { ArchiveFeatureOptions } from "@/hooks/useArchiveFeatureAction";

interface ConfirmationLock {
  isConfirming: boolean;
  lockConfirm: () => boolean;
  unlockConfirm: () => void;
}

interface ArchiveSubmissionArgs {
  open: boolean;
  feature: Feature | undefined;
  onArchive: (featureId: number, options: ArchiveFeatureOptions) => Promise<unknown>;
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
 * Sends the archive and its cleanup as one request: the service archives,
 * then runs and journals each step. The dialog stays on "Archiving…" until
 * the service answers with the per-step report, and shows its error inline —
 * unless the service already announced the archive (`app/archive_cleanup`)
 * before the request failed, typically because it stopped mid-cleanup: then
 * the archive is done, and retrying it from here would be misleading.
 */
export function useArchiveSubmission(args: ArchiveSubmissionArgs): {
  isConfirming: boolean;
  archiveError: unknown;
  confirm: () => void;
} {
  const [archiveError, setArchiveError] = useState<unknown>(null);
  const queryClient = useQueryClient();
  useEffect(() => setArchiveError(null), [args.open, args.feature?.id]);
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
    setArchiveError(null);
    onArchive(feature.id, archiveOptions(relativeState, killState, cleanupState)).then(
      () => onOpenChange(false),
      (error: unknown) => {
        if (isArchivedInCachedLists(queryClient, feature.id)) {
          toast.warning("Session archived, but its cleanup did not report back", {
            description:
              "The connection to the service was lost during the cleanup. Any step left unfinished will be listed for review once the service is back.",
          });
          onOpenChange(false);
          return;
        }
        setArchiveError(error);
        confirmationLock.unlockConfirm();
      },
    );
  }, [
    cleanupState,
    confirmationLock,
    feature,
    killState,
    onArchive,
    onOpenChange,
    queryClient,
    relativeState,
  ]);

  return useMemo(
    () => ({ isConfirming: confirmationLock.isConfirming, archiveError, confirm }),
    [confirmationLock.isConfirming, archiveError, confirm],
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
  const unlockConfirm = useCallback((): void => {
    isConfirmingRef.current = false;
    setIsConfirming(false);
  }, []);
  return useMemo(
    () => ({ isConfirming, lockConfirm, unlockConfirm }),
    [isConfirming, lockConfirm, unlockConfirm],
  );
}
