import { useUiTranslation } from "@/lib/i18n/ui";
import { lazy, Suspense, type ReactElement } from "react";
import { Loader2 } from "lucide-react";

import type { GitStatusSnapshot } from "@/api/generated";
import type { GitAction } from "./useGitAction";
import type { CommitSubmissionController } from "./useCommitSubmission";
import type { PushSubmissionController } from "./usePushSubmission";

const CommitDialog = lazy(() => import("./CommitDialog"));
const StashChangesDialog = lazy(() => import("./StashChangesDialog"));
const PushDialog = lazy(() => import("./PushDialog"));
const MergeDialog = lazy(() => import("./MergeDialog"));
const UpdateBranchDialog = lazy(() => import("./UpdateBranchDialog"));

export type GitActionDialog = Exclude<GitAction, "pr"> | null;

export interface GitActionDialogsProps {
  activeDialog: GitActionDialog;
  featureId: number;
  snapshot: GitStatusSnapshot | undefined;
  updateDisabledReason: string | null;
  commitSubmission: CommitSubmissionController;
  pushSubmission: PushSubmissionController;
  onOpenChange: (open: boolean) => void;
}

/** Controlled sibling-dialog outlet for every Git action picker dialog. */
export function GitActionDialogs({
  activeDialog,
  featureId,
  snapshot,
  updateDisabledReason,
  commitSubmission,
  pushSubmission,
  onOpenChange,
}: GitActionDialogsProps): ReactElement {
  return (
    <Suspense fallback={<GitActionDialogLoading />}>
      {activeDialog === "commit" && (
        <CommitDialog featureId={featureId} open submission={commitSubmission} />
      )}
      {activeDialog === "stash" && (
        <StashChangesDialog featureId={featureId} open onOpenChange={onOpenChange} />
      )}
      {activeDialog === "push" && (
        <PushDialog featureId={featureId} open submission={pushSubmission} />
      )}
      {activeDialog === "merge" && (
        <MergeDialog featureId={featureId} open onOpenChange={onOpenChange} />
      )}
      {activeDialog === "update" && snapshot && (
        <UpdateBranchDialog
          featureId={featureId}
          open
          snapshot={snapshot}
          disabledReason={updateDisabledReason}
          onOpenChange={onOpenChange}
        />
      )}
    </Suspense>
  );
}

function GitActionDialogLoading(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md border border-border bg-background px-4 py-3 text-sm shadow-lg"
    >
      <Loader2 className="size-4 animate-spin" />
      {t("workspace.git.gitActionDialogs.loadingGitAction", "Loading Git action…")}
    </div>
  );
}
