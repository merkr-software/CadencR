import { memo, useMemo, type ReactElement } from "react";

import { BranchChip } from "@/components/branch-chip/BranchChip";
import { Button } from "@/components/ui/button";
import { GitActionPopover, type GitUpdateRecoveryControls } from "./GitActionPopover";
import type { GitAction, GitActionState, GitActivities } from "./useGitAction";
import { useGitUpdateRecoveryActions } from "./useGitUpdateRecoveryActions";

export interface GitStatusRetry {
  pending: boolean;
  run: () => void;
  issue?: { label: string; detail: string };
}

export const REFRESHING_GIT_STATUS = "Refreshing Git status…";

interface GitActionPopoverContentProps {
  featureId: number;
  projectId: number;
  state: GitActionState;
  activities?: GitActivities;
  statusRetry: GitStatusRetry;
  onPick: (action: GitAction) => void;
}

export const GitActionPopoverContent = memo(function GitActionPopoverContent(
  props: GitActionPopoverContentProps,
): ReactElement {
  return (
    <>
      <div className="border-b border-border px-3 py-2">
        <BranchChip featureId={props.featureId} projectId={props.projectId} />
      </div>
      {props.statusRetry.issue && (
        <div className="space-y-2 border-b border-border px-3 py-2">
          <p className="whitespace-pre-line break-words text-xs text-destructive" role="status">
            {props.statusRetry.issue.label}. {props.statusRetry.issue.detail}
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={props.statusRetry.pending}
            onClick={props.statusRetry.run}
          >
            {props.statusRetry.pending ? REFRESHING_GIT_STATUS : "Retry Git status"}
          </Button>
        </div>
      )}
      <RecoveryAwareGitActionPopover {...props} />
    </>
  );
});

function RecoveryAwareGitActionPopover(props: GitActionPopoverContentProps): ReactElement {
  if (!props.state.recovery) {
    return (
      <GitActionPopover state={props.state} activities={props.activities} onPick={props.onPick} />
    );
  }
  return <GitActionRecoveryPopover {...props} recovery={props.state.recovery} />;
}

function GitActionRecoveryPopover({
  featureId,
  state,
  activities,
  onPick,
  recovery,
}: GitActionPopoverContentProps & {
  recovery: NonNullable<GitActionState["recovery"]>;
}): ReactElement {
  const actions = useGitUpdateRecoveryActions({
    featureId,
    operation: recovery.operation,
    conflictCount: recovery.conflictCount,
  });
  const recoveryControls = useMemo<GitUpdateRecoveryControls>(
    () => ({
      pendingAction: actions.pendingAction,
      error: actions.error,
      onContinue: actions.continueUpdate,
      onAbort: actions.abortUpdate,
    }),
    [actions.abortUpdate, actions.continueUpdate, actions.error, actions.pendingAction],
  );
  return (
    <GitActionPopover
      state={state}
      activities={activities}
      onPick={onPick}
      recoveryControls={recoveryControls}
    />
  );
}
