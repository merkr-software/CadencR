import type { Feature } from "@/api/generated";
import type { PartitionedFeatures } from "@/lib/feature-grouping";
import { descendantIdsOf, type FeatureTreeNode } from "@/lib/feature-hierarchy";
import { applyOrder } from "@/lib/frozen-order";

/**
 * Workspace setting holding the manual conversation order: a JSON array of
 * conversation ids, one rank shared by every list of the sidebar.
 */
export const SIDEBAR_CONVERSATION_ORDER_KEY = "sidebar_conversation_order";

export const NO_MANUAL_ORDER: readonly number[] = [];

export type DropPosition = "before" | "after";

/**
 * Orders conversations by the manual rank. Conversations the rank doesn't know
 * yet (created since the last drag) come first, in their incoming order: lists
 * arrive last-activity first, so a new conversation shows on top. Every list
 * sorts by the same rank, so the order agrees across projects, groups and lenses.
 */
export function sortByManualOrder(
  features: readonly Feature[],
  order: readonly number[],
): readonly Feature[] {
  return order.length === 0 ? features : applyOrder(features, order);
}

/**
 * The group's ids once `movedId` sits before or after `targetId`; null when
 * nothing moves. Conversations by id, sidebar sections by name.
 */
export function moveWithinGroup<T extends number | string>(
  groupIds: readonly T[],
  movedId: T,
  targetId: T,
  position: DropPosition,
): T[] | null {
  if (movedId === targetId || !groupIds.includes(movedId) || !groupIds.includes(targetId)) {
    return null;
  }
  const next = groupIds.filter((id) => id !== movedId);
  const at = next.indexOf(targetId) + (position === "after" ? 1 : 0);
  next.splice(at, 0, movedId);
  return next.every((id, index) => id === groupIds[index]) ? null : next;
}

/**
 * The manual order after a drop inside one group (`groupIds`, as displayed).
 * The group's members keep the slots they hold in the order and only trade
 * places among themselves, so every conversation outside the group, hidden
 * members of a filtered group included, stays where it was, while the group
 * shows exactly as dropped. Members the order doesn't rank yet are ranked
 * first, in their displayed order, matching where {@link sortByManualOrder}
 * showed them. Returns `order` itself when nothing moves.
 */
export function placeInGroup(
  order: readonly number[],
  groupIds: readonly number[],
  movedId: number,
  targetId: number,
  position: DropPosition,
): readonly number[] {
  const sequence = moveWithinGroup(groupIds, movedId, targetId, position);
  if (!sequence) return order;
  const ranked = new Set(order);
  const full = [...groupIds.filter((id) => !ranked.has(id)), ...order];
  const members = new Set(groupIds);
  let next = 0;
  return full.map((id) => (members.has(id) ? (sequence[next++] ?? id) : id));
}

/**
 * Drops ids the sidebar no longer lists (archived, deleted) so the stored
 * array stays bounded. `keep` survives regardless: a conversation just
 * created may be missing from a stale active list but was dropped on screen.
 */
export function pruneManualOrder(
  order: readonly number[],
  activeIds: ReadonlySet<number>,
  keep: readonly number[],
): readonly number[] {
  const kept = new Set(keep);
  return order.filter((id) => activeIds.has(id) || kept.has(id));
}

/** Where a one-step keyboard move lands: next to the neighbor, or null at the group's edge. */
export function keyboardMoveTarget<T extends number | string>(
  groupIds: readonly T[],
  featureId: T,
  direction: "up" | "down",
): { targetId: T; position: DropPosition } | null {
  const index = groupIds.indexOf(featureId);
  if (index < 0) return null;
  const targetId = groupIds[direction === "up" ? index - 1 : index + 1];
  if (targetId === undefined) return null;
  return { targetId, position: direction === "up" ? "before" : "after" };
}

/** Each conversation's group: the siblings it may be reordered among (groups of one are left out). */
export function indexReorderGroups(
  groups: Iterable<readonly number[]>,
): ReadonlyMap<number, readonly number[]> {
  const byId = new Map<number, readonly number[]>();
  for (const group of groups) {
    if (group.length < 2) continue;
    for (const id of group) byId.set(id, group);
  }
  return byId;
}

/** The children of every parent in a forest, one sibling group per parent. */
export function childSiblingGroups(roots: readonly FeatureTreeNode[]): number[][] {
  const groups: number[][] = [];
  const visit = (node: FeatureTreeNode): void => {
    if (node.children.length === 0) return;
    groups.push(node.children.map((child) => child.feature.id));
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return groups;
}

/**
 * The sibling sets a row may be dragged among: each worktree group's roots,
 * the flat list's, the Dormant section's, and each parent's children. A row
 * never leaves its parent, worktree group or project.
 */
export function projectReorderGroups(
  grouped: Pick<PartitionedFeatures, "worktreeGroups" | "flatActiveFeatures">,
  dormantFeatures: readonly Feature[],
  forest: readonly FeatureTreeNode[],
): number[][] {
  const idsOf = (features: readonly Feature[]) => features.map((feature) => feature.id);
  return [
    ...grouped.worktreeGroups.map((group) => idsOf(group.features)),
    idsOf(grouped.flatActiveFeatures),
    idsOf(dormantFeatures),
    ...childSiblingGroups(forest),
  ];
}

/** Every conversation of a forest, depth first: children moves animate too. */
export function flattenForestIds(forest: readonly FeatureTreeNode[]): number[] {
  return forest.flatMap((node) => [node.feature.id, ...descendantIdsOf(node)]);
}
