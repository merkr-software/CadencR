import { SessionTransportRegistry } from "./ws-session-transport";
import { describe, expect, it, vi } from "vitest";

import { handleEnvelope, type StoreAccessors } from "./ws-envelope-handler";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

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

describe("session action dispatch", () => {
  it("warns and drops an envelope whose action is not in the contract", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createTestContext(createSessionEntry());

    expect(() =>
      handleEnvelope(ctx, "s1", {
        domain: "session",
        action: "totally_made_up_action",
        payload: {},
      }),
    ).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      "[ws-session] unknown session action; dropping envelope",
      "totally_made_up_action",
    );
    warnSpy.mockRestore();
  });

  it("silently ignores the intentional-no-op branch.forked broadcast", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createTestContext(createSessionEntry());

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "branch.forked",
      payload: { message_id: 7 },
    });

    // No warning: branch.forked is a known action deliberately left unhandled.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
