import { describe, expect, it } from "vitest";

import {
  handleInitialized,
  handleMcpServers,
  handlePromptPersisted,
} from "./ws-envelope-session-handlers";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import type { StoreAccessors } from "./ws-envelope-types";

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

describe("handleInitialized", () => {
  it("copies the numeric backend session id into sessionDbId for live status lookup", () => {
    const ctx = createTestContext(createSessionEntry());

    handleInitialized(ctx, "s1", {
      session_id: "123",
      provider: "codex_cli",
    });

    expect(ctx.getSession("s1").serverSessionId).toBe("123");
    expect(ctx.getSession("s1").sessionDbId).toBe(123);
  });
});

describe("handlePromptPersisted", () => {
  it("stamps the persisted DB id on the live block matched by client id", () => {
    const session: SessionEntry = {
      ...createSessionEntry(),
      blocks: [
        {
          id: "ws-user-1",
          type: "user_message",
          content: "hello",
          clientMessageId: "ref-1",
        },
      ],
    };
    const ctx = createTestContext(session);

    handlePromptPersisted(ctx, "s1", { user_message_ref: "ref-1", message_id: 99 });

    expect(ctx.getSession("s1").blocks[0].messageDbId).toBe(99);
    expect(ctx.getSession("s1").blocks[0].id).toBe("ws-user-1");
  });

  it("ignores a payload with no message id", () => {
    const ctx = createTestContext(createSessionEntry());
    handlePromptPersisted(ctx, "s1", { user_message_ref: "ref-1" });
    expect(ctx.getSession("s1").blocks).toEqual([]);
  });
});

describe("handleMcpServers", () => {
  it("stores every reported MCP status on the active session", () => {
    const ctx = createTestContext(createSessionEntry());

    handleMcpServers(ctx, "s1", {
      mcp_servers: [
        { name: "cadencr-browser", status: "connected" },
        { name: "filesystem", status: "unavailable" },
        { name: "browser", status: "unknown" },
      ],
    });

    expect(ctx.getSession("s1").mcpServers).toEqual([
      { name: "cadencr-browser", status: "connected" },
      { name: "filesystem", status: "unavailable" },
      { name: "browser", status: "unknown" },
    ]);
  });
});
