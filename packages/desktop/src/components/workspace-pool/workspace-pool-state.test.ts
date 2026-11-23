import { describe, expect, it } from "vitest";
import {
  EMPTY_WORKSPACE_POOL,
  activateWorkspace,
  dropPrewarm,
  dropWorkspace,
  prewarmWorkspace,
  trimWorkspacePool,
  type WorkspacePoolState,
  type WorkspaceTarget,
} from "./workspace-pool-state";

function target(featureId: number, overrides: Partial<WorkspaceTarget> = {}): WorkspaceTarget {
  return {
    sessionId: `ws-feature-${featureId}`,
    cwd: "/repo",
    featureId,
    projectId: 1,
    focusTab: undefined,
    ...overrides,
  };
}

function poolOf(...featureIds: number[]): WorkspacePoolState {
  return featureIds.reduce(
    (state, featureId) => activateWorkspace(state, target(featureId)),
    EMPTY_WORKSPACE_POOL,
  );
}

const ids = (state: WorkspacePoolState): string[] => state.entries.map((entry) => entry.sessionId);

describe("activateWorkspace", () => {
  it("mounts a new conversation and makes it the most recent", () => {
    const state = poolOf(1, 2);
    expect(ids(state)).toEqual(["ws-feature-1", "ws-feature-2"]);
    expect(state.recency).toEqual(["ws-feature-2", "ws-feature-1"]);
  });

  it("returns the same state when the active conversation is asked for again", () => {
    const state = poolOf(1, 2);
    expect(activateWorkspace(state, target(2))).toBe(state);
  });

  it("goes back to a mounted conversation without reordering the mounted entries", () => {
    const state = activateWorkspace(poolOf(1, 2, 3), target(1));
    // Mount order is DOM order: moving an entry would re-parent a whole workspace.
    expect(ids(state)).toEqual(["ws-feature-1", "ws-feature-2", "ws-feature-3"]);
    expect(state.recency).toEqual(["ws-feature-1", "ws-feature-3", "ws-feature-2"]);
  });

  it("keeps the entry object of a conversation whose route params did not change", () => {
    const before = poolOf(1, 2);
    const after = activateWorkspace(before, target(1));
    expect(after.entries[0]).toBe(before.entries[0]);
  });

  it("keeps the entry object when only the requested tab differs", () => {
    // The tab is a request the pool applies itself: a new entry object would
    // re-render the whole workspace for nothing.
    const before = poolOf(1, 2);
    const after = activateWorkspace(before, target(1, { focusTab: "git" }));
    expect(after.entries[0]).toBe(before.entries[0]);
    expect(after.recency[0]).toBe("ws-feature-1");
    expect(activateWorkspace(after, target(1, { focusTab: "terminal" }))).toBe(after);
  });

  it("refreshes the route params of a mounted conversation", () => {
    const state = activateWorkspace(poolOf(1, 2), target(1, { cwd: "/elsewhere" }));
    expect(state.entries[0]?.cwd).toBe("/elsewhere");
    expect(ids(state)).toEqual(["ws-feature-1", "ws-feature-2"]);
  });
});

describe("prewarmWorkspace", () => {
  it("mounts a conversation without showing it or ranking it", () => {
    const state = prewarmWorkspace(poolOf(1, 2), target(3));
    expect(ids(state)).toEqual(["ws-feature-1", "ws-feature-2", "ws-feature-3"]);
    expect(state.recency).toEqual(["ws-feature-2", "ws-feature-1"]);
    expect(state.prewarmed).toBe("ws-feature-3");
  });

  it("leaves a mounted conversation alone", () => {
    const state = poolOf(1, 2);
    expect(prewarmWorkspace(state, target(1, { focusTab: "git" }))).toBe(state);
  });

  it("drops the previous prewarm that was never shown", () => {
    const state = prewarmWorkspace(prewarmWorkspace(poolOf(1), target(2)), target(3));
    expect(ids(state)).toEqual(["ws-feature-1", "ws-feature-3"]);
    expect(state.prewarmed).toBe("ws-feature-3");
  });

  it("ranks first once shown, keeping its entry", () => {
    const prewarmed = prewarmWorkspace(poolOf(1, 2), target(3));
    const shown = activateWorkspace(prewarmed, target(3, { focusTab: "agent" }));
    expect(shown.prewarmed).toBeNull();
    expect(shown.recency).toEqual(["ws-feature-3", "ws-feature-2", "ws-feature-1"]);
    expect(shown.entries[2]).toBe(prewarmed.entries[2]);
  });
});

describe("dropPrewarm", () => {
  it("unmounts a prewarm that was never shown", () => {
    const state = dropPrewarm(prewarmWorkspace(poolOf(1), target(2)), "ws-feature-2");
    expect(ids(state)).toEqual(["ws-feature-1"]);
    expect(state.prewarmed).toBeNull();
  });

  it("keeps a prewarmed conversation that was shown since", () => {
    const shown = activateWorkspace(prewarmWorkspace(poolOf(1), target(2)), target(2));
    expect(dropPrewarm(shown, "ws-feature-2")).toBe(shown);
  });

  it("returns the same state for another conversation", () => {
    const state = prewarmWorkspace(poolOf(1), target(2));
    expect(dropPrewarm(state, "ws-feature-1")).toBe(state);
  });
});

describe("trimWorkspacePool", () => {
  it("unmounts the least recently shown conversations beyond the limit", () => {
    const state = trimWorkspacePool(activateWorkspace(poolOf(1, 2, 3, 4), target(1)), 2);
    expect(ids(state)).toEqual(["ws-feature-1", "ws-feature-4"]);
    expect(state.recency).toEqual(["ws-feature-1", "ws-feature-4"]);
  });

  it("returns the same state within the limit", () => {
    const state = poolOf(1, 2);
    expect(trimWorkspacePool(state, 2)).toBe(state);
  });

  it("never unmounts the active conversation", () => {
    const state = trimWorkspacePool(poolOf(1, 2, 3), 0);
    expect(ids(state)).toEqual(["ws-feature-3"]);
  });

  it("does not count a pending prewarm, nor trim it", () => {
    const atLimit = prewarmWorkspace(poolOf(1, 2), target(3));
    // Two shown, one prewarmed: within a limit of two.
    expect(trimWorkspacePool(atLimit, 2)).toBe(atLimit);

    const overLimit = trimWorkspacePool(prewarmWorkspace(poolOf(1, 2, 3), target(4)), 2);
    expect(ids(overLimit)).toEqual(["ws-feature-2", "ws-feature-3", "ws-feature-4"]);
    expect(overLimit.prewarmed).toBe("ws-feature-4");
  });
});

describe("dropWorkspace", () => {
  it("unmounts one conversation", () => {
    const state = dropWorkspace(poolOf(1, 2, 3), "ws-feature-2");
    expect(ids(state)).toEqual(["ws-feature-1", "ws-feature-3"]);
    expect(state.recency).toEqual(["ws-feature-3", "ws-feature-1"]);
  });

  it("forgets a pending prewarm it unmounts", () => {
    const state = dropWorkspace(prewarmWorkspace(poolOf(1), target(2)), "ws-feature-2");
    expect(ids(state)).toEqual(["ws-feature-1"]);
    expect(state.prewarmed).toBeNull();
  });

  it("returns the same state for a conversation that is not mounted", () => {
    const state = poolOf(1);
    expect(dropWorkspace(state, "ws-feature-9")).toBe(state);
  });
});
