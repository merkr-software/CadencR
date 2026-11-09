import type { ReactElement } from "react";
import { ArchiveFeatureDialog } from "@/components/ArchiveFeatureDialog";
import type { ArchiveFeatureOptions } from "@/hooks/useArchiveFeatureAction";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { useFeatureArchiveConfirmation } from "@/components/useFeatureArchiveConfirmation";
import { deleteFeatureDialogTitle } from "@/lib/feature-archive-decision";

interface FeatureArchiveDialogsProps {
  projectId: number;
  /** The conversation being archived (or deleted, once archived); null when none. */
  confirmFeatureId: number | null;
  confirmation: ReturnType<typeof useFeatureArchiveConfirmation>;
  onClose: () => void;
  onArchive: (featureId: number, options: ArchiveFeatureOptions) => Promise<unknown>;
  onDelete: (featureId: number) => void;
}

/**
 * The archive dialog of an active conversation and the delete confirmation of
 * an archived one, whichever the confirmation settled on. Shared by the
 * project tree and the rows above it, so archiving reads the same everywhere.
 */
export function FeatureArchiveDialogs({
  projectId,
  confirmFeatureId,
  confirmation,
  onClose,
  onArchive,
  onDelete,
}: FeatureArchiveDialogsProps): ReactElement {
  const onOpenChange = (open: boolean): void => {
    if (!open) onClose();
  };
  return (
    <>
      <ArchiveFeatureDialog
        open={confirmFeatureId != null && confirmation.action === "archive"}
        feature={confirmation.feature}
        projectId={projectId}
        hasLiveWorktree={confirmation.cleanup.hasLiveWorktree}
        hasResidualWorktreeDirectory={confirmation.cleanup.hasResidualWorktreeDirectory}
        showWorktreeRemoval={confirmation.cleanup.showWorktreeRemoval}
        showBranchRemoval={confirmation.cleanup.showBranchRemoval}
        onOpenChange={onOpenChange}
        onArchive={onArchive}
      />
      <ConfirmDialog
        open={confirmFeatureId != null && confirmation.action === "delete"}
        onOpenChange={onOpenChange}
        title={deleteFeatureDialogTitle(confirmation.feature)}
        description="This cannot be undone."
        confirmText="Delete"
        variant="destructive"
        onConfirm={() => {
          if (confirmFeatureId != null) onDelete(confirmFeatureId);
        }}
      />
    </>
  );
}
