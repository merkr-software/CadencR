import { SessionTransportRegistry } from "./ws-session-transport";
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
    transport: new SessionTransportRegistry(),
    getSession: (sessionId: string): SessionEntry => state.sessions[sessionId],
  };
}

describe("session running source of truth", () => {
  it.each([
    ["COMPACT_REJECTED", "Start the session before using /compact"],
    ["SDK_SPAWN_ERROR", "compact runtime failed to spawn"],
  ])("clears unaccepted manual compact state on backend %s", (code, message) => {
    const session = createSessionEntry();
    session.compactRequestPending = true;
    session.pendingManualCompact = false;
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "error",
      payload: {
        code,
        message,
      },
    });

    const updated = ctx.getSession("s1");
    expect(updated.lifecycle).toEqual({ phase: "idle" });
    expect(updated.compactRequestPending).toBe(false);
    expect(updated.pendingManualCompact).toBe(false);
    expect(updated.blocks.at(-1)?.type).toBe("error");
  });

  it("clears accepted manual compact state on compact failure", () => {
    const session = createSessionEntry();
    session.pendingManualCompact = true;
    session.lifecycle = { phase: "active" };
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "error",
      payload: {
        code: "COMPACT_ERROR",
        message: "compact failed",
      },
    });

    const updated = ctx.getSession("s1");
    expect(updated.pendingManualCompact).toBe(false);
    expect(updated.lifecycle.phase).toBe("error");
    expect(updated.blocks.at(-1)?.type).toBe("error");
  });

  it("ignores stale compact.started after compact failure clears the request", () => {
    const session = createSessionEntry();
    session.compactRequestPending = false;
    session.pendingManualCompact = false;
    session.lifecycle = { phase: "error", message: "compact failed" };
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "compact.started",
      payload: null,
    });

    const updated = ctx.getSession("s1");
    expect(updated.compactRequestPending).toBe(false);
    expect(updated.pendingManualCompact).toBe(false);
    expect(updated.lifecycle).toEqual({ phase: "error", message: "compact failed" });
  });

  it("marks compact accepted only after compact.started", () => {
    const session = createSessionEntry();
    session.compactRequestPending = true;
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "compact.started",
      payload: null,
    });

    const updated = ctx.getSession("s1");
    expect(updated.compactRequestPending).toBe(false);
    expect(updated.pendingManualCompact).toBe(true);
    expect(updated.lifecycle).toEqual({ phase: "idle" });
  });
});
