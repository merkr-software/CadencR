import { memo, useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { FeatureRowBody } from "@/components/FeatureRowBody";
import { ProjectBadge } from "@/components/ProjectBadge";
import { FeatureHierarchyGutter } from "@/components/FeatureHierarchyGutter";
import { openFeatureRowOnKey } from "@/components/ProjectFeatureRow";
import type { NextActionKind } from "@/lib/next-actions";
import type { SampleRow } from "@/lib/sidebar-sample-views";
import type { Attention } from "@/lib/sidebar-attention";
import { cn } from "@/lib/utils";

interface SidebarSampleRowProps {
  row: SampleRow;
  /** Block rows lead with their project's color, tree rows with their nesting. */
  variant: "block" | "tree";
  isActive: boolean;
  onSelect: (featureId: number) => void;
  depth?: number;
  hierarchyControl?: ReactNode;
  /** A collapsed parent shows its most urgent child's state: the child it comes from. */
  foldedSource?: SampleRow;
  /** A "For me" sample names what to do next under its title. */
  nextAction?: NextActionKind;
}

/**
 * A display options preview row: the very {@link FeatureRowBody} the sidebar
 * renders, in the same shells as `PinnedConversationRow` and
 * `ProjectFeatureRow`, fed from a sample instead of stores. Clicking it only
 * makes it the open one; it has no hover actions or context menu.
 */
export const SidebarSampleRow = memo(function SidebarSampleRow({
  row,
  variant,
  isActive,
  onSelect,
  depth = 0,
  hierarchyControl,
  foldedSource,
  nextAction,
}: SidebarSampleRowProps): ReactElement {
  const { conversation } = row;
  const { feature } = conversation;
  const source = foldedSource ?? row;
  const attention = useMemo<Attention>(
    () => ({ state: source.state, sourceFeatureId: source.conversation.feature.id }),
    [source],
  );
  const select = useCallback(() => onSelect(feature.id), [feature.id, onSelect]);
  return (
    <div
      role="button"
      tabIndex={0}
      data-sidebar-flash-target
      data-sidebar-sample-row
      className={cn(
        "sidebar-row relative flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent",
        variant === "block" ? "pl-2 pr-1.5" : "px-1.5",
        isActive && "bg-sidebar-accent",
      )}
      onClick={select}
      onKeyDown={(event) => openFeatureRowOnKey(event, select)}
    >
      {variant === "block" ? (
        <span className="flex h-6 shrink-0 items-center self-start">
          <ProjectBadge projectId={feature.project_id} />
        </span>
      ) : (
        <FeatureHierarchyGutter depth={depth}>{hierarchyControl}</FeatureHierarchyGutter>
      )}
      <FeatureRowBody
        feature={feature}
        liveTitle={undefined}
        isAutoNaming={false}
        isArchived={false}
        hasWorktree={conversation.worktree !== undefined}
        worktree={conversation.worktree}
        attention={attention}
        isActive={isActive}
        onOpenConversation={select}
        nextAction={nextAction}
        prStatus={conversation.prStatus}
        gitStats={conversation.gitStats}
        shellCount={conversation.shellCount}
        browserCount={conversation.browserCount}
        downloadCount={0}
        ports={conversation.ports}
        onOpenPort={select}
      />
    </div>
  );
});
