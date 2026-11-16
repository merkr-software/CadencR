import type { ReactElement } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useProviderMetadata } from "@/lib/provider-icons";
import { ATTENTION_LABEL, type AttentionState } from "@/lib/sidebar-attention";
import type { DateGroup, LensGroup } from "@/lib/sidebar-lens";
import { cn } from "@/lib/utils";

/** The fill of a header copy drawn over scrolling rows (`sidebar-rows.css`). */
export const STICKY_FILL_CLASS = "sidebar-sticky-fill";

/**
 * A wrapper holding its header at the top of the scrolled sidebar (C6). The
 * header inside takes the fill only while it is stuck (`sidebar-rows.css`).
 */
export const STICKY_HEADER_CLASS = "sidebar-sticky sticky top-0 z-10";

/** A project row's box and type, shared by the tree, the lens group headers and the samples. */
export const PROJECT_ROW_CLASS =
  "sidebar-project-row relative flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-sm font-medium text-foreground/85 outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50";

const DATE_NAMES: Record<DateGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  older: "Older",
};

function ProviderName({ providerId }: { providerId: string | null }): string {
  const metadata = useProviderMetadata(providerId);
  return (providerId && metadata?.label) || providerId || "Unknown provider";
}

function GroupName({ group }: { group: LensGroup }): ReactElement | string {
  const { lens, value } = group;
  // The status and date lenses only make groups of their own fixed values.
  if (lens === "status") return ATTENTION_LABEL[value as AttentionState];
  if (lens === "date") return DATE_NAMES[value as DateGroup];
  if (lens === "provider") return <ProviderName providerId={value} />;
  if (lens === "worktree") return value ?? "Project checkout";
  if (lens === "label") return value ?? "No label";
  return "Conversations";
}

/**
 * A lens group's header, in place of a project row: folds its conversations,
 * says how many it holds. The sticky copy at the top of a scrolled list is the
 * same header.
 */
export function SidebarLensGroupHeader({
  group,
  folded,
  onToggle,
  className,
}: {
  group: LensGroup;
  folded: boolean;
  onToggle: (key: string) => void;
  className?: string;
}): ReactElement {
  return (
    <button
      type="button"
      data-sidebar-lens-header={group.key}
      aria-expanded={!folded}
      onClick={() => onToggle(group.key)}
      className={cn(PROJECT_ROW_CLASS, className)}
    >
      {folded ? (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">
        <GroupName group={group} />
      </span>
      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
        {group.features.length}
      </span>
    </button>
  );
}
