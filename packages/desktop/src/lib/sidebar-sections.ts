import type { SidebarSectionId } from "@/lib/sidebar-config";
import { keyboardMoveTarget, moveWithinGroup } from "@/lib/sidebar-manual-order";

/** The section order with `id` one place up or down; null at either end. */
export function shiftSection(
  order: readonly SidebarSectionId[],
  id: SidebarSectionId,
  direction: "up" | "down",
): SidebarSectionId[] | null {
  const target = keyboardMoveTarget(order, id, direction);
  return target && moveWithinGroup(order, id, target.targetId, target.position);
}

/** The folded sections once `id` is folded or unfolded. */
export function foldSection(
  folded: readonly SidebarSectionId[],
  id: SidebarSectionId,
  fold: boolean,
): SidebarSectionId[] {
  const others = folded.filter((candidate) => candidate !== id);
  return fold ? [...others, id] : others;
}
