import { describe, expect, it } from "vitest";
import { createSessionEntry, markLastPlanBlock, updateSession } from "./ws-session-types";
import type { AgentBlockData } from "@/types/agent-block";

describe("markLastPlanBlock", () => {
  it("marks ExitPlanMode blocks as approval blocks", () => {
    const blocks: AgentBlockData[] = [
      {
        id: "plan",
        type: "tool_call",
        content: "",
        toolName: "ExitPlanMode",
      },
    ];

    expect(markLastPlanBlock(blocks, "approved")[0].planApprovalStatus).toBe("approved");
  });
});

describe("updateSession turn summaries", () => {
  it("does not append a turn summary when an empty placeholder lifecycle settles idle", () => {
    const base = {
      sessions: {
        s1: createSessionEntry(),
      },
    };

    const pausedPatch = updateSession(base, "s1", {
      lifecycle: { phase: "paused", reason: "user" },
    });
    const paused = { ...base, ...pausedPatch };

    const terminalPatch = updateSession(paused, "s1", {
      lifecycle: { phase: "terminal", reason: "completed" },
    });
    const terminal = { ...paused, ...terminalPatch };

    expect(terminal.sessions.s1.blocks).toEqual([]);
    expect(terminal.sessions.s1.lifecycle).toEqual({ phase: "idle" });
    expect(terminal.sessions.s1.turnTiming.startedAt).toBeNull();
  });

  it("keeps a completed lifecycle when a terminal patch includes content", () => {
    const contentBlock: AgentBlockData = { id: "msg-1", type: "text", content: "done" };
    const base = {
      sessions: {
        s1: createSessionEntry(),
      },
    };

    const pausedPatch = updateSession(base, "s1", {
      lifecycle: { phase: "paused", reason: "user" },
    });
    const paused = { ...base, ...pausedPatch };

    const terminalPatch = updateSession(paused, "s1", {
      blocks: [contentBlock],
      lifecycle: { phase: "terminal", reason: "completed" },
    });
    const terminal = { ...paused, ...terminalPatch };

    expect(terminal.sessions.s1.lifecycle).toEqual({ phase: "terminal", reason: "completed" });
    expect(terminal.sessions.s1.blocks[0]).toBe(contentBlock);
  });
});
