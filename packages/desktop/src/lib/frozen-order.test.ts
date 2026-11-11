import { describe, expect, it } from "vitest";
import { holdOrder, reconcileFrozenOrder } from "./frozen-order";

describe("reconcileFrozenOrder", () => {
  it("keeps existing ids in place, puts new ones on top, drops removed ones", () => {
    expect(reconcileFrozenOrder([1, 2, 3], [2, 4, 1])).toEqual([4, 1, 2]);
  });

  it("returns the previous array when nothing changed", () => {
    const previous = [1, 2, 3];
    expect(reconcileFrozenOrder(previous, [3, 2, 1])).toBe(previous);
  });
});

describe("holdOrder", () => {
  const item = (id: number) => ({ id });
  const idOf = (entry: { id: number }) => entry.id;

  it("keeps the shown order, appends new items and drops gone ones", () => {
    const next = [item(3), item(1), item(4), item(2)];
    expect(holdOrder(next, [1, 2, 9, 3], idOf).map(idOf)).toEqual([1, 2, 3, 4]);
  });

  it("returns the very list when nothing moves", () => {
    const next = [item(1), item(2)];
    expect(holdOrder(next, [1, 2], idOf)).toBe(next);
  });
});
