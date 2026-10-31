import { describe, expect, it } from "vitest";
import {
  liveStatusPatch,
  reduceSessionPatch,
  type SessionReducerEnv,
} from "./session-state-reducer";
import { createSessionEntry, type SessionEntry } from "./ws-session-types";
import { startTurnTiming } from "./ws-turn-timing";

function env(nowMs: number, turnStart: number | null = null): SessionReducerEnv {
  return { nowMs, turnStartLocalMs: () => turnStart };
}

function entry(patch: Partial<SessionEntry> = {}): SessionEntry {
  return { ...createSessionEntry(), sessionDbId: 7, ...patch };
}

describe("reduceSessionPatch", () => {
  it("starts the turn timer on the injected clock", () => {
    const { next } = reduceSessionPatch(entry(), { lifecycle: { phase: "active" } }, env(5_000));

    expect(next.turnTiming.startedAt).toBe(5_000);
  });

  it("anchors a running turn to the server turn start", () => {
    const { next } = reduceSessionPatch(
      entry(),
      { lifecycle: { phase: "active" } },
      env(9_000, 4_000),
    );

    expect(next.turnTiming.startedAt).toBe(4_000);
  });

  it("appends one turn summary when the turn ends, stamped by the clock", () => {
    const running = entry({ lifecycle: { phase: "active" }, turnTiming: startTurnTiming(1_000) });
    const ended = reduceSessionPatch(
      running,
      { lifecycle: { phase: "terminal", reason: "completed" } },
      env(4_000),
    ).next;
    const again = reduceSessionPatch(
      ended,
      { lifecycle: { phase: "terminal", reason: "completed" } },
      env(5_000),
    ).next;

    const summaries = again.blocks.filter((block) => block.type === "turn_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: "turn-summary-4000",
      createdAt: new Date(4_000).toISOString(),
      content: "Worked - 3s · Agent 3s · Waiting 0s",
    });
    expect(again.rootBlocks.at(-1)?.type).toBe("turn_summary");
  });

  it("settles an empty user-paused turn to idle rather than ended", () => {
    const paused = entry({ lifecycle: { phase: "paused", reason: "user" } });

    const { next } = reduceSessionPatch(
      paused,
      { lifecycle: { phase: "terminal", reason: "completed" } },
      env(1_000),
    );

    expect(next.lifecycle).toEqual({ phase: "idle" });
    expect(next.blocks).toEqual([]);
  });

  it("asks to drop the question draft when its question is replaced or answered", () => {
    const asking = entry({ pendingRequestId: "q1", pendingQuestions: [{ question: "Which?" }] });

    expect(reduceSessionPatch(asking, { pendingRequestId: "q2" }, env(1_000)).effects).toEqual([
      { type: "clear_question_draft", sessionDbId: 7, requestId: "q1" },
    ]);
    expect(reduceSessionPatch(asking, { pendingQuestions: [] }, env(1_000)).effects).toHaveLength(
      1,
    );
    expect(reduceSessionPatch(asking, { featureTitle: "x" }, env(1_000)).effects).toEqual([]);
  });

  it("returns the previous entry untouched", () => {
    const prev = entry();
    const snapshot = structuredClone({ ...prev, toolResultMap: undefined });

    reduceSessionPatch(prev, { lifecycle: { phase: "active" } }, env(1_000));

    expect({ ...prev, toolResultMap: undefined }).toEqual(snapshot);
  });
});

describe("liveStatusPatch", () => {
  it("moves the turn along the live status", () => {
    const idle = entry();
    expect(liveStatusPatch(idle, { status: "agent", kind: null }, undefined, env(0))).toEqual({
      lifecycle: { phase: "active" },
    });
    expect(
      liveStatusPatch(idle, { status: "question", kind: "question" }, undefined, env(0)),
    ).toEqual({ lifecycle: { phase: "paused", reason: "question" } });
    expect(
      liveStatusPatch(
        entry({ lifecycle: { phase: "active" } }),
        { status: "idle", kind: null },
        undefined,
        env(0),
      ),
    ).toEqual({ lifecycle: { phase: "terminal", reason: "completed" } });
  });

  it("leaves an idle session idle", () => {
    expect(liveStatusPatch(entry(), { status: "idle", kind: null }, undefined, env(0))).toBeNull();
  });

  it("clears the gate answered on another device, only for that request", () => {
    const gated = entry({
      lifecycle: { phase: "paused", reason: "permission" },
      pendingRequestId: "r1",
      pendingPlanApproval: { plan: "p" },
    });
    const leaving = { status: "agent" as const, kind: null };

    const cleared = liveStatusPatch(
      gated,
      leaving,
      { status: "question", requestId: "r1" },
      env(0),
    );
    const other = liveStatusPatch(gated, leaving, { status: "question", requestId: "r0" }, env(0));

    expect(cleared).toMatchObject({
      pendingRequestId: "",
      pendingPlanApproval: null,
      lifecycle: { phase: "active" },
    });
    expect(other).toEqual({ lifecycle: { phase: "active" } });
  });

  it("re-anchors a turn this device first saw through its own stream", () => {
    const streaming = entry({
      lifecycle: { phase: "active" },
      turnTiming: startTurnTiming(50_000),
    });

    const patch = liveStatusPatch(
      streaming,
      { status: "agent", kind: null },
      undefined,
      env(50_000, 40_000),
    );

    expect(patch?.turnTiming?.startedAt).toBe(40_000);
  });
});
