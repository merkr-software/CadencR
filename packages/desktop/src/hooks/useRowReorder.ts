import { useContext, useMemo, type DragEvent, type RefObject } from "react";
import { useSidebarRowActionListener } from "@/hooks/useSidebarRowActionListener";
import { keyboardMoveTarget, moveWithinGroup, type DropPosition } from "@/lib/sidebar-manual-order";
import { SidebarReorderContext, type SidebarReorderScope } from "@/lib/sidebar-reorder-context";
import { useSidebarReorderStore } from "@/stores/sidebar-reorder-store";

/** The drag payload type: never `text/plain`, so a drop into an editor inserts nothing. */
const DRAG_TYPE = "application/x-cadencr-conversation";

/** How many frames a keyboard move watches for the row losing focus to the re-sort. */
const REFOCUS_FRAMES = 10;

interface RowDragHandlers {
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

export interface RowReorderProps extends Partial<RowDragHandlers> {
  draggable?: boolean;
  "data-drop-position"?: DropPosition;
  "data-dragging"?: "";
}

const NOT_REORDERABLE: RowReorderProps = {};

/** The hovered half of the drop target: a line above or below it. */
export function dropPositionOf(event: DragEvent<HTMLElement>): DropPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/** A `dragleave` for anything but the target's own content: a header, a gap, outside the sidebar. */
export function leavesTarget(event: DragEvent<HTMLElement>): boolean {
  return !(
    event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
  );
}

/**
 * Native drag and drop rather than a drag library: the lists are virtualized,
 * and a native drag survives its rows mounting and unmounting while Chromium
 * autoscrolls the sidebar near its edges.
 */
function dragHandlers(scope: SidebarReorderScope, featureId: number): RowDragHandlers {
  const store = useSidebarReorderStore.getState;
  return {
    onDragStart: (event) => {
      const group = scope.groupOf(featureId);
      if (!group) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_TYPE, String(featureId));
      // Started on a link or an image inside the row: drag the whole row.
      if (event.target !== event.currentTarget) {
        const rect = event.currentTarget.getBoundingClientRect();
        event.dataTransfer.setDragImage(
          event.currentTarget,
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      }
      store().start({ scope: scope.key, id: featureId, group });
    },
    onDragOver: (event) => {
      const { drag } = store();
      if (!drag) return;
      // Outside the dragged row's list or group the drop is refused: no
      // preventDefault, so the cursor says "not allowed".
      if (drag.scope !== scope.key || !drag.group.includes(featureId)) {
        store().hover(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const position = dropPositionOf(event);
      // No line where the drop would leave the row in place.
      const moves = moveWithinGroup(drag.group, drag.id, featureId, position) !== null;
      store().hover(moves ? { scope: scope.key, id: featureId, position } : null);
    },
    // Leaving the row takes its drop line with it.
    onDragLeave: (event) => {
      if (!leavesTarget(event)) return;
      const { over } = store();
      if (over?.scope === scope.key && over.id === featureId) store().hover(null);
    },
    onDrop: (event) => {
      event.preventDefault();
      const { drag, over } = store();
      store().clear();
      if (!drag || over?.scope !== scope.key || over.id !== featureId) return;
      void scope.move(drag.group, drag.id, { targetId: featureId, position: over.position });
    },
    onDragEnd: () => store().clear(),
  };
}

/**
 * Puts the focus back on the moved row: re-sorting can move its DOM node,
 * which drops the focus to the body.
 */
function keepFocus(rowRef: RefObject<HTMLElement | null>): void {
  let frames = 0;
  const check = (): void => {
    const row = rowRef.current;
    if (!row?.isConnected) return;
    const focused = document.activeElement;
    if (focused !== row && (focused === null || focused === document.body)) {
      row.focus();
      return;
    }
    if (++frames < REFOCUS_FRAMES) requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

/** The move-up / move-down row shortcuts: one step within the group; nothing at its edge. */
function useRowMoveShortcuts(
  rowRef: RefObject<HTMLElement | null>,
  scope: SidebarReorderScope | null,
  featureId: number,
): void {
  const moveBy = (direction: "up" | "down") => (): boolean => {
    const group = scope?.groupOf(featureId);
    if (!scope || !group) return false;
    if (keyboardMoveTarget(group, featureId, direction)) {
      void scope.move(group, featureId, { direction }).then(() => keepFocus(rowRef));
    }
    return true;
  };
  useSidebarRowActionListener(rowRef, { "move-up": moveBy("up"), "move-down": moveBy("down") });
}

/**
 * Makes a conversation row reorderable inside its list's reorder scope:
 * spread the result on the row element. Outside a scope (For me, In progress,
 * Recent, the preview) it returns nothing. `disabled` while the row's label
 * editor is open, so selecting its text never starts a drag.
 */
export function useRowReorder(
  rowRef: RefObject<HTMLElement | null>,
  featureId: number,
  disabled = false,
): RowReorderProps {
  const scope = useContext(SidebarReorderContext);
  const key = scope?.key;
  const dropPosition = useSidebarReorderStore((state) =>
    state.over?.scope === key && state.over?.id === featureId ? state.over.position : null,
  );
  const dragging = useSidebarReorderStore(
    (state) => state.drag?.scope === key && state.drag?.id === featureId,
  );
  useRowMoveShortcuts(rowRef, scope, featureId);
  const handlers = useMemo(
    () => (scope ? dragHandlers(scope, featureId) : null),
    [featureId, scope],
  );
  return useMemo(() => {
    if (!handlers) return NOT_REORDERABLE;
    return {
      ...handlers,
      draggable: !disabled,
      "data-drop-position": dropPosition ?? undefined,
      "data-dragging": dragging ? "" : undefined,
    };
  }, [disabled, dragging, dropPosition, handlers]);
}
