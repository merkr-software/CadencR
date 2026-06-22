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

describe("generated user_message mirrors", () => {
  it("preserves generated-message origin on mirrored prompts", () => {
    const ctx = createTestContext(createSessionEntry());

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "user_message",
      payload: {
        text: "delegated prompt",
        origin: {
          originKind: "session_generated",
          sourceSessionId: 123,
          note: "delegated by MCP",
        },
      },
    });

    const last = ctx.getSession("s1").blocks.at(-1);
    expect(last?.type).toBe("user_message");
    expect(last?.content).toBe("delegated prompt");
    expect(last?.origin?.originKind).toBe("session_generated");
    expect(last?.origin?.sourceSessionId).toBe(123);
    expect(last?.origin?.note).toBe("delegated by MCP");
  });
});
