import { memo, useRef, type ReactElement } from "react";
import {
  TrashIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  BotIcon,
  GlobeIcon,
  MessageCircleQuestionIcon,
  GitBranchIcon,
  TagIcon,
  TerminalIcon,
  PinIcon,
  PinOffIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useGetStats, type Feature } from "@/api/generated";
import { FeatureLabelChip } from "@/components/FeatureLabelChip";
import { FeatureLabelEditor } from "@/components/FeatureLabelEditor";
import { NumStat } from "@/components/NumStat";
import { SidebarShortcutBadge } from "@/components/SidebarShortcutBadge";
import { closeFeatureActivityNoun } from "@/lib/feature-activity-close";
import { useFeaturePrefetch } from "@/hooks/useFeaturePrefetch";
import { useNavShortcutHint } from "@/hooks/useNavShortcutHints";
import { useFeatureStatus } from "@/stores/session-status-selectors";
import { useIsFeatureUnread } from "@/stores/unread-store";

const ROW_KEYDOWN_IGNORED_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  "[data-ignore-feature-row-keydown]",
].join(", ");

interface ProjectFeatureRowProps {
  feature: Feature;
  projectId: number;
  activeFeatureId: number | null;
  liveTitle: string | undefined;
  isAutoNaming: boolean;
  /** True when the feature has a worktree recorded in feature settings (icon). */
  hasWorktree: boolean;
  /** True only when the worktree directory still exists on disk (stats query). */
  hasLiveWorktree: boolean;
  shellCount: number;
  browserCount: number;
  isEditingLabel: boolean;
  labelDraft: string;
  labelSuggestions: readonly string[];
  isSavingLabel: boolean;
  onNavigate: (feature: Feature) => void;
  onStartLabelEdit: (feature: Feature) => void;
  onLabelDraftChange: (value: string) => void;
  onSaveLabel: (featureId: number, override?: string) => void;
  onCancelLabelEdit: () => void;
  onArchiveOrDelete: (featureId: number) => void;
  onUnarchive: (featureId: number) => void;
  onTogglePin: (featureId: number, pinned: boolean) => void;
  onCloseActivity: (featureId: number, shellCount: number, browserCount: number) => void;
}

/**
 * Memoized: rendered N times per project in the sidebar. A parent update
 * (label edit, project rename) must not re-render every row. The parent
 * passes stable callback refs and a stable `labelSuggestions` reference, so
 * default shallow-prop comparison is sufficient.
 */
export const ProjectFeatureRow = memo(function ProjectFeatureRow({
  feature,
  projectId,
  activeFeatureId,
  liveTitle,
  isAutoNaming,
  hasWorktree,
  hasLiveWorktree,
  shellCount,
  browserCount,
  isEditingLabel,
  labelDraft,
  labelSuggestions,
  isSavingLabel,
  onNavigate,
  onStartLabelEdit,
  onLabelDraftChange,
  onSaveLabel,
  onCancelLabelEdit,
  onArchiveOrDelete,
  onUnarchive,
  onTogglePin,
  onCloseActivity,
}: ProjectFeatureRowProps): ReactElement {
  const startLabelEditOnMenuCloseRef = useRef(false);
  // Live status is the canonical 3-value enum: per-session entries pushed
  // by the backend, aggregated here per-feature. `useShallow` inside the
  // hook ensures this row only re-renders when its own feature's
  // (status, kind) actually changes.
  const { status: liveStatus } = useFeatureStatus(feature.id);
  // Blue dot: the agent finished while this conversation wasn't open. Only
  // meaningful when idle — a working/asking agent already shows its own icon.
  const isUnread = useIsFeatureUnread(feature.id);
  const isActive = activeFeatureId === feature.id;
  const { data: gitStats } = useGetStats(
    { feature_id: feature.id, mode: "worktree" },
    {
      query: {
        // Limit fan-out: fetch only for live worktrees or the active row (which
        // the Git tab is already fetching). Other rows reuse the cache.
        enabled: hasLiveWorktree || isActive,
        refetchInterval: 5 * 60 * 1000,
        retry: false,
      },
    },
  );

  const prefetchFeature = useFeaturePrefetch(feature.id, projectId);
  const { navRef, badgeRef } = useNavShortcutHint<HTMLDivElement>();
  const hasStats = gitStats != null && (gitStats.insertions > 0 || gitStats.deletions > 0);
  const hasLabel = !!feature.label;
  const hasActivity = shellCount > 0 || browserCount > 0;
  const showMetaLine = isEditingLabel || hasLabel || hasStats || hasActivity;
  const isArchived = feature.status === "archived";
  const isPinned = feature.is_pinned;
  const archiveActionLabel = isArchived ? "Delete" : "Archive";
  const pinActionLabel = isPinned ? "Unpin" : "Pin";
  const markStartLabelEditAfterMenuClose = (): void => {
    startLabelEditOnMenuCloseRef.current = true;
  };

  const handleMenuCloseAutoFocus = (event: Event): void => {
    if (!startLabelEditOnMenuCloseRef.current) return;
    startLabelEditOnMenuCloseRef.current = false;
    event.preventDefault();
    onStartLabelEdit(feature);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={navRef}
          role="button"
          tabIndex={0}
          data-nav-item
          data-nav-type="feature"
          data-nav-id={String(feature.id)}
          data-nav-project-id={String(projectId)}
          className={`group/feature relative flex min-w-0 cursor-pointer items-center gap-1 rounded-md py-1.5 pl-3 pr-1.5 text-sm outline-none hover:bg-accent ${
            activeFeatureId === feature.id ? "bg-accent" : ""
          } ${isArchived ? "opacity-50" : ""}`}
          onClick={(e) => {
            if (isActive || e.detail > 1) return;
            onNavigate(feature);
          }}
          onMouseEnter={prefetchFeature}
          onFocus={prefetchFeature}
          onKeyDown={(e) => {
            if (shouldIgnoreFeatureRowKeyDown(e.target)) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onNavigate(feature);
            }
          }}
        >
          <SidebarShortcutBadge ref={badgeRef} />

          {/* Live status icon driven by the per-session backend store. */}
          <div className="flex shrink-0 w-3.5 items-center justify-center">
            {liveStatus === "agent" && <BotIcon className="size-3.5 text-blue-500 animate-pulse" />}
            {liveStatus === "question" && (
              <MessageCircleQuestionIcon className="size-3.5 text-amber-400" />
            )}
            {liveStatus === "idle" && isUnread && (
              <span
                className="size-2 rounded-full bg-blue-500"
                aria-label="Unread agent messages"
              />
            )}
          </div>

          {/* Name + optional metadata sub-line (stats) */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 items-center gap-1.5">
              {hasWorktree && (
                <GitBranchIcon
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label="Has worktree"
                />
              )}
              {isAutoNaming ? (
                <Skeleton className="h-4 w-32 min-w-0" />
              ) : (
                <span className={`min-w-0 truncate ${isArchived ? "text-muted-foreground" : ""}`}>
                  {liveTitle ?? feature.title}
                </span>
              )}
            </div>
            {showMetaLine && (
              <div
                data-feature-meta-line
                className="flex min-w-0 items-center gap-2 text-[11px] leading-tight"
              >
                {isEditingLabel ? (
                  <FeatureLabelEditor
                    value={labelDraft}
                    suggestions={labelSuggestions}
                    isSaving={isSavingLabel}
                    trigger={
                      feature.label ? (
                        <FeatureLabelChip label={feature.label} />
                      ) : (
                        <span className="rounded border border-dashed border-border px-1.5 py-0 font-mono text-[10.5px] leading-4 text-muted-foreground">
                          Set label
                        </span>
                      )
                    }
                    onChange={onLabelDraftChange}
                    onSave={(override) => onSaveLabel(feature.id, override)}
                    onCancel={onCancelLabelEdit}
                  />
                ) : (
                  <FeatureLabelChip label={feature.label} />
                )}
                {hasStats && (
                  <NumStat
                    additions={gitStats.insertions}
                    deletions={gitStats.deletions}
                    className="text-[11px] leading-tight"
                  />
                )}
                <FeatureActivityIndicators shellCount={shellCount} browserCount={browserCount} />
              </div>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {!isArchived && (
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={isPinned}
                className={`size-6 shrink-0 p-0 hover:text-foreground transition-none ${
                  isPinned
                    ? "text-foreground"
                    : "text-muted-foreground opacity-0 group-hover/feature:opacity-100"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(feature.id, !isPinned);
                }}
              >
                {isPinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
                <span className="sr-only">{pinActionLabel}</span>
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="size-6 shrink-0 p-0 text-muted-foreground hover:text-foreground opacity-0 group-hover/feature:opacity-100 transition-none"
              onClick={(e) => {
                e.stopPropagation();
                onArchiveOrDelete(feature.id);
              }}
            >
              {isArchived ? (
                <TrashIcon className="size-3.5" />
              ) : (
                <ArchiveIcon className="size-3.5" />
              )}
              <span className="sr-only">{archiveActionLabel}</span>
            </Button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        // Open the label editor after the menu fully closes. Opening directly
        // from onSelect races with Radix's context-menu focus/pointer teardown.
        onCloseAutoFocus={handleMenuCloseAutoFocus}
      >
        <ContextMenuItem onSelect={() => onNavigate(feature)}>
          <ArrowRightIcon />
          Open
        </ContextMenuItem>
        {!isArchived && (
          <ContextMenuItem onSelect={() => onTogglePin(feature.id, !isPinned)}>
            {isPinned ? <PinOffIcon /> : <PinIcon />}
            {pinActionLabel}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={markStartLabelEditAfterMenuClose}>
          <TagIcon />
          Set label
        </ContextMenuItem>
        {hasActivity && (
          <ContextMenuItem onSelect={() => onCloseActivity(feature.id, shellCount, browserCount)}>
            <XIcon />
            {`Close ${closeFeatureActivityNoun(shellCount, browserCount)}`}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {isArchived && (
          <ContextMenuItem onSelect={() => onUnarchive(feature.id)}>
            <ArchiveRestoreIcon />
            Unarchive
          </ContextMenuItem>
        )}
        <ContextMenuItem variant="destructive" onSelect={() => onArchiveOrDelete(feature.id)}>
          {isArchived ? <TrashIcon /> : <ArchiveIcon />}
          {archiveActionLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

function FeatureActivityIndicators({
  shellCount,
  browserCount,
}: {
  shellCount: number;
  browserCount: number;
}): ReactElement | null {
  if (shellCount <= 0 && browserCount <= 0) return null;
  return (
    <span data-feature-activity-indicators className="inline-flex shrink-0 items-center gap-1">
      <FeatureActivityBadge
        count={shellCount}
        labelSingular="shell command running"
        labelPlural="shell commands running"
        icon={<TerminalIcon className="size-3" />}
      />
      <FeatureActivityBadge
        count={browserCount}
        labelSingular="browser tab open"
        labelPlural="browser tabs open"
        icon={<GlobeIcon className="size-3" />}
      />
    </span>
  );
}

function FeatureActivityBadge({
  count,
  labelSingular,
  labelPlural,
  icon,
}: {
  count: number;
  labelSingular: string;
  labelPlural: string;
  icon: ReactElement;
}): ReactElement | null {
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? labelSingular : labelPlural}`;
  return (
    <Badge
      variant="outline"
      aria-label={label}
      title={label}
      className="h-5 gap-0.5 rounded border-border/60 bg-background/40 px-1 font-mono text-[10px] leading-none text-muted-foreground"
    >
      {icon}
      <span>{count}</span>
    </Badge>
  );
}

export function shouldIgnoreFeatureRowKeyDown(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(ROW_KEYDOWN_IGNORED_SELECTOR) !== null;
}
