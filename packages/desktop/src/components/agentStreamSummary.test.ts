import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "./AgentBlock";
import { collapseTurnsToSummary } from "./agentStreamSummary";

function user(id: string, content = "hi"): AgentBlockData {
  return { id, type: "user_message", content };
}
function tool(id: string, toolName: string): AgentBlockData {
  return { id, type: "tool_call", content: "", toolName };
}
function text(id: string, content = "done"): AgentBlockData {
  return { id, type: "text", content };
}

/** Extract the recap counts from the single tool_summary block in `blocks`. */
function summaryOf(blocks: AgentBlockData[]): Record<string, number> {
  const block = blocks.find((b) => b.type === "tool_summary");
  if (!block?.summaryCounts) return {};
  return Object.fromEntries(block.summaryCounts.map((c) => [c.name, c.count]));
}

describe("collapseTurnsToSummary", () => {
  it("folds a turn's tool calls into one recap before the final text", () => {
    const result = collapseTurnsToSummary([
      user("u1"),
      tool("t1", "Read"),
      tool("t2", "Read"),
      tool("t3", "Bash"),
      text("m1", "all done"),
    ]);

    expect(result.map((b) => b.type)).toEqual(["user_message", "tool_summary", "text"]);
    expect(summaryOf(result)).toEqual({ Read: 2, Bash: 1 });
    expect(result[2].content).toBe("all done");
  });

  it("keeps only the final text of a turn, dropping preamble text", () => {
    const result = collapseTurnsToSummary([
      user("u1"),
      text("m0", "let me check"),
      tool("t1", "Read"),
      text("m1", "here is the answer"),
    ]);

    expect(result.map((b) => b.type)).toEqual(["user_message", "tool_summary", "text"]);
    const texts = result.filter((b) => b.type === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].content).toBe("here is the answer");
  });

  it("counts tool groups automatically without a hardcoded tool list", () => {
    const result = collapseTurnsToSummary([
      user("u1"),
      tool("t1", "SomeBrandNewTool"),
      tool("t2", "SomeBrandNewTool"),
      text("m1"),
    ]);
    expect(summaryOf(result)).toEqual({ SomeBrandNewTool: 2 });
  });

  it("keeps a stable recap id anchored on the first tool of the segment", () => {
    const partial = collapseTurnsToSummary([user("u1"), tool("t1", "Read")]);
    const grown = collapseTurnsToSummary([user("u1"), tool("t1", "Read"), tool("t2", "Bash")]);
    const idOf = (blocks: AgentBlockData[]): string | undefined =>
      blocks.find((b) => b.type === "tool_summary")?.id;
    expect(idOf(partial)).toBe(idOf(grown));
  });

  it("drops thinking and tool_result noise but preserves text", () => {
    const result = collapseTurnsToSummary([
      user("u1"),
      { id: "th1", type: "thinking", content: "musing" },
      tool("t1", "Grep"),
      { id: "r1", type: "tool_result", content: "…", sourceToolName: "Grep" },
      text("m1"),
    ]);
    expect(result.map((b) => b.type)).toEqual(["user_message", "tool_summary", "text"]);
  });

  it("excludes TodoWrite and task-todo tools from the recap", () => {
    const result = collapseTurnsToSummary([
      user("u1"),
      tool("t1", "TodoWrite"),
      tool("t2", "TaskCreate"),
      tool("t3", "Read"),
      text("m1"),
    ]);
    expect(summaryOf(result)).toEqual({ Read: 1 });
  });

  it("emits one recap per turn — mid-turn steering starts a fresh segment", () => {
    const result = collapseTurnsToSummary([
      user("u1"),
      tool("t1", "Read"),
      text("m1", "first"),
      user("u2", "actually also do this"),
      tool("t2", "Bash"),
      tool("t3", "Bash"),
      text("m2", "second"),
    ]);

    expect(result.map((b) => b.type)).toEqual([
      "user_message",
      "tool_summary",
      "text",
      "user_message",
      "tool_summary",
      "text",
    ]);
    const summaries = result.filter((b) => b.type === "tool_summary");
    expect(summaries[0].summaryCounts).toEqual([{ name: "Read", count: 1 }]);
    expect(summaries[1].summaryCounts).toEqual([{ name: "Bash", count: 2 }]);
  });

  it("emits no recap for a text-only turn", () => {
    const result = collapseTurnsToSummary([user("u1"), text("m1")]);
    expect(result.map((b) => b.type)).toEqual(["user_message", "text"]);
  });

  it("leaves the in-flight turn uncollapsed while streaming, collapsing finished turns", () => {
    const result = collapseTurnsToSummary(
      [
        user("u1"),
        tool("t1", "Read"),
        text("m1", "first done"),
        user("u2", "now this"),
        tool("t2", "Bash"),
        text("m2", "still working"),
      ],
      { activeStreaming: true },
    );

    // First (finished) turn folds to a recap; the last (active) turn streams raw.
    expect(result.map((b) => b.type)).toEqual([
      "user_message",
      "tool_summary",
      "text",
      "user_message",
      "tool_call",
      "text",
    ]);
    expect(result[5].content).toBe("still working");
  });

  it("collapses every turn once streaming stops", () => {
    const blocks = [user("u1"), tool("t1", "Read"), text("m1", "done")];
    const streaming = collapseTurnsToSummary(blocks, { activeStreaming: true });
    const idle = collapseTurnsToSummary(blocks, { activeStreaming: false });
    expect(streaming.map((b) => b.type)).toEqual(["user_message", "tool_call", "text"]);
    expect(idle.map((b) => b.type)).toEqual(["user_message", "tool_summary", "text"]);
  });

  it("carries the turn detail (all but the final message) on the recap's childBlocks", () => {
    const blocks = [
      user("u1"),
      tool("t1", "Read"),
      text("m0", "preamble"),
      tool("t2", "Bash"),
      text("m1", "final"),
    ];
    const result = collapseTurnsToSummary(blocks);
    // Row structure is unchanged by expansion — the detail rides on the recap
    // block and is revealed inline by the renderer, not as extra rows.
    expect(result.map((b) => b.type)).toEqual(["user_message", "tool_summary", "text"]);
    const recap = result.find((b) => b.type === "tool_summary");
    expect(recap?.id).toBe("tool-summary-t1");
    // childBlocks = every body block except the final text (shown separately).
    expect(recap?.childBlocks?.map((b) => b.id)).toEqual(["t1", "m0", "t2"]);
    expect(result[2].content).toBe("final");
  });

  it("collapses a pending steering message segment without a recap", () => {
    // While a steering prompt is pinned to the tail it has no tools yet.
    const result = collapseTurnsToSummary([
      user("u1"),
      tool("t1", "Read"),
      text("m1"),
      user("u2", "steer"),
    ]);
    expect(result.map((b) => b.type)).toEqual([
      "user_message",
      "tool_summary",
      "text",
      "user_message",
    ]);
  });
});
