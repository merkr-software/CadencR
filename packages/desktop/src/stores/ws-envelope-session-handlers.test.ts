import { SessionTransportRegistry } from "./ws-session-transport";
import { describe, expect, it } from "vitest";

import { handleInitialized, handleMcpServers } from "./ws-envelope-session-handlers";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import type { StoreAccessors } from "./ws-envelope-types";

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

  it("restores backend-confirmed fast mode", () => {
    const ctx = createTestContext(createSessionEntry());

    handleInitialized(ctx, "s1", {
      session_id: "123",
      provider: "codex_cli",
      fast_mode: true,
    });

    expect(ctx.getSession("s1").fastMode).toBe(true);
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
