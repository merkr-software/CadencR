import { describe, expect, it, vi } from "vitest";
import { statusSyncPatch } from "./session-status-patch";
import { createSessionEntry } from "./ws-session-types";
import { startTurnTiming } from "./ws-turn-timing";

const time = { serverStartedAtLocalMs: 1_000, nowMs: 10_000 };
const running = { status: "agent", kind: null } as const;

describe("statusSyncPatch", () => {
  it("preserves no-op identity for active and paused lifecycles", () => {
    const session = {
      ...createSessionEntry(),
      lifecycle: { phase: "active" } as const,
      turnTiming: startTurnTiming(1_000),
    };
    expect(statusSyncPatch(session, running, undefined, time)).toBeNull();
    const paused = { ...session, lifecycle: { phase: "paused", reason: "question" } as const };
    expect(
      statusSyncPatch(paused, { status: "question", kind: "question" }, undefined, time),
    ).toBeNull();
  });

  it("does not read a clock or status store while re-anchoring", () => {
    const session = { ...createSessionEntry(), lifecycle: { phase: "active" } as const };
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("hidden clock read");
    });
    try {
      const patch = statusSyncPatch(session, running, undefined, time);
      expect(patch?.turnTiming?.startedAt).toBe(1_000);
      expect(patch?.turnTiming?.segmentStartedAt).toBe(1_000);
      expect(session.turnTiming.startedAt).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("clears the confirmed gate and preserves a newer mounted gate", () => {
    const session = {
      ...createSessionEntry(),
      lifecycle: { phase: "active" } as const,
      turnTiming: startTurnTiming(1_000),
      pendingRequestId: "new",
      pendingQuestions: [{ question: "keep me" }],
    };
    const previous = {
      status: "question",
      kind: "question",
      requestId: "old",
      featureId: 7,
      seq: 1,
    } as const;
    expect(statusSyncPatch(session, running, previous, time)).toBeNull();
    expect(
      statusSyncPatch(session, running, { ...previous, requestId: "new" }, time),
    ).toMatchObject({ pendingRequestId: "", pendingQuestions: [] });
  });
});
