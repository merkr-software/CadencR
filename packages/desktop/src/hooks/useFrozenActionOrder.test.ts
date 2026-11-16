// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Feature } from "@/api/generated";
import type { ResolvedNextAction } from "@/lib/next-actions";
import { useFrozenActionOrder } from "./useFrozenActionOrder";

const action = (id: number, kind: ResolvedNextAction["kind"] = "waiting"): ResolvedNextAction => ({
  feature: { id } as Feature,
  kind,
});
const ids = (actions: readonly ResolvedNextAction[]) => actions.map((a) => a.feature.id);

describe("useFrozenActionOrder", () => {
  it("follows the live order until frozen, then holds rows in place", () => {
    const first = [action(1), action(2), action(3)];
    const { result, rerender } = renderHook(
      ({ actions, frozen }) => useFrozenActionOrder(actions, frozen),
      { initialProps: { actions: first, frozen: false } },
    );
    expect(result.current).toBe(first);

    // The pointer enters the list, then an answered row changes action and moves.
    rerender({ actions: first, frozen: true });
    const resorted = [action(2), action(3), action(1, "review")];
    rerender({ actions: resorted, frozen: true });
    expect(ids(result.current)).toEqual([1, 2, 3]);
    expect(result.current[0]?.kind).toBe("review");

    rerender({ actions: resorted, frozen: false });
    expect(ids(result.current)).toEqual([2, 3, 1]);
  });
});
