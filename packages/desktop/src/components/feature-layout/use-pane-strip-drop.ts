import { useDroppable } from "@dnd-kit/core";

import type { DragSource } from "./types";

interface PaneStripDrop {
  /** Ref for the strip element; unset while drops are off. */
  setNodeRef: ((element: HTMLElement | null) => void) | undefined;
  /** A tab from another pane hovers the strip. */
  showOver: boolean;
}

/**
 * A pane's tab strip (or a folded pop pane's rail) as its "merge into this
 * pane" drop target. It only highlights when the dragged tab comes from
 * another pane, so dragging a tab over its own strip stays visually quiet.
 */
export function usePaneStripDrop(paneId: string, enabled: boolean): PaneStripDrop {
  const droppable = useDroppable({
    id: `strip:${paneId}`,
    data: { kind: "pane-strip", paneId } as const,
    disabled: !enabled,
  });
  const sourcePaneId = (droppable.active?.data.current as DragSource | undefined)?.paneId;
  return {
    setNodeRef: enabled ? droppable.setNodeRef : undefined,
    showOver: enabled && droppable.isOver && sourcePaneId !== undefined && sourcePaneId !== paneId,
  };
}
