import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { ChevronRightIcon, FolderGit2Icon } from "lucide-react";

import { BranchChip } from "@/components/branch-chip/BranchChip";
import { CopyButton } from "@/components/CopyButton";
import {
  missingSummary,
  WorktreeSetupBadge,
  type WorktreeSetupHeaderProps,
} from "@/components/WorktreeSetupHeader";
import { PHONE_SHEET_ROW_CLASS } from "@/components/PhoneSheet";

interface PhoneBranchSectionProps {
  featureId: number;
  projectId: number;
  /** The directory's checkout, else the worktree's branch while it is set up. */
  branch: string | null;
  worktree: WorktreeSetupHeaderProps | null;
  /** Show the worktree's setup steps and log (under the header). */
  onShowSetupDetails: () => void;
}

/**
 * What the desktop header's second line and branch chip say, for the phone's
 * conversation sheet: the checked-out branch (the chip, which opens the
 * conversation's branches) with a copy button, and the worktree's state.
 */
export function PhoneBranchSection({
  featureId,
  projectId,
  branch,
  worktree,
  onShowSetupDetails,
}: PhoneBranchSectionProps): ReactElement {
  const { t } = useUiTranslation();
  const missing = worktree?.status === "removed" ? missingSummary(worktree.branchExists, t) : null;
  return (
    <div className="flex flex-col">
      {branch && (
        <div className="flex min-h-11 min-w-0 items-center gap-1">
          <div className="flex min-w-0 flex-1">
            <BranchChip featureId={featureId} projectId={projectId} variant="row" />
          </div>
          <CopyButton
            text={branch}
            label={t("conversation.worktreeSetupHeader.copyBranchName", "Copy branch name")}
            copiedLabel={t(
              "conversation.worktreeSetupHeader.copiedBranchName",
              "Copied branch name",
            )}
            iconClassName="size-4"
            className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent"
          />
        </div>
      )}
      {worktree && (
        <button
          type="button"
          aria-expanded={worktree.isOpen}
          className={PHONE_SHEET_ROW_CLASS}
          onClick={onShowSetupDetails}
        >
          <FolderGit2Icon className="size-4 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{t("phone.header.worktree", "Worktree")}</span>
              <WorktreeSetupBadge status={worktree.status} setupError={worktree.setupError} />
            </span>
            {missing && <span className="truncate text-xs text-destructive">{missing}</span>}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {worktree.isOpen
              ? t("phone.header.hideSetup", "Hide setup")
              : t("phone.header.setupDetails", "Setup details")}
          </span>
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
