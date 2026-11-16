import { memo, useState, type ReactNode } from "react";
import { useProjectColor } from "@/hooks/useProjectColor";
import { useProjectIconUrl } from "@/hooks/useProjectIcon";
import { cn } from "@/lib/utils";

/**
 * Badge sizes.
 *
 * An icon is drawn larger than the dot it replaces: the accent dots are 6–10px,
 * where a logo would be an illegible smudge. Roughly doubling gives the mark
 * enough room to read. Note this does widen the row slightly when a project
 * switches from a dot to an icon — accepted, since an unreadable logo defeats
 * the point of choosing one.
 */
const BADGE_SIZES = {
  xs: { dot: "size-1.5", icon: "size-3.5" },
  sm: { dot: "size-2", icon: "size-4" },
  md: { dot: "size-2.5", icon: "size-5" },
} as const;

export type ProjectBadgeSize = keyof typeof BADGE_SIZES;

/**
 * A project's visual identifier: its logo when one is configured, otherwise the
 * accent color dot.
 *
 * Rendered in the sidebar, top bar, and several pickers, so it is memoized and
 * leans on the shared `staleTime: Infinity` project-settings query rather than
 * fetching per instance. A configured-but-unreadable icon (file deleted or
 * moved) falls back to the dot silently — reporting it from every mount would
 * spam identical toasts; Project Settings surfaces the broken path instead.
 * `fallback` replaces the dot when there is no logo.
 */
export const ProjectBadge = memo(function ProjectBadge({
  projectId,
  size = "sm",
  className,
  fallback,
}: {
  projectId: number;
  size?: ProjectBadgeSize;
  className?: string;
  fallback?: ReactNode;
}): ReactNode {
  const color = useProjectColor(projectId);
  const iconUrl = useProjectIconUrl(projectId);
  // Track *which* URL failed rather than a boolean, so choosing a new icon
  // after a broken one retries instead of staying stuck on the dot.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const sizes = BADGE_SIZES[size];

  if (iconUrl && failedUrl !== iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        // Decorative: every call site pairs the badge with the project name.
        aria-hidden
        onError={() => setFailedUrl(iconUrl)}
        className={cn(sizes.icon, "shrink-0 rounded-sm object-contain", className)}
      />
    );
  }
  if (fallback !== undefined) return fallback;

  return (
    <span
      className={cn(sizes.dot, "shrink-0 rounded-full", className)}
      style={{ backgroundColor: `#${color}` }}
    />
  );
});
