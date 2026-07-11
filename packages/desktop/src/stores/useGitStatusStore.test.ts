import { act, renderHook } from "@/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import type { GitStatusSnapshot } from "@/api/generated";
import { selectGitTargetBranch, useGitStatusStore } from "./useGitStatusStore";

function snap(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    feature_id: 1,
    current_branch: "main",
    target_branch: "main",
    uncommitted_count: 0,
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    ahead_of_remote: 0,
    behind_remote: 0,
    ahead_of_target: 0,
    has_remote: false,
    host: null,
    compare_url: null,
    action_label: null,
    shared_with: [],
    computed_at: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  useGitStatusStore.setState({ byFeature: {}, errorByFeature: {} });
});

describe("useGitStatusStore.setStatus", () => {
  it("stores the first incoming snapshot", () => {
    useGitStatusStore.getState().setStatus(snap({ current_branch: "feat" }));
    expect(useGitStatusStore.getState().byFeature[1]?.current_branch).toBe("feat");
  });

  it("overwrites with a strictly newer snapshot", () => {
    const setStatus = useGitStatusStore.getState().setStatus;
    setStatus(snap({ current_branch: "old", computed_at: 100 }));
    setStatus(snap({ current_branch: "new", computed_at: 200 }));
    expect(useGitStatusStore.getState().byFeature[1]?.current_branch).toBe("new");
  });

  it("drops a stale snapshot whose computed_at is older than the stored one", () => {
    // Reproduces the worktree-setup flicker: a delayed HTTP response
    // (computed at T) arrives after a WS push (computed at T+Δ). Without
    // the guard, the older value would clobber the newer one.
    const setStatus = useGitStatusStore.getState().setStatus;
    setStatus(snap({ current_branch: "feat/new", computed_at: 200 }));
    setStatus(snap({ current_branch: "main", computed_at: 100 }));
    expect(useGitStatusStore.getState().byFeature[1]?.current_branch).toBe("feat/new");
  });

  it("accepts an equal-timestamp snapshot (refresh of derived fields)", () => {
    // An explicit recompute after a write may re-emit at the same ms tick;
    // we want it to update so e.g. `shared_with` repopulates.
    const setStatus = useGitStatusStore.getState().setStatus;
    setStatus(snap({ uncommitted_count: 3, computed_at: 100 }));
    setStatus(snap({ uncommitted_count: 5, computed_at: 100 }));
    expect(useGitStatusStore.getState().byFeature[1]?.uncommitted_count).toBe(5);
  });

  it("keeps computed_at fresh for otherwise equal newer snapshots", () => {
    const setStatus = useGitStatusStore.getState().setStatus;
    setStatus(snap({ computed_at: 100 }));
    setStatus(snap({ computed_at: 200 }));
    expect(useGitStatusStore.getState().byFeature[1]?.computed_at).toBe(200);
  });

  it("clears any prior error for the feature when a snapshot arrives", () => {
    useGitStatusStore.getState().setStatusError({ feature_id: 1, error: "boom" });
    useGitStatusStore.getState().setStatus(snap());
    expect(useGitStatusStore.getState().errorByFeature[1]).toBeUndefined();
  });

  it("ordering guard is per-feature (a stale snapshot for one doesn't block another)", () => {
    const setStatus = useGitStatusStore.getState().setStatus;
    setStatus(snap({ feature_id: 1, computed_at: 200 }));
    setStatus(snap({ feature_id: 2, computed_at: 50 }));
    expect(useGitStatusStore.getState().byFeature[2]?.computed_at).toBe(50);
  });
});

describe("selectGitTargetBranch", () => {
  it("returns only the target branch used by the Git diff query", () => {
    useGitStatusStore.getState().setStatus(snap({ target_branch: "develop" }));

    expect(selectGitTargetBranch(1)(useGitStatusStore.getState())).toBe("develop");
    expect(selectGitTargetBranch(2)(useGitStatusStore.getState())).toBeUndefined();
  });

  it("does not re-render a subscriber when only the watcher timestamp changes", () => {
    useGitStatusStore.getState().setStatus(snap({ target_branch: "develop", computed_at: 100 }));
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useGitStatusStore(selectGitTargetBranch(1));
    });

    act(() => {
      useGitStatusStore
        .getState()
        .setStatus(snap({ target_branch: "develop", computed_at: 200, uncommitted_count: 1 }));
    });

    expect(result.current).toBe("develop");
    expect(renderCount).toBe(1);
  });
});
