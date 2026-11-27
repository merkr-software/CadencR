import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement, ReactNode } from "react";
import { AlertTriangleIcon, GitBranchIcon, Trash2Icon } from "lucide-react";
import { CleanupOption } from "@/components/CleanupOption";
import { apiErrorMessage } from "@/lib/api-errors";

interface ArchiveCleanupOptionsProps {
  showWorktreeRemoval: boolean;
  showBranchRemoval: boolean;
  removeWorktree: boolean;
  removeBranch: boolean;
  hasLiveWorktree: boolean;
  branchRemovalDisabled: boolean;
  noWorktreeBranchMode: boolean;
  isCheckingBranchRemovalSafety: boolean;
  isRemovingDefaultBranch: boolean;
  defaultBranch: string;
  isRemovingTargetBranch: boolean;
  branchCheckReady: boolean;
  branchName: string;
  targetBranch: string;
  forceBranchDelete: boolean;
  forceWorktreeDelete: boolean;
  hasResidualWorktreeDirectory: boolean;
  isCheckingWorktree: boolean;
  isCheckingBranch: boolean;
  gitStatusError: unknown;
  branchCheckError: unknown;
  toggleWorktree: () => void;
  toggleBranch: () => void;
}

export function ArchiveCleanupOptions(props: ArchiveCleanupOptionsProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="space-y-3">
      {props.showWorktreeRemoval && (
        <CleanupOption
          checked={props.removeWorktree}
          disabled={props.removeBranch && props.hasLiveWorktree}
          icon={<Trash2Icon className="size-4" />}
          label={t("conversation.archiveCleanupOptions.removeWorktree", "Remove worktree")}
          shortcut="W"
          description={t(
            "conversation.archiveCleanupOptions.deleteTheRelatedWorktreeFolderWithoutDeleting",
            "Delete the related worktree folder without deleting the branch.",
          )}
          onCheckedChange={props.toggleWorktree}
        />
      )}
      {props.showBranchRemoval && (
        <CleanupOption
          checked={props.removeBranch}
          disabled={props.branchRemovalDisabled}
          icon={<GitBranchIcon className="size-4" />}
          label={t("conversation.archiveCleanupOptions.removeBranch", "Remove branch")}
          shortcut="B"
          description={
            props.noWorktreeBranchMode
              ? t(
                  "conversation.archiveCleanupOptions.checkoutTheTargetBranchThenDeleteThe",
                  "Checkout the target branch, then delete the current branch.",
                )
              : t(
                  "conversation.archiveCleanupOptions.deleteTheFeatureBranchAfterTheWorktree",
                  "Delete the feature branch after the worktree is removed.",
                )
          }
          onCheckedChange={props.toggleBranch}
        />
      )}
      <ArchiveCleanupMessages {...props} />
    </div>
  );
}

function ArchiveCleanupMessages(props: ArchiveCleanupOptionsProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <>
      {props.isCheckingBranchRemovalSafety && (
        <p className="text-xs text-muted-foreground">
          {t(
            "conversation.archiveCleanupOptions.checkingBranchRemovalSafety",
            "Checking branch removal safety…",
          )}
        </p>
      )}
      {props.isRemovingDefaultBranch && (
        <DangerMessage>
          <UiTrans
            i18nKey="conversation.archiveCleanupOptions.cannotRemoveDefaultBranch"
            defaults="Cannot remove the default branch <branch>{{branch}}</branch>."
            values={{ branch: props.defaultBranch }}
            components={{ branch: <span className="font-mono" /> }}
          />
        </DangerMessage>
      )}
      {!props.isRemovingDefaultBranch && props.isRemovingTargetBranch && (
        <DangerMessage>
          {t(
            "conversation.archiveCleanupOptions.cannotRemoveTheTargetBranch",
            "Cannot remove the target branch.",
          )}
        </DangerMessage>
      )}
      {props.removeBranch &&
        props.noWorktreeBranchMode &&
        !props.isRemovingTargetBranch &&
        !props.isRemovingDefaultBranch &&
        props.branchCheckReady && (
          <p className="text-xs text-muted-foreground">
            {t(
              "conversation.archiveCleanupOptions.checkoutBeforeDeleting",
              "Cadencr will checkout {{target}} before deleting {{branch}}.",
              { target: props.targetBranch, branch: props.branchName },
            )}
          </p>
        )}
      {props.forceBranchDelete && (
        <DangerMessage>
          <UiTrans
            i18nKey="conversation.archiveCleanupOptions.forceDeleteUnmergedBranch"
            defaults="Branch <branch>{{branch}}</branch> is not merged into <target>{{target}}</target>. Confirming will force-delete it."
            values={{ branch: props.branchName, target: props.targetBranch }}
            components={{
              branch: <span className="font-mono" />,
              target: <span className="font-mono" />,
            }}
          />
        </DangerMessage>
      )}
      {props.forceWorktreeDelete && props.hasResidualWorktreeDirectory && (
        <DangerMessage>
          {t(
            "conversation.archiveCleanupOptions.gitNoLongerRecognizesThisWorktreeBut",
            "Git no longer recognizes this worktree, but files remain in its folder. Confirming will permanently delete those residual files.",
          )}
        </DangerMessage>
      )}
      {props.forceWorktreeDelete && !props.hasResidualWorktreeDirectory && (
        <DangerMessage>
          {t(
            "conversation.archiveCleanupOptions.thisWorktreeHasUncommittedOrUntrackedFiles",
            "This worktree has uncommitted or untracked files. Confirming will force-remove it, so you will permanently lose local changes in that worktree.",
          )}
        </DangerMessage>
      )}
      <ArchiveCleanupStatusMessages {...props} />
    </>
  );
}

function ArchiveCleanupStatusMessages(props: ArchiveCleanupOptionsProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <>
      {props.isCheckingWorktree && (
        <p className="text-xs text-muted-foreground">
          {t(
            "conversation.archiveCleanupOptions.checkingWorktreeStatus",
            "Checking worktree status…",
          )}
        </p>
      )}
      {props.gitStatusError != null && (
        <p className="text-xs text-destructive">
          {apiErrorMessage(
            props.gitStatusError,
            t(
              "conversation.archiveCleanupOptions.couldNotCheckWorktreeStatus",
              "Could not check worktree status",
            ),
          )}
        </p>
      )}
      {props.isCheckingBranch && (
        <p className="text-xs text-muted-foreground">
          {t(
            "conversation.archiveCleanupOptions.checkingBranchMergeStatus",
            "Checking branch merge status…",
          )}
        </p>
      )}
      {props.branchCheckError != null && (
        <p className="text-xs text-destructive">
          {apiErrorMessage(
            props.branchCheckError,
            t(
              "conversation.archiveCleanupOptions.couldNotCheckBranchMergeStatus",
              "Could not check branch merge status",
            ),
          )}
        </p>
      )}
    </>
  );
}

function DangerMessage({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
