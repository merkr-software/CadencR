import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "./AgentBlock";
import {
  buildDisplayItems,
  countRenderableDisplayRows,
  deriveAgentStreamDisplayBlocks,
  filterRenderableBlocks,
} from "./agentStreamDisplay";

function block(id: string, content: string, extra: Partial<AgentBlockData> = {}): AgentBlockData {
  return { id, type: "text", content, ...extra };
}

describe("agentStreamDisplay", () => {
  it("filters rows the renderer returns null for", () => {
    const visibleText = block("text", "visible");
    const emptyThinking = block("empty-thinking", "", { type: "thinking" });
    const hiddenToolResult = block("hidden-result", "read output", {
      type: "tool_result",
      sourceToolName: "Read",
    });

    expect(filterRenderableBlocks([visibleText, emptyThinking, hiddenToolResult])).toEqual([
      visibleText,
    ]);
  });

  it("keeps only Agent and Task tool results that render standalone", () => {
    const bashResult = block("bash", "bash output", {
      type: "tool_result",
      sourceToolName: "Bash",
    });
    const taskResult = block("task", "task output", {
      type: "tool_result",
      sourceToolName: "Task",
    });
    const editResult = block("edit", "changed file", {
      type: "tool_result",
      sourceToolName: "Edit",
    });

    expect(filterRenderableBlocks([bashResult, taskResult, editResult])).toEqual([taskResult]);
  });

  it("excludes child rows from the root agent stream display", () => {
    const root = block("root", "root");
    const child = block("child", "child", { parentToolUseId: "task-1" });

    expect(deriveAgentStreamDisplayBlocks([root, child])).toEqual([root]);
  });

  it("does not merge a prepended text block into the previously first visible row", () => {
    const createdAt = "2026-04-12T12:09:36Z";
    const previousFirst = block("current-first", "current", {
      createdAt,
      model: "openai/gpt-5.3-codex",
    });
    const prepended = block("older", "older", {
      createdAt,
      model: "openai/gpt-5.3-codex",
    });

    const displayBlocks = deriveAgentStreamDisplayBlocks([prepended, previousFirst]);

    expect(displayBlocks.map((item) => item.id)).toEqual(["older", "current-first"]);
    expect(displayBlocks[1]).toBe(previousFirst);
  });

  it("counts prepended rows after filtering hidden rows and child rows", () => {
    const current = [block("current", "current")];
    const next = [
      block("hidden", "hidden", { type: "tool_result", sourceToolName: "Read" }),
      block("child", "child", { parentToolUseId: "task-1" }),
      block("older-1", "older 1"),
      block("older-2", "older 2", { type: "thinking", content: "thinking" }),
      ...current,
    ];

    expect(countRenderableDisplayRows(next.slice(0, -current.length))).toBe(2);
  });

  it("returns zero renderable rows for batches that only contain hidden rows", () => {
    expect(
      countRenderableDisplayRows([
        block("hidden", "hidden", { type: "tool_result", sourceToolName: "Read" }),
        block("child", "child", { parentToolUseId: "task-1" }),
      ]),
    ).toBe(0);
  });

  it("counts summary-mode rows as the collapsed row count (recap + final text)", () => {
    const turn = [
      block("u1", "prompt", { type: "user_message" }),
      block("t1", "read", { type: "tool_call", toolName: "Read" }),
      block("t2", "read", { type: "tool_call", toolName: "Read" }),
      block("t3", "bash", { type: "tool_call", toolName: "Bash" }),
      block("m0", "preamble"),
      block("m1", "final answer"),
    ];
    // Raw: user + 3 tools + 2 text = 6 rows. Summary: user + recap + final = 3.
    expect(countRenderableDisplayRows(turn)).toBe(6);
    expect(countRenderableDisplayRows(turn, { summaryMode: true })).toBe(3);
  });

  describe("buildDisplayItems (compact mode grouping)", () => {
    it("wraps every block in its own item when compact is off", () => {
      const text = block("t1", "hello");
      const bash = block("b1", "ls", { type: "tool_call", toolName: "Bash" });
      const items = buildDisplayItems([text, bash], { compact: false });
      expect(items.map((item) => item.kind)).toEqual(["block", "block"]);
      expect(items.map((item) => item.key)).toEqual(["t1", "b1"]);
    });

    it("groups consecutive non-text blocks into a flow row when compact is on", () => {
      const text = block("t1", "hello");
      const bash = block("b1", "ls", { type: "tool_call", toolName: "Bash" });
      const edit = block("e1", "edit", { type: "tool_call", toolName: "Edit" });
      const thinking = block("th1", "thinking…", { type: "thinking" });
      const user = block("u1", "user said", { type: "user_message" });
      const followup = block("th2", "thinking again", { type: "thinking" });

      const items = buildDisplayItems([text, bash, edit, thinking, user, followup], {
        compact: true,
      });

      expect(items.map((item) => item.kind)).toEqual([
        "block", // text
        "flow", // [bash, edit, thinking]
        "block", // user
        "flow", // [followup]
      ]);
      const flow = items[1];
      if (flow.kind !== "flow") throw new Error("expected flow row");
      expect(flow.blocks.map((b) => b.id)).toEqual(["b1", "e1", "th1"]);
    });

    it("deduplicates item keys when block ids repeat", () => {
      const a = block("dup", "first");
      const b = block("dup", "second");
      const items = buildDisplayItems([a, b], { compact: false });
      expect(items.map((item) => item.key)).toEqual(["dup", "dup#1"]);
    });
  });
});
