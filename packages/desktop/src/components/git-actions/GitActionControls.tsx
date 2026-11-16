/**
 * The split primary/menu control, in its desktop and mobile shapes.
 *
 * Whenever a commit or push is streaming in the background the primary
 * slot is replaced by an activity button that reopens that run's dialog —
 * the only way back into output the user chose to background.
 */
import { memo, type ReactElement } from "react";
import { CircleAlert, ChevronDown, GitBranch, GitCommit, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { cn } from "@/lib/utils";
import { gitActionIcon } from "./GitActionPopover";
import { GitActionPopoverContent } from "./GitActionPopoverContent";
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
  isMobile: boolean;
  /**
   * The directory's checkout. Phones have no room for the header's branch chip
   * (it moves into the popover), so their trigger names the branch instead of
   * "Git" — the header always says what is checked out.
   */
  checkedOut: string | undefined;
  state: GitActionState;
  activities: GitActivities;
  popoverOpen: boolean;
  onPopoverOpenChange: (open: boolean) => void;
  onAction: (action: GitAction) => void;
}

export function GitActionControls(props: GitActionControlsProps): ReactElement {
  if (props.isMobile) return <MobileGitActionControl {...props} />;
  return <DesktopGitActionControl {...props} />;
}

function MobileGitActionControl({
  featureId,
  projectId,
  checkedOut,
  state,
  activities,
  popoverOpen,
  onPopoverOpenChange,
  onAction,
}: GitActionControlsProps): ReactElement {
  const active = activeGitActivity(activities);
  if (active) {
    return (
      <div className="inline-flex items-center">
        <GitActivityButton
          action={active.action}
          activity={active.activity}
          onSelect={onAction}
          className="rounded-r-none border-r-0"
        />
        <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className={`${GIT_ACTION_BUTTON_CLASS} rounded-l-none px-1.5`}
              aria-label="More git actions"
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <GitActionPopoverContent
              featureId={featureId}
              projectId={projectId}
              state={state}
              activities={activities}
              onPick={onAction}
            />
          </PopoverContent>
        </Popover>
      </div>
    );
  }
  return (
    <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className={`${GIT_ACTION_BUTTON_CLASS} min-w-0`}
          aria-label={checkedOut ? `Git actions, on ${checkedOut}` : "Git actions"}
        >
          <GitBranch className="size-3.5" />
          {checkedOut ? (
            <span className="max-w-24 truncate font-mono">{checkedOut}</span>
          ) : (
            <span>Git</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <GitActionPopoverContent
          featureId={featureId}
          projectId={projectId}
          state={state}
          activities={activities}
          onPick={onAction}
        />
      </PopoverContent>
    </Popover>
  );
}

function DesktopGitActionControl({
  featureId,
  projectId,
  state,
  activities,
  popoverOpen,
  onPopoverOpenChange,
  onAction,
}: GitActionControlsProps): ReactElement {
  const gitActionsKeys = useShortcutKeys("git-actions");
  const active = activeGitActivity(activities);
  const primaryAction = active?.action ?? state.primary;
  const PrimaryIcon = state.updatePending
    ? Loader2
    : primaryAction
      ? gitActionIcon(primaryAction)
      : GitCommit;
  const primaryDisabled = primaryAction === null;
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
          onClick={() => primaryAction && onAction(primaryAction)}
          title={primaryDisabled ? (state.disabled.commit ?? state.label) : state.label}
          aria-live="polite"
        >
          <PrimaryIcon className={state.updatePending ? "size-3.5 animate-spin" : "size-3.5"} />
          <span>{state.label}</span>
        </Button>
      )}
      <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
        <ShortcutTooltip label="Git actions" keys={gitActionsKeys}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className={`${GIT_ACTION_BUTTON_CLASS} rounded-l-none px-1.5`}
              aria-label="More git actions"
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
  const running = activity === "running";
  return (
    <Button
      variant="outline"
      size="xs"
      className={cn(GIT_ACTION_BUTTON_CLASS, className)}
      onClick={() => onSelect(action)}
      aria-live="polite"
      title={gitActivityHint(action, activity)}
    >
      {running ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <CircleAlert className="size-3.5 text-destructive" />
      )}
      <span className={running ? undefined : "text-destructive"}>
        {gitActivityLabel(action, activity)}
      </span>
    </Button>
  );
});
