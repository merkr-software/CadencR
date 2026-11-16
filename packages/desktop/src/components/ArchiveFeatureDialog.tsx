import type { KeyboardEvent, ReactElement } from "react";
import type { Feature } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { KbdShortcut } from "@/components/KbdShortcut";
import { ArchiveCleanupOptions } from "@/components/ArchiveCleanupOptions";
import { KillTerminalsOption } from "@/components/KillTerminalsOption";
import { useKillTerminalsState } from "@/components/use-kill-terminals-state";
import { useArchiveCleanupState } from "@/components/archive-cleanup-state";
import { useArchiveRelativeOptions } from "@/components/ArchiveRelativeOptions";
import type { ArchiveFeatureOptions } from "@/hooks/useArchiveFeatureAction";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import {
  useArchiveSubmission,
  useConfirmSubmissionLock,
} from "@/components/archive-feature-submission";

const SUBMIT_KEYS: string[] = ["cmd", "enter"];

interface ArchiveFeatureDialogProps {
  open: boolean;
  feature: Feature | undefined;
  projectId: number;
  hasLiveWorktree: boolean;
  hasResidualWorktreeDirectory: boolean;
  showWorktreeRemoval: boolean;
  showBranchRemoval: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (featureId: number, options: ArchiveFeatureOptions) => void;
}

export function ArchiveFeatureDialog({
  open,
  feature,
  projectId,
  hasLiveWorktree,
  hasResidualWorktreeDirectory,
  showWorktreeRemoval,
  showBranchRemoval,
  onOpenChange,
  onArchive,
}: ArchiveFeatureDialogProps): ReactElement {
  const confirmationLock = useConfirmSubmissionLock(open);
  const killState = useKillTerminalsState(open, feature, { includeBrowserTabs: true });
  const cleanupState = useArchiveCleanupState({
    open,
    feature,
    projectId,
    hasLiveWorktree,
    hasResidualWorktreeDirectory,
    showWorktreeRemoval,
    showBranchRemoval,
  });
  const relativeState = useArchiveRelativeOptions({
    open,
    featureId: feature?.id,
    disabled: confirmationLock.isConfirming,
  });
  const submission = useArchiveSubmission({
    feature,
    onArchive,
    onOpenChange,
    cleanupState,
    killState,
    relativeState,
    confirmationLock,
  });
  useDialogSubmitShortcut({
    open,
    enabled:
      !cleanupState.isCheckingBranch &&
      !cleanupState.isCheckingWorktree &&
      !relativeState.isPending &&
      !submission.isConfirming,
    onSubmit: submission.confirm,
  });
  const requestOpenChange = (nextOpen: boolean): void => {
    if (!submission.isConfirming) onOpenChange(nextOpen);
  };
  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onKeyDown={(event) =>
          handleCleanupShortcut(
            event,
            cleanupState,
            killState,
            relativeState,
            submission.isConfirming,
          )
        }
      >
        <ArchiveDialogHeader />
        <ArchiveOptionsList
          killState={killState}
          relativeState={relativeState}
          cleanupState={cleanupState}
          hasLiveWorktree={hasLiveWorktree}
          hasResidualWorktreeDirectory={hasResidualWorktreeDirectory}
        />
        <ArchiveDialogFooter
          forceDelete={cleanupState.forceBranchDelete || cleanupState.forceWorktreeDelete}
          disabled={
            cleanupState.isCheckingBranch ||
            cleanupState.isCheckingWorktree ||
            relativeState.isPending ||
            submission.isConfirming
          }
          onCancel={() => requestOpenChange(false)}
          onConfirm={submission.confirm}
        />
      </DialogContent>
    </Dialog>
  );
}

function ArchiveOptionsList(props: {
  killState: ReturnType<typeof useKillTerminalsState>;
  relativeState: ReturnType<typeof useArchiveRelativeOptions>;
  cleanupState: ReturnType<typeof useArchiveCleanupState>;
  hasLiveWorktree: boolean;
  hasResidualWorktreeDirectory: boolean;
}): ReactElement {
  return (
    <div className="space-y-3">
      {props.killState.liveTerminalCount + props.killState.liveBrowserCount > 0 && (
        <KillTerminalsOption
          count={props.killState.liveTerminalCount}
          browserCount={props.killState.liveBrowserCount}
          checked={props.killState.killTerminals}
          onToggle={props.killState.toggleKillTerminals}
        />
      )}
      {props.relativeState.content}
      <ArchiveCleanupOptions
        {...props.cleanupState}
        hasLiveWorktree={props.hasLiveWorktree}
        hasResidualWorktreeDirectory={props.hasResidualWorktreeDirectory}
      />
    </div>
  );
}

function ArchiveDialogHeader(): ReactElement {
  return (
    <DialogHeader>
      <DialogTitle>Archive session?</DialogTitle>
      <DialogDescription>
        Archive now, optionally cleaning up its terminals, worktree or branch. An interrupted
        cleanup can be resumed later.
      </DialogDescription>
    </DialogHeader>
  );
}

function handleCleanupShortcut(
  event: KeyboardEvent,
  cleanupState: ReturnType<typeof useArchiveCleanupState>,
  killState: ReturnType<typeof useKillTerminalsState>,
  relativeState: ReturnType<typeof useArchiveRelativeOptions>,
  isConfirming: boolean,
): void {
  if (isConfirming || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    return;
  const action = {
    w: cleanupState.toggleWorktree,
    b: cleanupState.toggleBranch,
    t: killState.toggleKillTerminals,
    p: relativeState.toggleParent,
    c: relativeState.toggleDescendants,
  }[event.key.toLowerCase()];
  if (!action) return;
  event.preventDefault();
  action();
}

interface ArchiveDialogFooterProps {
  disabled: boolean;
  forceDelete: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ArchiveDialogFooter(props: ArchiveDialogFooterProps): ReactElement {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={props.onCancel}>
        Cancel
      </Button>
      <Button
        variant={props.forceDelete ? "destructive" : "default"}
        disabled={props.disabled}
        onClick={props.onConfirm}
      >
        <span>{props.forceDelete ? "Archive & force delete" : "Archive"}</span>
        <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
      </Button>
    </DialogFooter>
  );
}
