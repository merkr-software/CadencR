import { ChevronDown, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarDisplayOptionsButton } from "@/components/SidebarDisplayOptionsPopover";
import { HOVER_REVEAL_CLASS, SECTION_DIVIDER_CLASS } from "@/components/SidebarBlock";
import type { SectionFold, SectionReorder } from "@/hooks/useSidebarSections";
import { SidebarLensMenu } from "@/components/SidebarLensMenu";
import { cn } from "@/lib/utils";

interface SidebarProjectsHeaderProps {
  onAddProject: () => void;
  isAddingProject: boolean;
  canAddProject: boolean;
  /** Omitted when there is nothing to re-sort (projects sorted live or by name, or not shown). */
  onRefresh?: () => void;
  isRefreshing: boolean;
  /** Folds the list away under its header, like the blocks. */
  fold: SectionFold;
  /** Dragging the header moves the list among the sidebar's sections. */
  dragHandle: SectionReorder["handle"];
}

/**
 * "Projects" sidebar header: section label plus the display options, the
 * add-project and re-sort (manual refresh) actions. Refresh re-adopts the backend's
 * most-recent-user-message ordering for projects (see `useOrderedProjects`).
 */
export function SidebarProjectsHeader({
  onAddProject,
  isAddingProject,
  canAddProject,
  onRefresh,
  isRefreshing,
  fold,
  dragHandle,
}: SidebarProjectsHeaderProps) {
  return (
    <div
      {...dragHandle}
      className={cn("group flex items-center justify-between px-2", SECTION_DIVIDER_CLASS)}
    >
      <SidebarLensMenu />
      <div className="flex items-center gap-0.5">
        <SidebarDisplayOptionsButton section="projects" className={HOVER_REVEAL_CLASS} />
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onRefresh}
            disabled={isRefreshing}
            title="Re-sort projects"
            aria-label="Re-sort projects"
            className={HOVER_REVEAL_CLASS}
          >
            <RefreshCw className={isRefreshing ? "animate-spin" : undefined} />
          </Button>
        )}
        {canAddProject ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onAddProject}
            disabled={isAddingProject}
            title="Add project"
            aria-label="Add project"
            className={HOVER_REVEAL_CLASS}
          >
            <Plus />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          data-nav-item
          onClick={fold.toggle}
          aria-expanded={fold.expanded}
          title={fold.expanded ? "Collapse projects" : "Expand projects"}
          aria-label={fold.expanded ? "Collapse projects" : "Expand projects"}
          className="text-foreground/65 hover:text-foreground"
        >
          {fold.expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </Button>
      </div>
    </div>
  );
}
