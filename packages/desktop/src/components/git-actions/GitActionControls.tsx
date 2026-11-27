/**
 * The header's split primary/menu control (the phone layout reaches the same
 * actions from its conversation sheet, `PhoneFeatureMoreSheet`).
 *
 * Whenever a commit or push is streaming in the background the primary
 * slot is replaced by an activity button that reopens that run's dialog —
 * the only way back into output the user chose to background.
 */
import { memo, type ReactElement } from "react";
import { CircleAlert, ChevronDown, GitCommit, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import { gitActionIcon } from "./GitActionPopover";
import {
  GitActionPopoverContent,
  refreshingGitStatusLabel,
  retryGitStatusLabel,
  type GitStatusRetry,
} from "./GitActionPopoverContent";
import {
  activeGitActivity,
  gitActivityHint,
  gitActivityLabel,
  type ActivityAction,
  type GitAction,
  type GitActionState,
  type GitActivities,
  type GitActivity,
} from "./useGitAction";

const GIT_ACTION_BUTTON_CLASS =
  "border-border/80 bg-muted/20 text-xs text-foreground hover:bg-muted/35 disabled:opacity-100 disabled:bg-muted/20 disabled:text-muted-foreground";

export interface GitActionControlsProps {
  featureId: number;
  projectId: number;
  state: GitActionState;
  activities: GitActivities;
  statusRetry: GitStatusRetry;
  popoverOpen: boolean;
  onPopoverOpenChange: (open: boolean) => void;
  onAction: (action: GitAction) => void;
}

export function GitActionControls({
  featureId,
  projectId,
  state,
  activities,
  statusRetry,
  popoverOpen,
  onPopoverOpenChange,
  onAction,
}: GitActionControlsProps): ReactElement {
  const { t } = useUiTranslation();
  const gitActionsKeys = useShortcutKeys("git-actions");
  const active = activeGitActivity(activities);
  const primaryAction = active?.action ?? state.primary;
  const retrying = !!statusRetry.issue && statusRetry.pending;
  const spinning = retrying || state.updatePending;
  const PrimaryIcon = spinning
    ? Loader2
    : statusRetry.issue
      ? CircleAlert
      : primaryAction
        ? gitActionIcon(primaryAction)
        : GitCommit;
  const primaryDisabled = statusRetry.issue ? retrying : primaryAction === null;
  return (
    <div className="inline-flex items-center">
      {active ? (
        <GitActivityButton
          action={active.action}
          activity={active.activity}
          onSelect={onAction}
          className="rounded-r-none border-r-0"
        />
      ) : (
        <Button
          variant="outline"
          size="xs"
          className={`${GIT_ACTION_BUTTON_CLASS} rounded-r-none border-r-0`}
          disabled={primaryDisabled}
          onClick={
            statusRetry.issue ? statusRetry.run : () => primaryAction && onAction(primaryAction)
          }
          title={
            statusRetry.issue
              ? `${statusRetry.issue.detail}\n${retryGitStatusLabel(t)}`
              : primaryDisabled
                ? (state.disabled.commit ?? state.label)
                : state.label
          }
          aria-live="polite"
        >
          <PrimaryIcon
            className={cn(
              "size-3.5",
              spinning && "animate-spin",
              statusRetry.issue && !spinning && "text-destructive",
            )}
          />
          <span>
            {retrying ? refreshingGitStatusLabel(t) : (statusRetry.issue?.label ?? state.label)}
          </span>
        </Button>
      )}
      <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
        <ShortcutTooltip
          label={t("workspace.git.gitActionControls.gitActions", "Git actions")}
          keys={gitActionsKeys}
        >
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className={`${GIT_ACTION_BUTTON_CLASS} rounded-l-none px-1.5`}
              aria-label={t("workspace.git.gitActionControls.moreGitActions", "More git actions")}
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </ShortcutTooltip>
        <PopoverContent align="end" className="w-80 p-0">
          <GitActionPopoverContent
            featureId={featureId}
            projectId={projectId}
            state={state}
            activities={activities}
            statusRetry={statusRetry}
            onPick={onAction}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface GitActivityButtonProps {
  action: ActivityAction;
  activity: Exclude<GitActivity, null>;
  className?: string;
  onSelect: (action: ActivityAction) => void;
}

const GitActivityButton = memo(function GitActivityButton({
  action,
  activity,
  className,
  onSelect,
}: GitActivityButtonProps): ReactElement {
  const { t } = useUiTranslation();
  const running = activity === "running";
  return (
    <Button
      variant="outline"
      size="xs"
      className={cn(GIT_ACTION_BUTTON_CLASS, className)}
      onClick={() => onSelect(action)}
      aria-live="polite"
      title={gitActivityHint(action, activity, t)}
    >
      {running ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <CircleAlert className="size-3.5 text-destructive" />
      )}
      <span className={running ? undefined : "text-destructive"}>
        {gitActivityLabel(action, activity, t)}
      </span>
    </Button>
  );
});
