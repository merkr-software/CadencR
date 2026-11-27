import { memo, useMemo, type ReactElement } from "react";

import { BranchChip } from "@/components/branch-chip/BranchChip";
import { Button } from "@/components/ui/button";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { GitActionPopover, type GitUpdateRecoveryControls } from "./GitActionPopover";
import type { GitAction, GitActionState, GitActivities } from "./useGitAction";
import { useGitUpdateRecoveryActions } from "./useGitUpdateRecoveryActions";

export interface GitStatusRetry {
  pending: boolean;
  run: () => void;
  issue?: { label: string; detail: string };
}

export function refreshingGitStatusLabel(t: UiTranslator): string {
  return t("workspace.git.status.refreshing", "Refreshing Git status…");
}

export function retryGitStatusLabel(t: UiTranslator): string {
  return t("workspace.git.status.retry", "Retry Git status");
}

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
  const { t } = useUiTranslation();
  return (
    <>
      <div className="border-b border-border px-3 py-2">
        <BranchChip featureId={props.featureId} projectId={props.projectId} />
      </div>
      {props.statusRetry.issue && (
        <div className="space-y-2 border-b border-border px-3 py-2">
          <p className="whitespace-pre-line break-words text-xs text-destructive" role="status">
            {t(
              "workspace.git.status.issueWithDetail",
              "{{label}}. {{detail}}",
              props.statusRetry.issue,
            )}
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={props.statusRetry.pending}
            onClick={props.statusRetry.run}
          >
            {props.statusRetry.pending ? refreshingGitStatusLabel(t) : retryGitStatusLabel(t)}
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
