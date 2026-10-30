import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "./AgentBlock";
import { collapseTurnsToSummary } from "./agentStreamSummary";
import { buildToolChips } from "./agentStreamToolChips";
import { upsertCanonicalUserMessage } from "@/stores/ws-user-message-reconciliation";

function user(id: string, content = "hi"): AgentBlockData {
  return { id, type: "user_message", content };
}
/** A steer message that's been sent but not yet acknowledged by the agent. */
function pendingUser(id: string, content = "steer"): AgentBlockData {
  return { id, type: "user_message", content, promptDeliveryState: "pending_agent" };
}
function tool(id: string, toolName: string): AgentBlockData {
  return { id, type: "tool_call", content: "", toolName };
}
function text(id: string, content = "done"): AgentBlockData {
  return { id, type: "text", content };
}

/** Extract the recap chip counts from the single tool_summary block in `blocks`. */
function summaryOf(blocks: AgentBlockData[]): Record<string, number> {
  const block = blocks.find((b) => b.type === "tool_summary");
  if (!block?.childBlocks) return {};
  return Object.fromEntries(buildToolChips(block.childBlocks).map((c) => [c.label, c.count]));
}

describe("collapseTurnsToSummary", () => {
  it.each(["", " \n\t"])("ignores trailing empty text %j before compaction", (empty) => {
    const divider: AgentBlockData = { id: "compact", type: "compact_divider", content: "" };
    const blocks = [user("u"), tool("tool", "Read"), text("answer"), text("empty", empty), divider];
    const result = collapseTurnsToSummary(blocks);
    expect(result.map((block) => block.id)).toEqual([
      "u",
      "tool-summary-tool",
      "answer",
      "compact",
    ]);
    expect(result[1].childBlocks?.map((block) => block.id)).toEqual(["tool", "empty"]);
    expect(
      collapseTurnsToSummary([user("u"), text("answer"), text("empty", empty)]).map(
        (block) => block.id,
      ),
    ).toEqual(["u", "answer"]);
  });

  it("preserves active placeholders and removes empty-only final messages when idle", () => {
    const blocks = [user("u"), tool("tool", "Read"), text("empty", "")];
    expect(collapseTurnsToSummary(blocks, { activeStreaming: true })).toEqual(blocks);
    expect(collapseTurnsToSummary(blocks).map((block) => block.type)).toEqual([
      "user_message",
      "tool_summary",
    ]);
  });

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

  it("keeps the sub-agents a turn launched as their own rows around the recap", () => {
    const result = collapseTurnsToSummary([
      user("u"),
      tool("explore", "Agent"),
      tool("read", "Read"),
      tool("review", "Task"),
      text("answer"),
    ]);
    expect(result.map((block) => block.id)).toEqual([
      "u",
      "explore",
      "tool-summary-read",
      "review",
      "answer",
    ]);
    expect(summaryOf(result)).toEqual({ Read: 1 });
    expect(result[2].childBlocks?.map((block) => block.id)).toEqual(["read"]);
  });

  it("keeps a turn's only sub-agent without an empty recap", () => {
    const result = collapseTurnsToSummary([user("u"), tool("explore", "Agent"), text("answer")]);
    expect(result.map((block) => block.id)).toEqual(["u", "explore", "answer"]);
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

  it("keeps errors from hidden runtime tools visible outside the recap", () => {
    const error: AgentBlockData = {
      id: "r1",
      type: "tool_result",
      content: "Runtime coordination failed",
      sourceToolName: "update_plan",
      isError: true,
    };
    const result = collapseTurnsToSummary([
      user("u1"),
      tool("hidden", "update_plan"),
      error,
      text("m1"),
    ]);

    expect(result).toEqual([user("u1"), error, text("m1")]);
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
    const labelCounts = (b: AgentBlockData): Array<{ label: string; count: number }> =>
      buildToolChips(b.childBlocks ?? []).map((c) => ({ label: c.label, count: c.count }));
    expect(labelCounts(summaries[0])).toEqual([{ label: "Read", count: 1 }]);
    expect(labelCounts(summaries[1])).toEqual([{ label: "Bash", count: 2 }]);
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

  it("keeps a pending steer message inside the live turn until the agent receives it", () => {
    // The canonical steer has persisted, but the agent hasn't acknowledged it
    // yet, so the in-flight turn must NOT collapse around it.
    const blocks = [
      user("u1"),
      tool("t1", "Read"),
      text("m1", "first done"),
      pendingUser("u2", "actually also do this"),
    ];
    const result = collapseTurnsToSummary(blocks, { activeStreaming: true });

    // No new segment: the whole thing is still one live turn streaming raw.
    expect(result.map((b) => b.type)).toEqual([
      "user_message",
      "tool_call",
      "text",
      "user_message",
    ]);
    expect(result.some((b) => b.type === "tool_summary")).toBe(false);
  });

  it("starts a fresh segment once the steer message is received by the agent", () => {
    // Same blocks, but the steer has flipped to received (no promptDeliveryState).
    const blocks = [
      user("u1"),
      tool("t1", "Read"),
      text("m1", "first done"),
      user("u2", "actually also do this"),
      tool("t2", "Bash"),
      text("m2", "second"),
    ];
    const result = collapseTurnsToSummary(blocks, { activeStreaming: true });

    // First turn folds; the received steer opens the new (live) turn.
    expect(result.map((b) => b.type)).toEqual([
      "user_message",
      "tool_summary",
      "text",
      "user_message",
      "tool_call",
      "text",
    ]);
  });

  it("collapses a pending steering message segment without a recap", () => {
    const pending = {
      ...user("u2", "steer"),
      promptDeliveryState: "pending_agent" as const,
    };
    // A steering prompt with no following tools has no recap of its own.
    const result = collapseTurnsToSummary([user("u1"), tool("t1", "Read"), text("m1"), pending]);
    expect(result.map((b) => b.type)).toEqual([
      "user_message",
      "tool_summary",
      "text",
      "user_message",
    ]);
  });

  it("keeps an unknown-delivery steer visible without attributing later output to it", () => {
    const unknown: AgentBlockData = {
      ...user("u2", "steer"),
      promptDeliveryState: "delivery_unknown",
    };
    const result = collapseTurnsToSummary([
      user("u1"),
      tool("t1", "Read"),
      text("m1", "first"),
      unknown,
      tool("t2", "Bash"),
      text("m2", "second"),
    ]);

    expect(result.map((block) => block.type)).toEqual([
      "user_message",
      "tool_summary",
      "text",
      "user_message",
      "tool_summary",
      "text",
    ]);
  });

  it("does not open a turn boundary for a delivery-failed steer", () => {
    const failed: AgentBlockData = {
      ...user("u2", "steer"),
      promptDeliveryState: "delivery_failed",
    };
    const result = collapseTurnsToSummary([
      user("u1"),
      tool("t1", "Read"),
      text("m1", "first"),
      failed,
      tool("t2", "Bash"),
      text("m2", "second"),
    ]);

    expect(result.map((block) => block.id)).toEqual([
      "u1",
      "tool-summary-t1",
      "m1",
      "u2",
      "tool-summary-t2",
      "m2",
    ]);
  });

  it("preserves canonical user identity and count across full and summary projections", () => {
    const canonical = {
      messageId: 42,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      text: "hello",
      createdAt: "2026-07-12T20:00:00Z",
    };
    const once = upsertCanonicalUserMessage([], canonical);
    const deduplicated = upsertCanonicalUserMessage(once, canonical);
    const full = [...deduplicated, tool("t1", "Read"), text("m1", "done")];
    const summary = collapseTurnsToSummary(full);

    const fullUsers = full.filter((block) => block.type === "user_message");
    const summaryUsers = summary.filter((block) => block.type === "user_message");
    expect(fullUsers).toHaveLength(1);
    expect(summaryUsers).toHaveLength(1);
    expect(summaryUsers[0]).toBe(fullUsers[0]);
    expect(summaryUsers[0]).toMatchObject({
      id: "msg-42",
      messageUuid: canonical.messageUuid,
    });
  });
});
