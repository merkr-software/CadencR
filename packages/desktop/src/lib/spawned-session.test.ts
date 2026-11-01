import { describe, expect, it } from "vitest";
import {
  isAgentCardCarrier,
  isSpawnedSessionCarrier,
  parseSpawnRequest,
  parseSpawnResult,
  spawnResultText,
} from "./spawned-session";

const SPAWN_TOOL = "mcp__cadencr-project__project_spawn_session";
const RESPONSE = JSON.stringify({
  featureId: 2658,
  sessionId: 4167,
  messageId: 2684814,
  project: { id: 3, name: "epay-main", path: "/repos/epay" },
  crossProject: true,
});

describe("spawned session carriers", () => {
  it("recognizes the project spawn tool, not other project tools", () => {
    expect(isSpawnedSessionCarrier({ type: "tool_call", toolName: SPAWN_TOOL })).toBe(true);
    expect(isSpawnedSessionCarrier({ type: "tool_result", toolName: SPAWN_TOOL })).toBe(false);
    expect(
      isSpawnedSessionCarrier({
        type: "tool_call",
        toolName: "mcp__cadencr-project__project_send_session_message",
      }),
    ).toBe(false);
  });

  it("treats provider sub-agents and spawned conversations as agent cards", () => {
    expect(isAgentCardCarrier({ type: "tool_call", toolName: "Agent" })).toBe(true);
    expect(isAgentCardCarrier({ type: "tool_call", toolName: SPAWN_TOOL })).toBe(true);
    expect(isAgentCardCarrier({ type: "tool_call", toolName: "Bash" })).toBe(false);
  });
});

describe("parseSpawnRequest", () => {
  it("reads Claude's flat arguments", () => {
    const request = parseSpawnRequest(
      SPAWN_TOOL,
      JSON.stringify({ title: "Review", provider: "codex_cli", model: "gpt-6.1-sol" }),
    );
    expect(request).toMatchObject({ title: "Review", provider: "codex_cli", model: "gpt-6.1-sol" });
  });

  it("reads Codex's nested MCP call arguments", () => {
    const request = parseSpawnRequest(
      SPAWN_TOOL,
      JSON.stringify({
        server: "cadencr-project",
        tool: "project_spawn_session",
        status: "inProgress",
        arguments: { title: "Fix #351", provider: "claude_code", thinking_level: "high" },
      }),
    );
    expect(request).toMatchObject({
      title: "Fix #351",
      provider: "claude_code",
      model: null,
      thinkingLevel: "high",
    });
  });
});

describe("parseSpawnResult", () => {
  it("reads Claude's MCP content array", () => {
    const result = parseSpawnResult(JSON.stringify([{ type: "text", text: RESPONSE }]));
    expect(result).toEqual({
      featureId: 2658,
      sessionId: 4167,
      projectId: 3,
      projectName: "epay-main",
      crossProject: true,
      dispatchError: null,
    });
  });

  it("reads Codex's whole MCP result", () => {
    const content = JSON.stringify({
      content: [{ type: "text", text: RESPONSE }],
      structuredContent: null,
      _meta: null,
    });
    expect(parseSpawnResult(content)?.featureId).toBe(2658);
  });

  it("reads a bare response and its dispatch error", () => {
    const content = JSON.stringify({ featureId: 7, sessionId: 8, dispatchError: "busy" });
    expect(parseSpawnResult(content)).toMatchObject({ featureId: 7, dispatchError: "busy" });
  });

  it("returns null for an error message", () => {
    const content = JSON.stringify([{ type: "text", text: "Unknown provider: foo" }]);
    expect(parseSpawnResult(content)).toBeNull();
    expect(parseSpawnResult("plain failure")).toBeNull();
    expect(spawnResultText(content)).toBe("Unknown provider: foo");
    expect(spawnResultText("plain failure")).toBe("plain failure");
  });
});
