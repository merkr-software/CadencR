import type { ReactElement, ReactNode, RefObject } from "react";
import { GitBranchIcon } from "lucide-react";
import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarStatusIndicator } from "@/components/SidebarStatusIndicator";
import { SidebarShortcutBadge } from "@/components/SidebarShortcutBadge";
import { SidebarProviderBadge } from "@/components/SidebarProviderBadge";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { parseUTCDateTime } from "@/lib/date-utils";
import { getFileName } from "@/lib/file-language";
import type { SidebarConfig } from "@/lib/sidebar-config";
import type { Attention } from "@/lib/sidebar-attention";
import {
  formatSidebarAbsoluteTime,
  formatSidebarFullTime,
  formatSidebarRelativeTime,
} from "@/lib/sidebar-time";
import { cn } from "@/lib/utils";
import { useSidebarOption } from "@/stores/sidebar-config-store";

/**
 * The text a row leads with. Branch and folder come from the conversation's own
 * worktree; a conversation working in the project checkout has no folder of its
 * own, so it keeps its title.
 */
export function rowTitle(
  title: string,
  worktree: FeatureWorktreeInfo | undefined,
  source: SidebarConfig["titleSource"],
): string {
  if (source === "branch") return worktree?.worktree_branch || title;
  if (source === "folder" && worktree && !worktree.is_main_worktree) {
    return getFileName(worktree.worktree_path) || title;
  }
  return title;
}

/**
 * First line: status, optional worktree marker, title, then the hover actions,
 * the time they replace, and a trailing mono provider. A skeleton holds the
 * title while auto-naming. `details` (uniform rows) follow the title on the
 * same line: what doesn't fit beside it wraps onto a clipped second line, so
 * the row keeps one line's height.
 */
export function FeatureRowTitleLine({
  feature,
  liveTitle,
  isAutoNaming,
  isArchived,
  hasWorktree,
  worktree,
  attention,
  isActive,
  onOpenConversation,
  badgeRef,
  details,
  children,
}: {
  feature: Feature;
  liveTitle: string | undefined;
  isAutoNaming: boolean;
  isArchived: boolean;
  hasWorktree: boolean;
  worktree: FeatureWorktreeInfo | undefined;
  attention: Attention;
  isActive: boolean;
  onOpenConversation: () => void;
  badgeRef?: RefObject<HTMLSpanElement | null>;
  details?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  const showWorktreeIcon = useSidebarOption("worktreeIcon");
  const titleSource = useSidebarOption("titleSource");
  const conversationTitle = liveTitle ?? feature.title;
  const title = rowTitle(conversationTitle, worktree, titleSource);
  // Idle conversations step back; the ones that are working, waiting, failed
  // or unread (and the open one) keep full contrast.
  const tone: TitleTone = isArchived
    ? "archived"
    : !isActive && attention.state === "idle"
      ? "quiet"
      : "normal";
  return (
    <div data-feature-title-line className="flex min-h-6 min-w-0 flex-1 items-center gap-1.5">
      <SidebarStatusIndicator
        attention={attention}
        isActive={isActive}
        onOpenConversation={onOpenConversation}
      />
      {hasWorktree && showWorktreeIcon && (
        <GitBranchIcon
          data-feature-worktree-icon
          className="size-3 shrink-0 text-muted-foreground"
          aria-label="Has worktree"
        />
      )}
      {details ? (
        <div
          data-feature-title-fold
          className="flex h-6 min-w-8 flex-1 flex-wrap content-start items-center gap-x-2 overflow-clip"
        >
          {/* At least 6rem of title before any detail; it takes what they leave.
              A full 24px line, so whatever wraps lands below the clip. `min-w-8`
              on the fold: the trailing time never squeezes the title out. */}
          <RowTitle
            title={title}
            conversationTitle={conversationTitle}
            isAutoNaming={isAutoNaming}
            tone={tone}
            className="min-w-0 shrink grow basis-24 leading-6"
          />
          {details}
        </div>
      ) : (
        // `min-w-8`: the trailing time never squeezes the title out entirely.
        <RowTitle
          title={title}
          conversationTitle={conversationTitle}
          isAutoNaming={isAutoNaming}
          tone={tone}
          className="min-w-8 flex-1"
        />
      )}
      {/* The hover actions and the time they replace. A fixed row height
          stacks them in one slot (`sidebar-row-height.css`), so the title never
          reflows on hover; otherwise they sit in the line's own flow. */}
      <span data-feature-trailing className="contents">
        {children}
        <FeatureRowTime feature={feature} />
      </span>
      <span
        data-sidebar-identity-slot
        className="relative inline-flex size-4 shrink-0 items-center justify-center"
      >
        <SidebarProviderBadge
          providerId={feature.runtime_provider}
          modelId={feature.model_session}
          thinkingEffort={feature.thinking_effort}
        />
        {badgeRef && <SidebarShortcutBadge ref={badgeRef} inline />}
      </span>
    </div>
  );
}

type TitleTone = "normal" | "quiet" | "archived";

/** The title, or a skeleton while auto-naming; names the full title when it shows another. */
function RowTitle({
  title,
  conversationTitle,
  isAutoNaming,
  tone,
  className,
}: {
  title: string;
  conversationTitle: string;
  isAutoNaming: boolean;
  tone: TitleTone;
  className: string;
}): ReactElement {
  if (isAutoNaming) return <Skeleton className={cn("h-4 w-32", className)} />;
  return (
    <span
      data-feature-title
      data-tone={tone}
      title={title === conversationTitle ? undefined : conversationTitle}
      className={cn("truncate", className)}
    >
      {title}
    </span>
  );
}

/**
 * Last activity (the sidebar's sort key), else creation. Hidden while the row
 * is hovered or focused: the row actions take its place.
 */
function FeatureRowTime({ feature }: { feature: Feature }): ReactElement | null {
  const mode = useSidebarOption("time");
  const iso = feature.last_activity_at ?? feature.created_at;
  if (mode === "none" || !iso) return null;
  return <FeatureRowTimeLabel iso={iso} mode={mode} />;
}

function FeatureRowTimeLabel({
  iso,
  mode,
}: {
  iso: string;
  mode: "relative" | "absolute";
}): ReactElement | null {
  const now = useMinuteClock();
  const date = parseUTCDateTime(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      data-feature-time
      dateTime={date.toISOString()}
      title={formatSidebarFullTime(date)}
      className="shrink-0 text-[10.5px] leading-6 tabular-nums text-muted-foreground"
    >
      {mode === "relative"
        ? formatSidebarRelativeTime(date, now)
        : formatSidebarAbsoluteTime(date, now)}
    </time>
  );
}
