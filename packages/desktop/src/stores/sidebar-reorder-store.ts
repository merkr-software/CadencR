import { create } from "zustand";
import type { DropPosition } from "@/lib/sidebar-manual-order";

interface DraggedRow {
  /** The list the drag started in: rows of other lists never accept it. */
  scope: string;
  id: number;
  /** The siblings it may land among, as displayed when the drag started. */
  group: readonly number[];
}

interface DropTarget {
  scope: string;
  id: number;
  position: DropPosition;
}

interface SidebarReorderState {
  drag: DraggedRow | null;
  over: DropTarget | null;
  start: (drag: DraggedRow) => void;
  hover: (over: DropTarget | null) => void;
  clear: () => void;
}

/**
 * The conversation being dragged in the sidebar and where it would land.
 * Ephemeral pointer state, never persisted: the order itself only changes
 * once the settings write confirms. Rows select only their own slice (am I
 * dragged, am I the target), so moving the pointer re-renders two rows at most.
 */
export const useSidebarReorderStore = create<SidebarReorderState>((set, get) => ({
  drag: null,
  over: null,
  start: (drag) => {
    set({ drag, over: null });
    // A virtualized list may unmount the dragged row mid-drag, and a detached
    // node never fires `dragend`. Mouse events are held back while a native
    // drag runs, so the first one after it ends clears what's left.
    window.addEventListener("mousemove", get().clear, { once: true });
  },
  hover: (over) => {
    const current = get().over;
    if (
      current?.id === over?.id &&
      current?.position === over?.position &&
      current?.scope === over?.scope
    ) {
      return;
    }
    set({ over });
  },
  clear: () => {
    window.removeEventListener("mousemove", get().clear);
    if (get().drag || get().over) set({ drag: null, over: null });
  },
}));
