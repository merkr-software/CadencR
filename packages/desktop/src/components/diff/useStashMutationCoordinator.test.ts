// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetStashMutationCoordinatorForTest,
  useStashMutationCoordinator,
  type StashMutationLease,
  type StashMutationOwner,
} from "./useStashMutationCoordinator";

const pushOwner: StashMutationOwner = { kind: "push" };
const rowOwner: StashMutationOwner = {
  kind: "row",
  operation: "pop",
  stashRefName: "stash@{0}",
};

describe("useStashMutationCoordinator", () => {
  beforeEach(() => resetStashMutationCoordinatorForTest());

  it.each([
    [pushOwner, rowOwner],
    [rowOwner, pushOwner],
  ])("atomically rejects a same-tick %o then %o dispatch", (firstOwner, secondOwner) => {
    const first = renderHook(() => useStashMutationCoordinator(42));
    const second = renderHook(() => useStashMutationCoordinator(42));
    let lease: StashMutationLease | null = null;
    let rejected: StashMutationLease | null = null;

    act(() => {
      lease = first.result.current.tryAcquire(firstOwner);
      rejected = second.result.current.tryAcquire(secondOwner);
    });

    expect(lease).not.toBeNull();
    expect(rejected).toBeNull();
    expect(second.result.current.activeMutation).toEqual(firstOwner);

    act(() => {
      if (lease) first.result.current.release(lease);
    });
    expect(second.result.current.activeMutation).toBeNull();
  });

  it("scopes leases by feature", () => {
    const firstFeature = renderHook(() => useStashMutationCoordinator(1));
    const secondFeature = renderHook(() => useStashMutationCoordinator(2));
    let firstLease: StashMutationLease | null = null;
    let secondLease: StashMutationLease | null = null;

    act(() => {
      firstLease = firstFeature.result.current.tryAcquire(pushOwner);
      secondLease = secondFeature.result.current.tryAcquire(rowOwner);
    });

    expect(firstLease).not.toBeNull();
    expect(secondLease).not.toBeNull();
    act(() => {
      if (firstLease) firstFeature.result.current.release(firstLease);
    });
    expect(secondFeature.result.current.activeMutation).toEqual(rowOwner);
  });
});
