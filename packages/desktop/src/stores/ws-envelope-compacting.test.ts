import { describe, expect, it } from "vitest";

import { handleEnvelope, type StoreAccessors } from "./ws-envelope-handler";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";

function createTestContext(session: SessionEntry): StoreAccessors {
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;

  return {
    get: (): WsSessionStore => state,
    set: (partial: Partial<WsSessionStore>): void => {
      state = { ...state, ...partial };
    },
    getSession: (sessionId: string): SessionEntry => state.sessions[sessionId],
  };
}

function sendCompacting(ctx: StoreAccessors, active: boolean): void {
  handleEnvelope(ctx, "s1", {
    domain: "session",
    action: "compacting",
    payload: { active },
  });
}

function sendError(ctx: StoreAccessors): void {
  handleEnvelope(ctx, "s1", {
    domain: "session",
    action: "error",
    payload: { code: "SDK_ERROR", message: "boom" },
  });
}

function sendTurnComplete(ctx: StoreAccessors): void {
  handleEnvelope(ctx, "s1", {
    domain: "session",
    action: "turn_complete",
    payload: { reason: "turn_complete" },
  });
}

function sendCompactOk(ctx: StoreAccessors): void {
  handleEnvelope(ctx, "s1", {
    domain: "session",
    action: "compact.ok",
    payload: null,
  });
}

describe("handleEnvelope session.compacting", () => {
  it("sets runtimeCompacting from the backend-confirmed compaction signal", () => {
    const session = createSessionEntry();
    const ctx = createTestContext(session);

    sendCompacting(ctx, true);

    expect(ctx.getSession("s1").runtimeCompacting).toBe(true);
  });

  it("clears runtimeCompacting without clearing pending manual compaction", () => {
    const session = createSessionEntry();
    session.runtimeCompacting = true;
    session.pendingManualCompact = true;
    const ctx = createTestContext(session);

    sendCompacting(ctx, false);

    const updated = ctx.getSession("s1");
    expect(updated.runtimeCompacting).toBe(false);
    expect(updated.pendingManualCompact).toBe(true);
  });

  it("clears runtimeCompacting when the session errors", () => {
    const session = createSessionEntry();
    session.runtimeCompacting = true;
    const ctx = createTestContext(session);

    sendError(ctx);

    expect(ctx.getSession("s1").runtimeCompacting).toBe(false);
  });

  it("clears runtimeCompacting when the turn completes", () => {
    const session = createSessionEntry();
    session.runtimeCompacting = true;
    const ctx = createTestContext(session);

    sendTurnComplete(ctx);

    expect(ctx.getSession("s1").runtimeCompacting).toBe(false);
  });

  it("clears runtimeCompacting when manual compact completes", () => {
    const session = createSessionEntry();
    session.runtimeCompacting = true;
    const ctx = createTestContext(session);

    sendCompactOk(ctx);

    expect(ctx.getSession("s1").runtimeCompacting).toBe(false);
  });
});
