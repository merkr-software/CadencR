import { intArraysEqual } from "@/lib/utils";

/**
 * Merge freshly fetched ids into a frozen display order: existing ids keep
 * their place, new ids go on top, removed ids drop out. Returns `previous`
 * itself when nothing changed so consumers can bail out of re-renders.
 */
export function reconcileFrozenOrder(
  previous: readonly number[],
  fetched: readonly number[],
): readonly number[] {
  const fetchedSet = new Set(fetched);
  const known = new Set(previous);
  const next = [
    ...fetched.filter((id) => !known.has(id)),
    ...previous.filter((id) => fetchedSet.has(id)),
  ];
  return intArraysEqual(next, previous) ? previous : next;
}

/**
 * Sorts by a frozen order. Unknown ids (newly created, not yet reconciled into
 * `order`) sort to the front, keeping their incoming relative order.
 */
export function applyOrder<T extends { id: number }>(
  items: readonly T[],
  order: readonly number[] | null,
): T[] {
  if (order === null) return [...items];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
}

/**
 * `items` ordered like `previousIds` (as last shown): the ones still there keep
 * their place, new ones go after them, gone ones drop out. Returns `items`
 * itself when that changes nothing.
 */
export function holdOrder<T>(
  items: readonly T[],
  previousIds: readonly number[],
  idOf: (item: T) => number,
): readonly T[] {
  const rank = new Map(previousIds.map((id, index) => [id, index]));
  const known = items.filter((item) => rank.has(idOf(item)));
  const added = items.filter((item) => !rank.has(idOf(item)));
  known.sort((a, b) => (rank.get(idOf(a)) ?? 0) - (rank.get(idOf(b)) ?? 0));
  const held = [...known, ...added];
  return held.every((item, index) => item === items[index]) ? items : held;
}
