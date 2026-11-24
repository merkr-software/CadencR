import { describe, expect, it } from "vitest";
import { statusSyncPatch } from "./session-status-patch";
import { createSessionEntry } from "./ws-session-types";

const running = { status: "agent", kind: null } as const;

describe("statusSyncPatch", () => {
  it("preserves no-op identity for active and paused lifecycles", () => {
    const session = { ...createSessionEntry(), lifecycle: { phase: "active" } as const };
    expect(statusSyncPatch(session, running, undefined)).toBeNull();
    const paused = { ...session, lifecycle: { phase: "paused", reason: "question" } as const };
    expect(statusSyncPatch(paused, { status: "question", kind: "question" }, undefined)).toBeNull();
  });

  it("starts the local turn lifecycle for a device that did not watch the prompt", () => {
    const session = createSessionEntry();
    expect(statusSyncPatch(session, running, undefined)).toEqual({
      lifecycle: { phase: "active" },
    });
  });

  it("clears the confirmed gate and preserves a newer mounted gate", () => {
    const session = {
      ...createSessionEntry(),
      lifecycle: { phase: "active" } as const,
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
    expect(statusSyncPatch(session, running, previous)).toBeNull();
    expect(statusSyncPatch(session, running, { ...previous, requestId: "new" })).toMatchObject({
      pendingRequestId: "",
      pendingQuestions: [],
    });
  });

  it("clears pendingManualCompact when transitioning from busy to idle", () => {
    const session = {
      ...createSessionEntry(),
      lifecycle: { phase: "active" } as const,
      pendingManualCompact: true,
    };
    const previous = {
      status: "agent",
      kind: null,
      requestId: null,
      featureId: 7,
      seq: 2,
      compacting: true,
    } as const;
    expect(statusSyncPatch(session, { status: "idle", kind: null }, previous)).toMatchObject({
      pendingManualCompact: false,
      lifecycle: { phase: "terminal", reason: "completed" },
    });
    // Staying idle without a busy->idle transition does not clear a fresh compact flag.
    expect(statusSyncPatch(session, { status: "idle", kind: null }, undefined)).toEqual({
      lifecycle: { phase: "terminal", reason: "completed" },
    });
  });
});
