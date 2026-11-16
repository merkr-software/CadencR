import { memo, type ReactElement } from "react";
import type { ProjectAttentionCounts } from "@/hooks/useResolvedAttention";
import { cn } from "@/lib/utils";

type BadgeMode = "count" | "dot";

/** Screen-reader summary, most urgent first: "2 waiting, 1 unread". */
export function attentionSummary(counts: ProjectAttentionCounts): string {
  const parts = [
    counts.waiting > 0 && `${counts.waiting} waiting`,
    counts.failed > 0 && `${counts.failed} failed`,
    counts.working > 0 && `${counts.working} working`,
    counts.unread > 0 && `${counts.unread} unread`,
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * What a collapsed project holds, on two levels: a strong pill for what needs
 * an action (a pending request in amber, a failed turn in red), quiet marks for
 * agents at work (blue) and replies to read (green dot). "count" adds numbers,
 * "dot" keeps only the marks.
 */
export const ProjectAttentionBadges = memo(function ProjectAttentionBadges({
  counts,
  mode,
  className,
}: {
  counts: ProjectAttentionCounts | undefined;
  mode: BadgeMode;
  className?: string;
}): ReactElement | null {
  if (!counts) return null;
  const summary = attentionSummary(counts);
  if (!summary) return null;
  const withCount = mode === "count";
  return (
    <span
      data-project-attention
      role="img"
      aria-label={summary}
      title={summary}
      className={cn("flex shrink-0 items-center gap-1", className)}
    >
      <StrongBadge
        count={counts.waiting}
        withCount={withCount}
        className="bg-amber-400 ring-amber-400/30"
      />
      <StrongBadge
        count={counts.failed}
        withCount={withCount}
        className="bg-(--acc-red) ring-(--acc-red)/30"
      />
      <QuietBadge
        count={counts.working}
        withCount={withCount}
        className="text-blue-500"
        mark={<span className="sidebar-status-dot-working size-1.5 rounded-full bg-blue-500" />}
      />
      <QuietBadge
        count={counts.unread}
        withCount={withCount}
        className="text-muted-foreground"
        mark={<span className="size-1.5 rounded-full bg-(--acc-green)" />}
      />
    </span>
  );
});

function StrongBadge({
  count,
  withCount,
  className,
}: {
  count: number;
  withCount: boolean;
  className: string;
}): ReactElement | null {
  if (count === 0) return null;
  return withCount ? (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1",
        "text-[10px] font-semibold leading-none tabular-nums text-background",
        className,
      )}
    >
      {count}
    </span>
  ) : (
    <span aria-hidden className={cn("size-2 rounded-full ring-2", className)} />
  );
}

function QuietBadge({
  count,
  withCount,
  className,
  mark,
}: {
  count: number;
  withCount: boolean;
  className: string;
  mark: ReactElement;
}): ReactElement | null {
  if (count === 0) return null;
  return (
    <span
      aria-hidden
      className={cn("inline-flex items-center gap-0.5 text-[10px] tabular-nums", className)}
    >
      {mark}
      {withCount && count}
    </span>
  );
}
