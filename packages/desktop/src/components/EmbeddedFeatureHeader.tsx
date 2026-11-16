import { memo, useCallback, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  EyeOffIcon,
  GitBranchIcon,
  Loader2Icon,
  PinIcon,
} from "lucide-react";
import { AgentCardStatusGlyph, AgentCardStatusText } from "@/components/UnifiedAgentCardStatus";
import { ProjectBadge } from "@/components/ProjectBadge";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { useFeatureAttention } from "@/hooks/useFeatureAttention";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import { cn } from "@/lib/utils";
import { useFeatureStatus } from "@/stores/session-status-selectors";
import type { WorktreeStatus } from "@/types/workflow";

interface EmbeddedFeatureHeaderProps {
  featureId: number;
  projectId: number;
  projectName?: string;
  title: string;
  label?: string | null;
  lastActivityAt?: string | null;
  className?: string;
  isPinned?: boolean;
  isPinPending?: boolean;
  onTogglePin?: () => void;
  onExclude?: () => void;
  worktreeStatus?: WorktreeStatus;
  worktreeBranch?: string | null;
}

/**
 * A unified-grid card's header, in two lines so nothing competes with the
 * title for width:
 *
 *   ● Title, truncated only by the card edge          [pin] [hide] [open]
 *     Project · label · ⎇                              Working | 5m ago
 *
 * The leading mark and the trailing word carry the agent's state, read from
 * the same attention model as the sidebar.
 */
export const EmbeddedFeatureHeader = memo(function EmbeddedFeatureHeader({
  featureId,
  projectId,
  projectName,
  title,
  label,
  lastActivityAt,
  className,
  isPinned = false,
  isPinPending = false,
  onTogglePin,
  onExclude,
  worktreeStatus,
  worktreeBranch,
}: EmbeddedFeatureHeaderProps): ReactElement {
  const { state } = useFeatureAttention(featureId);
  const { kind } = useFeatureStatus(featureId);
  return (
    <div
      className={cn(
        "grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b bg-background py-2 pr-1.5 pl-3",
        className,
      )}
    >
      <AgentCardStatusGlyph state={state} kind={kind} />
      <h3
        title={title}
        className="min-w-0 truncate text-[13px] leading-5 font-semibold text-foreground"
      >
        {title}
      </h3>
      <EmbeddedFeatureHeaderActions
        featureId={featureId}
        projectId={projectId}
        isPinned={isPinned}
        isPinPending={isPinPending}
        onTogglePin={onTogglePin}
        onExclude={onExclude}
      />
      <div className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 pr-1.5 text-[11px] leading-none text-muted-foreground">
        <ProjectBadge projectId={projectId} size="xs" />
        {projectName && <span className="min-w-0 truncate">{projectName}</span>}
        {label && <AgentCardLabel label={label} />}
        <WorktreeIndicator status={worktreeStatus} branch={worktreeBranch} />
        <span className="ml-auto flex shrink-0 items-center pl-2">
          <AgentCardStatusText state={state} kind={kind} lastActivityAt={lastActivityAt} />
        </span>
      </div>
    </div>
  );
});

/** A neutral tag: the label informs, it must not read as a state or a brand. */
function AgentCardLabel({ label }: { label: string }): ReactElement {
  return (
    <span
      title={label}
      className="max-w-28 shrink truncate rounded-sm border border-border/80 px-1 py-0.5 text-[10.5px] leading-none font-medium text-foreground/80"
    >
      {label}
    </span>
  );
}

interface EmbeddedFeatureHeaderActionsProps {
  featureId: number;
  projectId: number;
  isPinned: boolean;
  isPinPending: boolean;
  onTogglePin?: () => void;
  onExclude?: () => void;
}

const ACTION_BUTTON_CLASS =
  "size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent/70 hover:text-foreground";

const EmbeddedFeatureHeaderActions = memo(function EmbeddedFeatureHeaderActions({
  featureId,
  projectId,
  isPinned,
  isPinPending,
  onTogglePin,
  onExclude,
}: EmbeddedFeatureHeaderActionsProps): ReactElement {
  const handlePinClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      onTogglePin?.();
    },
    [onTogglePin],
  );
  const handleExcludeClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      onExclude?.();
    },
    [onExclude],
  );
  return (
    <div className="flex items-center">
      {onTogglePin ? (
        <ActionTooltip label={isPinned ? "Unpin agent" : "Pin agent"} shortcutId="agents-pin">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(ACTION_BUTTON_CLASS, isPinned && "text-primary hover:text-primary")}
            disabled={isPinPending}
            aria-pressed={isPinned}
            aria-label={isPinned ? "Unpin agent" : "Pin agent"}
            onClick={handlePinClick}
          >
            {isPinPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PinIcon className={cn("size-3.5", isPinned && "fill-current")} />
            )}
          </Button>
        </ActionTooltip>
      ) : null}
      {onExclude ? (
        <ActionTooltip label="Hide from this view" shortcutId="agents-hide">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={ACTION_BUTTON_CLASS}
            aria-label="Hide agent from this view"
            onClick={handleExcludeClick}
          >
            <EyeOffIcon className="size-3.5" />
          </Button>
        </ActionTooltip>
      ) : null}
      <ActionTooltip label="Open feature page" shortcutId="agents-open-feature">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className={ACTION_BUTTON_CLASS}
          onClick={(event) => event.stopPropagation()}
        >
          <Link
            to="/projects/$projectId/features/$featureId"
            params={{ projectId: String(projectId), featureId: String(featureId) }}
            aria-label="Open feature page"
          >
            <ArrowUpRightIcon className="size-3.5" />
          </Link>
        </Button>
      </ActionTooltip>
    </div>
  );
});

/** Tooltip showing the action's live binding, so a rebind never lies. */
function ActionTooltip({
  label,
  shortcutId,
  children,
}: {
  label: string;
  shortcutId: ShortcutId;
  children: ReactNode;
}): ReactElement {
  const keys = useShortcutKeys(shortcutId);
  return (
    <ShortcutTooltip label={label} keys={keys} alignRight>
      {children}
    </ShortcutTooltip>
  );
}

function WorktreeIndicator({
  status,
  branch,
}: {
  status?: WorktreeStatus;
  branch?: string | null;
}): ReactElement | null {
  if (!status || status === "idle") return null;
  const busy = status === "creating" || status === "setup_running";
  const Icon = status === "setup_error" ? AlertTriangleIcon : busy ? Loader2Icon : GitBranchIcon;
  const label = worktreeLabel(status, branch);
  return (
    <ShortcutTooltip label={label} className="shrink-0">
      <span
        role="img"
        aria-label={label}
        className={cn("inline-flex items-center", worktreeIndicatorClass(status))}
      >
        <Icon className={cn("size-3", busy && "animate-spin")} />
      </span>
    </ShortcutTooltip>
  );
}

function worktreeIndicatorClass(status: WorktreeStatus): string {
  if (status === "ready" || status === "created") return "text-(--acc-green)";
  if (status === "setup_error") return "text-(--acc-red)";
  return "text-(--acc-yellow)";
}

/** One wording for the tooltip and the screen reader alike. */
function worktreeLabel(status: WorktreeStatus, branch?: string | null): string {
  const suffix = branch ? ` · ${branch}` : "";
  if (status === "setup_error") return `Git worktree setup failed${suffix}`;
  if (status === "creating" || status === "setup_running") {
    return `Preparing isolated Git worktree${suffix}`;
  }
  return `Agent uses an isolated Git worktree${suffix}`;
}
