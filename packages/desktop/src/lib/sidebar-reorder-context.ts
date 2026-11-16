import { createContext } from "react";
import type { DropPosition } from "@/lib/sidebar-manual-order";

/**
 * Where a move lands: next to a sibling (a drop), or one step up or down (a
 * move shortcut, resolved against the saved order when the move runs).
 */
export type MoveTarget =
  | { targetId: number; position: DropPosition }
  | { direction: "up" | "down" };

/** Moves `movedId` inside `group`; resolves once the new order is saved. */
export type MoveConversation = (
  group: readonly number[],
  movedId: number,
  target: MoveTarget,
) => Promise<void>;

/**
 * One reorderable sidebar list (a project's tree, the Pinned block, a lens
 * list). Stable for the list's lifetime: rows read it only when a drag or a
 * move shortcut happens, so a list update never re-renders every row through
 * the context.
 */
export interface SidebarReorderScope {
  /** Tells this list's rows apart from another list's copy of the same conversation. */
  key: string;
  /** The siblings a row may be reordered among, as displayed; undefined when it can't move. */
  groupOf: (featureId: number) => readonly number[] | undefined;
  move: MoveConversation;
}

/** Null outside a reorderable list (For me, In progress, Recent, archives, the preview). */
export const SidebarReorderContext = createContext<SidebarReorderScope | null>(null);
