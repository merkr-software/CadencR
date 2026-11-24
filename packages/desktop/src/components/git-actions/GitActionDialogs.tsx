import type { ReactElement } from "react";

import type { GitStatusSnapshot } from "@/api/generated";
import { LazyBoundary } from "@/components/lazy/LazyBoundary";
import { lazyChunk } from "@/components/lazy/lazy-chunk";
import type { GitAction } from "./useGitAction";
import type { CommitSubmissionController } from "./useCommitSubmission";
import type { PushSubmissionController } from "./usePushSubmission";

const CommitDialog = lazyChunk(() => import("./CommitDialog").then((module) => module.default));
const StashChangesDialog = lazyChunk(() =>
  import("./StashChangesDialog").then((module) => module.default),
);
const PushDialog = lazyChunk(() => import("./PushDialog").then((module) => module.default));
const MergeDialog = lazyChunk(() => import("./MergeDialog").then((module) => module.default));
const UpdateBranchDialog = lazyChunk(() =>
  import("./UpdateBranchDialog").then((module) => module.default),
);

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
}: GitActionDialogsProps): ReactElement | null {
  if (activeDialog === null) return null;
  return (
    // Keyed by dialog: a failure shown for one is gone once it is dismissed.
    <LazyBoundary
      key={activeDialog}
      label="Git action"
      variant="overlay"
      onDismiss={() => onOpenChange(false)}
    >
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
    </LazyBoundary>
  );
}
