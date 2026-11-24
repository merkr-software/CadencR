import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { Loader2, Play, Undo2 } from "lucide-react";

import { gitActionRows } from "@/components/git-actions/GitActionPopover";
import { gitUpdateActionLabel } from "@/components/git-actions/gitUpdateMessages";
import type {
  GitAction,
  GitActionState,
  GitActivities,
  GitUpdateRecoveryActionState,
} from "@/components/git-actions/useGitAction";
import { useGitUpdateRecoveryActions } from "@/components/git-actions/useGitUpdateRecoveryActions";
import { PHONE_SHEET_ROW_CLASS } from "@/components/PhoneSheet";
import { cn } from "@/lib/utils";

interface PhoneGitActionListProps {
  featureId: number;
  state: GitActionState;
  activities: GitActivities;
  onPick: (action: GitAction) => void;
}

/**
 * The Git actions of the header's picker as sheet rows: same order, labels
 * and disabled reasons (`gitActionRows`), a reason shown under its action
 * since a finger has no hover. A paused update adds its Continue / Abort.
 */
export function PhoneGitActionList({
  featureId,
  state,
  activities,
  onPick,
}: PhoneGitActionListProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <ul className="flex flex-col">
      {gitActionRows(state, activities, t).map(({ action, label, Icon, reason }) => (
        <li key={action}>
          <button
            type="button"
            disabled={reason !== null}
            className={PHONE_SHEET_ROW_CLASS}
            onClick={() => onPick(action)}
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{label}</span>
              {reason && !state.statusUnavailable && (
                <span className="truncate text-xs text-muted-foreground">{reason}</span>
              )}
            </span>
          </button>
        </li>
      ))}
      {state.recovery && <PhoneGitRecoveryRows featureId={featureId} recovery={state.recovery} />}
    </ul>
  );
}

function PhoneGitRecoveryRows({
  featureId,
  recovery,
}: {
  featureId: number;
  recovery: GitUpdateRecoveryActionState;
}): ReactElement {
  const actions = useGitUpdateRecoveryActions({
    featureId,
    operation: recovery.operation,
    conflictCount: recovery.conflictCount,
  });
  const rows = [
    {
      action: "continue" as const,
      disabled: recovery.continueDisabled,
      run: actions.continueUpdate,
      Icon: Play,
    },
    {
      action: "abort" as const,
      disabled: recovery.abortDisabled,
      run: actions.abortUpdate,
      Icon: Undo2,
    },
  ];
  return (
    <>
      {rows.map(({ action, disabled, run, Icon }) => {
        const pending = actions.pendingAction === action;
        const RowIcon = pending ? Loader2 : Icon;
        return (
          <li key={action}>
            <button
              type="button"
              disabled={disabled !== null || actions.pending}
              className={PHONE_SHEET_ROW_CLASS}
              onClick={() => void run()}
            >
              <RowIcon className={cn("size-4 shrink-0", pending && "animate-spin")} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{gitUpdateActionLabel(action, recovery.operation)}</span>
                {disabled && (
                  <span className="truncate text-xs text-muted-foreground">{disabled}</span>
                )}
              </span>
            </button>
          </li>
        );
      })}
      {actions.error && (
        <li role="alert" className="px-2 py-1.5 text-xs whitespace-pre-wrap text-destructive">
          {actions.error}
        </li>
      )}
    </>
  );
}
