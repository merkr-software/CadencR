import type { ReactElement, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Feature } from "@/api/generated";
import { Skeleton } from "@/components/ui/skeleton";
import { PinnedConversationRow } from "@/components/PinnedConversationRow";
import { SidebarBlock } from "@/components/SidebarBlock";
import { useCrossProjectNavigate } from "@/hooks/useCrossProjectNavigate";
import { useFeaturePorts } from "@/hooks/useFeaturePorts";
import { crossProjectRowData, usePinnedActivity } from "@/hooks/usePinnedActivity";
import type { NextActionKind } from "@/lib/next-actions";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarFilterQuery } from "@/stores/sidebar-filter-store";
import { useSidebarSectionFold } from "@/hooks/useSidebarSections";
import { SidebarSurfaceContext, type SidebarBlockSurface } from "@/stores/sidebar-surface-store";

interface SidebarConversationBlockProps {
  label: string;
  icon: LucideIcon;
  surface: SidebarBlockSurface;
  features: readonly Feature[];
  /** True while rows may still arrive: a skeleton holds the place of an empty list. */
  loading: boolean;
  /** Shown inline in place of the rows. */
  error?: string;
  empty: string;
  /** The header's counter; omitted for blocks whose size is fixed (Recent). */
  count?: number;
  strongCount?: number;
  /** Each row's next action, named under its title (For me). */
  nextActions?: ReadonlyMap<number, NextActionKind>;
  /** Under the rows, e.g. For me's "Show more". */
  footer?: ReactNode;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

/**
 * A foldable block of cross-project conversation rows (For me, In progress,
 * Recent). Hidden while the sidebar filter is on (the tree shows the matches),
 * and when empty unless empty blocks are kept. Its rows get the same worktree,
 * shell and port details as the project tree's, so a conversation shows the
 * same information in a block as anywhere else.
 */
const NO_FEATURES: readonly Feature[] = [];

export function SidebarConversationBlock({
  label,
  icon,
  surface,
  features,
  loading,
  error,
  empty,
  count,
  strongCount,
  nextActions,
  footer,
  activeFeatureId,
  onSelectFeature,
}: SidebarConversationBlockProps): ReactElement | null {
  const filtering = useSidebarFilterQuery() !== "";
  const hideEmpty = useSidebarOption("hideEmptyBlocks");
  const fold = useSidebarSectionFold(surface);
  const handleNavigate = useCrossProjectNavigate(activeFeatureId, onSelectFeature);
  // Only rows on screen need their shells and worktrees: a folded or hidden
  // block polls nothing, and shells only while the Activity detail shows.
  const showsRows = fold.expanded && !filtering;
  const showsShells = useSidebarOption("activity");
  const activity = usePinnedActivity(showsRows ? features : NO_FEATURES, showsShells);
  const portsByFeatureId = useFeaturePorts();
  const isEmpty = features.length === 0 && !loading && !error;

  if (filtering || (isEmpty && hideEmpty)) return null;
  return (
    <SidebarBlock
      block={surface}
      label={label}
      icon={icon}
      count={count}
      strongCount={strongCount}
      fold={fold}
      empty={empty}
      isEmpty={isEmpty}
      capped
    >
      {error ? (
        <p role="alert" className="px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      ) : features.length === 0 ? (
        <Skeleton aria-label={`Loading ${label}`} className="mx-2 my-1 h-5" />
      ) : (
        <SidebarSurfaceContext.Provider value={surface}>
          {features.map((feature) => (
            <PinnedConversationRow
              key={feature.id}
              feature={feature}
              activeFeatureId={activeFeatureId}
              {...crossProjectRowData(activity, portsByFeatureId, feature.id)}
              onNavigate={handleNavigate}
              nextAction={nextActions?.get(feature.id)}
            />
          ))}
          {footer}
        </SidebarSurfaceContext.Provider>
      )}
    </SidebarBlock>
  );
}
