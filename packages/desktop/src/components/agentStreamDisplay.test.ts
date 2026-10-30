import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import {
  buildDisplayItems,
  countRenderableDisplayRows,
  deriveAgentStreamDisplayBlocks,
  filterRenderableBlocks,
} from "@/lib/agent-stream-display";

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

  it("folds a restart marker into the resume that follows it", () => {
    const marker = block("marker", "restart", { type: "turn_interrupted" });
    const resume = block("resume", "Cadencr restarted while you were working", {
      type: "user_message",
      origin: {
        originKind: "system_generated",
        note: "restart_continuation",
      } as AgentBlockData["origin"],
    });
    const stopped = block("stopped", "", { type: "turn_interrupted" });
    const prompt = block("prompt", "go on", { type: "user_message" });

    expect(filterRenderableBlocks([marker, resume])).toEqual([resume]);
    expect(filterRenderableBlocks([marker, prompt])).toEqual([marker, prompt]);
    expect(filterRenderableBlocks([stopped, resume])).toEqual([stopped, resume]);
    expect(countRenderableDisplayRows([marker, resume])).toBe(1);
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

  it("filters internal runtime calls but preserves shared ToolSearch calls", () => {
    const internal = block("internal", "", { type: "tool_call", toolName: "update_plan" });
    const shared = block("shared", "", { type: "tool_call", toolName: "ToolSearch" });

    expect(filterRenderableBlocks([internal, shared])).toEqual([shared]);
  });

  it("keeps internal runtime errors as standalone compact rows", () => {
    const error = block("internal-error", "Runtime coordination failed", {
      type: "tool_result",
      sourceToolName: "update_plan",
      isError: true,
    });

    expect(filterRenderableBlocks([error])).toEqual([error]);
    expect(buildDisplayItems([error], { compact: true })).toEqual([
      { kind: "block", key: "internal-error", block: error },
    ]);
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

    it("folds a whole tool run into one row, however long", () => {
      const tools = Array.from({ length: 1_000 }, (_, index) =>
        block(`tool-${index}`, "", { type: "tool_call", toolName: "Read" }),
      );

      const items = buildDisplayItems(tools, { compact: true });

      expect(items).toHaveLength(1);
      expect(items[0].key).toBe("flow:tool-0");
      expect(countRenderableDisplayRows(tools, { compactMode: true })).toBe(1);
    });

    it("keeps the run's key when the tail grows", () => {
      const tools = Array.from({ length: 3 }, (_, index) =>
        block(`tool-${index}`, "", { type: "tool_call", toolName: "Read" }),
      );
      const before = buildDisplayItems(tools.slice(0, -1), { compact: true });
      const after = buildDisplayItems(tools, { compact: true });

      expect(after.map((item) => item.key)).toEqual(before.map((item) => item.key));
    });

    it("preserves current row keys and membership across a prepend seam", () => {
      const current = Array.from({ length: 50 }, (_, index) =>
        block(`current-${index}`, "", { type: "tool_call", toolName: "Read" }),
      );
      const older = Array.from({ length: 10 }, (_, index) =>
        block(`older-${index}`, "", { type: "tool_call", toolName: "Read" }),
      );
      const before = buildDisplayItems(current, { compact: true });
      expect(before.map((item) => item.key)).toEqual(["flow:current-0"]);
      const withSeam = [
        ...older,
        { ...current[0], compactFlowBreakBefore: true as const },
        ...current.slice(1),
      ];
      const after = buildDisplayItems(withSeam, { compact: true });

      expect(after.map((item) => item.key)).toEqual(["flow:older-0", "flow:current-0"]);
      const currentRow = after[1];
      if (currentRow.kind !== "flow") throw new Error("expected flow row");
      expect(currentRow.blocks.map((item) => item.id)).toEqual(current.map((item) => item.id));
    });

    it("keeps prose, prompts, plans and subagent output as full rows", () => {
      const read = block("read", "", { type: "tool_call", toolName: "Read" });
      const plan = block("plan", "", { type: "tool_call", toolName: "ExitPlanMode" });
      const agentOutput = block("agent-out", "[]", {
        type: "tool_result",
        sourceToolName: "Agent",
      });
      const code = block("code", "x = 1", { type: "code" });
      const items = buildDisplayItems([read, plan, read, agentOutput, read, code], {
        compact: true,
      });

      expect(items.map((item) => item.key)).toEqual([
        "flow:read",
        "plan",
        "flow:read#1",
        "agent-out",
        "flow:read#2",
        "code",
      ]);
    });

    it("drops a run with no step to draw instead of yielding an empty row", () => {
      const todo = block("todo", "", { type: "tool_call", toolName: "TodoWrite" });
      const bash = block("bash", "", { type: "tool_call", toolName: "Bash" });
      const items = buildDisplayItems(
        [block("a", "before"), todo, block("b", "after"), todo, bash],
        { compact: true },
      );

      expect(items.map((item) => item.key)).toEqual(["a", "b", "flow:todo"]);
      expect(countRenderableDisplayRows([block("a", "before"), todo], { compactMode: true })).toBe(
        1,
      );
    });

    it("starts a fresh row after every flow-breaking row", () => {
      const tools = Array.from({ length: 3 }, (_, index) =>
        block(`tool-${index}`, "", { type: "tool_call", toolName: "Read" }),
      );
      const user = block("user", "continue", { type: "user_message" });
      const items = buildDisplayItems([...tools, user, ...tools.slice(0, 2)], { compact: true });

      expect(items.map((item) => item.kind)).toEqual(["flow", "block", "flow"]);
      expect(items.map((item) => item.key)).toEqual(["flow:tool-0", "user", "flow:tool-0#1"]);
    });
  });

  it("keeps truncated generic results hidden like any other generic result", () => {
    const screenshot = block("screenshot", '[{"type":"image","source":{"data":"iVBOR…', {
      type: "tool_result",
      sourceToolName: "mcp__chrome-devtools__take_screenshot",
      truncatedContent: true,
    });
    const read = block("large-read", "preview", {
      type: "tool_result",
      sourceToolName: "Read",
      truncatedContent: true,
    });
    const call = block("call", "", {
      type: "tool_call",
      toolName: "mcp__chrome-devtools__take_screenshot",
    });

    expect(filterRenderableBlocks([screenshot, read])).toEqual([]);
    expect(countRenderableDisplayRows([screenshot, read], { compactMode: true })).toBe(0);
    // The hidden result no longer splits the compact run around it.
    const items = buildDisplayItems(filterRenderableBlocks([call, screenshot, call]), {
      compact: true,
    });
    expect(items.map((item) => item.kind)).toEqual(["flow"]);
  });

  it("keeps truncated runtime-plumbing calls hidden", () => {
    const call = block("plumbing", "{}", {
      type: "tool_call",
      toolName: "update_plan",
      truncatedContent: true,
    });

    expect(filterRenderableBlocks([call])).toEqual([]);
  });

  it("keeps truncated subagent output as a standalone gated row", () => {
    const result = block("large-agent", "preview", {
      type: "tool_result",
      sourceToolName: "Agent",
      truncatedContent: true,
    });

    expect(filterRenderableBlocks([result])).toEqual([result]);
    expect(buildDisplayItems([result], { compact: true })).toEqual([
      { kind: "block", key: "large-agent", block: result },
    ]);
  });

  it("folds truncated tool previews into the run (their line shows the name only)", () => {
    const patch = block("partial-patch", "preview", {
      type: "tool_call",
      toolName: "apply_patch",
      toolArgs: JSON.stringify({ patchText: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old" }),
      truncatedContent: true,
    });
    const bash = block("partial-command", "preview", {
      type: "tool_call",
      toolName: "Bash",
      toolArgs: JSON.stringify({ command: "printf partial" }),
      truncatedContent: true,
    });

    expect(buildDisplayItems([patch, bash], { compact: true })).toEqual([
      { kind: "flow", key: "flow:partial-patch", blocks: [patch, bash] },
    ]);
  });
});
