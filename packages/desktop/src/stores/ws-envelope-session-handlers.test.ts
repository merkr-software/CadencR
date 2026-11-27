import { SessionTransportRegistry } from "./ws-session-transport";
import { describe, expect, it } from "vitest";

import {
  handleInitialized,
  handleMcpServers,
  handlePermissionRequest,
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
    handleInitialized(ctx, "s1", { session_id: "123" });

    handleMcpServers(ctx, "s1", {
      session_id: "123",
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
    expect(ctx.getSession("s1").mcpServersError).toBeNull();
  });

  it("keeps a failed read apart from an empty list, and clears it once read", () => {
    const ctx = createTestContext(createSessionEntry());
    handleInitialized(ctx, "s1", { session_id: "123" });

    handleMcpServers(ctx, "s1", {
      session_id: "123",
      mcp_servers: [],
      error: "The agent's MCP servers could not be read: timed out",
    });
    expect(ctx.getSession("s1").mcpServers).toEqual([]);
    expect(ctx.getSession("s1").mcpServersError).toBe(
      "The agent's MCP servers could not be read: timed out",
    );

    handleMcpServers(ctx, "s1", { session_id: "123", mcp_servers: [] });
    expect(ctx.getSession("s1").mcpServersError).toBeNull();
  });

  it("ignores a sibling conversation's snapshots and frames without a session ID", () => {
    const ctx = createTestContext(createSessionEntry());
    const servers = [{ name: "cadencr-browser", status: "connected" }];
    handleMcpServers(ctx, "s1", { session_id: "123", mcp_servers: servers });
    expect(ctx.getSession("s1").mcpServers).toBeNull();

    handleInitialized(ctx, "s1", { session_id: "123" });
    handleMcpServers(ctx, "s1", { session_id: "123", mcp_servers: servers });
    handleMcpServers(ctx, "s1", { session_id: "456", mcp_servers: [] });
    handleMcpServers(ctx, "s1", { mcp_servers: [] });
    expect(ctx.getSession("s1").mcpServers).toEqual(servers);
  });
});

describe("handlePermissionRequest (AskUserQuestion)", () => {
  const ask = (requestId: string, question: string): Record<string, unknown> => ({
    request_id: requestId,
    tool_name: "AskUserQuestion",
    tool_input: { question },
  });

  it("keeps the waiting question's list when a reconnect re-sends it", () => {
    const ctx = createTestContext(createSessionEntry());
    handlePermissionRequest(ctx, "s1", ask("r1", "Which delimiter?"));
    const first = ctx.getSession("s1").pendingQuestions;
    expect(first).toHaveLength(1);

    handlePermissionRequest(ctx, "s1", ask("r1", "Which delimiter?"));
    expect(ctx.getSession("s1").pendingQuestions).toBe(first);

    handlePermissionRequest(ctx, "s1", ask("r2", "Header row?"));
    expect(ctx.getSession("s1").pendingQuestions).not.toBe(first);
    expect(ctx.getSession("s1").pendingQuestions?.[0]?.question).toBe("Header row?");
  });
});
