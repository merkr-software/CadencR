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

describe("generated canonical user messages", () => {
  it("preserves generated-message origin on the canonical event", () => {
    const ctx = createTestContext(createSessionEntry());

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "user_message",
      payload: {
        message_id: 42,
        message_uuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
        text: "delegated prompt",
        created_at: "2026-07-12T20:00:00Z",
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
