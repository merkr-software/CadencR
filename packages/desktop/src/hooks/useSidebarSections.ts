import { useCallback, useMemo, useState, type DragEvent } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { dropPositionOf, leavesTarget } from "@/hooks/useRowReorder";
import { useSetSidebarOption } from "@/hooks/useSidebarSettings";
import { SIDEBAR_OPTIONS, type SidebarSectionId } from "@/lib/sidebar-config";
import { moveWithinGroup, type DropPosition } from "@/lib/sidebar-manual-order";
import { foldSection } from "@/lib/sidebar-sections";
import { useSidebarConfigStore, useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarFilterQuery } from "@/stores/sidebar-filter-store";

/** Whether a section shows its rows: folded ones keep only their header. */
export function useSidebarSectionExpanded(id: SidebarSectionId): boolean {
  return useSidebarConfigStore((state) => !state.config.foldedSections.includes(id));
}

/**
 * Whether a list option has loaded: until then the store holds the defaults,
 * and a list composed from them would overwrite the saved one. Says so when not.
 */
function listLoaded(queryClient: QueryClient, id: "foldedSections" | "sectionOrder"): boolean {
  const key = getGetWorkspaceSettingQueryKey(SIDEBAR_OPTIONS[id].key);
  if (queryClient.getQueryState(key)?.status === "success") return true;
  toast.error("The sidebar settings are still loading. Try again in a moment.");
  return false;
}

/** A foldable section's state and its toggle. */
export interface SectionFold {
  expanded: boolean;
  toggle: () => void;
}

const HELD_OPEN: SectionFold = { expanded: true, toggle: () => {} };

/**
 * A section's fold state and its toggle, persisted (`sidebar_folded_blocks`)
 * so a folded block stays folded across restarts and devices. The fold moves
 * once the write is saved; toggles compose from the current list, not a
 * render closure. While filtering, every section holds open (the blocks that
 * would duplicate the tree's matches hide instead): a folded Projects or
 * Pinned would hide the only place a match renders. The stored fold resumes
 * once the filter clears.
 */
export function useSidebarSectionFold(id: SidebarSectionId): SectionFold {
  const expanded = useSidebarSectionExpanded(id);
  const filtering = useSidebarFilterQuery() !== "";
  const setOption = useSetSidebarOption();
  const queryClient = useQueryClient();
  const toggle = useCallback(() => {
    if (!listLoaded(queryClient, "foldedSections")) return;
    const folded = useSidebarConfigStore.getState().config.foldedSections;
    setOption("foldedSections", foldSection(folded, id, !folded.includes(id)));
  }, [id, queryClient, setOption]);
  const fold = useMemo(() => ({ expanded, toggle }), [expanded, toggle]);
  return filtering ? HELD_OPEN : fold;
}

/** Writes a new section order (`sidebar_block_order`), or nothing when it doesn't move. */
export function useSetSidebarSectionOrder(): (next: readonly SidebarSectionId[] | null) => void {
  const setOption = useSetSidebarOption();
  const queryClient = useQueryClient();
  return useCallback(
    (next) => {
      if (next && listLoaded(queryClient, "sectionOrder")) setOption("sectionOrder", next);
    },
    [queryClient, setOption],
  );
}

/** The drag payload type: never `text/plain`, so a drop into an editor inserts nothing. */
const SECTION_DRAG_TYPE = "application/x-cadencr-sidebar-section";

/** The section being dragged: `dragover` can't read the payload, only its type. */
let draggedSection: SidebarSectionId | null = null;

function isSectionDrag(event: DragEvent<HTMLElement>): boolean {
  return draggedSection !== null && event.dataTransfer.types.includes(SECTION_DRAG_TYPE);
}

export interface SectionReorder {
  /** Spread on the section's header: dragging it carries the whole section. */
  handle: {
    draggable: true;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  /** Spread on the whole section: where another section lands. */
  target: {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
    "data-section-drop"?: DropPosition;
    "data-section-dragging"?: "";
  };
}

/**
 * Native drag and drop of a sidebar section (a block, or the project list) by
 * its header, like the conversation rows: the drop point is a line above or
 * below the hovered section, and the order moves once the write is saved.
 * Conversation drags pass through: only a section drag is accepted here.
 */
export function useSidebarSectionReorder(id: SidebarSectionId): SectionReorder {
  const order = useSidebarOption("sectionOrder");
  const setOrder = useSetSidebarSectionOrder();
  const [drop, setDrop] = useState<DropPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  return useMemo(
    () => ({
      handle: {
        draggable: true,
        onDragStart: (event) => {
          // Only the section itself: a row inside it starts its own drag.
          if (event.target !== event.currentTarget) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(SECTION_DRAG_TYPE, id);
          const section = event.currentTarget.closest("[data-sidebar-section]");
          if (section instanceof HTMLElement) {
            const rect = section.getBoundingClientRect();
            event.dataTransfer.setDragImage(
              section,
              event.clientX - rect.left,
              event.clientY - rect.top,
            );
          }
          draggedSection = id;
          setDragging(true);
        },
        onDragEnd: () => {
          draggedSection = null;
          setDragging(false);
        },
      },
      target: {
        onDragOver: (event) => {
          const moved = draggedSection;
          if (!isSectionDrag(event) || !moved || moved === id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const position = dropPositionOf(event);
          // No line where the drop would leave the section in place.
          setDrop(moveWithinGroup(order, moved, id, position) ? position : null);
        },
        onDragLeave: (event) => {
          if (leavesTarget(event)) setDrop(null);
        },
        onDrop: (event) => {
          setDrop(null);
          if (!isSectionDrag(event) || !draggedSection) return;
          event.preventDefault();
          setOrder(moveWithinGroup(order, draggedSection, id, dropPositionOf(event)));
        },
        "data-section-drop": drop ?? undefined,
        "data-section-dragging": dragging ? "" : undefined,
      },
    }),
    [dragging, drop, id, order, setOrder],
  );
}
