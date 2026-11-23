import { describe, expect, it } from "vitest";
import { applySnapshot, applyUpdate } from "@/stores/session-status-reducers";
import { countFeatureRunningSubagents, isFeatureWaiting } from "@/stores/session-status-selectors";

describe("isFeatureWaiting", () => {
  const bySession = {
    1: { status: "question", kind: "permission", featureId: 10, seq: 1 },
    2: { status: "agent", kind: null, featureId: 20, seq: 2 },
  } as const;

  it("is true only for a feature with a session waiting on the user", () => {
    expect(isFeatureWaiting(bySession, 10)).toBe(true);
    expect(isFeatureWaiting(bySession, 20)).toBe(false);
    expect(isFeatureWaiting(bySession, 30)).toBe(false);
  });
});

describe("running sub-agents in session status", () => {
  it("sums running sub-agents across a feature's sessions", () => {
    const bySession = {
      1: { status: "agent", kind: null, featureId: 10, seq: 1, runningSubagents: 2 },
      2: { status: "idle", kind: null, featureId: 10, seq: 2, runningSubagents: 1 },
      3: { status: "agent", kind: null, featureId: 20, seq: 3, runningSubagents: 4 },
    } as const;
    expect(countFeatureRunningSubagents(bySession, 10)).toBe(3);
    expect(countFeatureRunningSubagents(bySession, 20)).toBe(4);
    expect(countFeatureRunningSubagents(bySession, 99)).toBe(0);
  });

  it("applies running_subagents from snapshots and live updates even when status is unchanged", () => {
    const initial = applySnapshot(
      {},
      {
        seq: 1,
        states: {
          "5": { feature_id: 10, status: "agent", running_subagents: 1 },
        },
      },
    );
    expect(initial[5]?.runningSubagents).toBe(1);

    // Same status ("agent"), count increases 1 -> 3: must produce a new state map.
    const grew = applyUpdate(
      initial,
      { session_id: 5, feature_id: 10, status: "agent", running_subagents: 3, seq: 2 },
      1,
    );
    expect(grew.next?.[5]?.runningSubagents).toBe(3);

    // Identical count is absorbed without replacing the map reference.
    const repeat = applyUpdate(
      grew.next!,
      { session_id: 5, feature_id: 10, status: "agent", running_subagents: 3, seq: 3 },
      1,
    );
    expect(repeat.next).toBeNull();

    // Omitting running_subagents resets it to 0.
    const cleared = applyUpdate(
      grew.next!,
      { session_id: 5, feature_id: 10, status: "idle", seq: 4 },
      1,
    );
    expect(cleared.next?.[5]?.runningSubagents).toBe(0);
  });
});
