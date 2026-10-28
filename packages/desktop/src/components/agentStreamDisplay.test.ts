import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "./AgentBlock";
import {
  buildDisplayItems,
  countRenderableDisplayRows,
  deriveAgentStreamDisplayBlocks,
  filterRenderableBlocks,
  MAX_COMPACT_FLOW_BLOCKS,
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

    it("splits long tool runs into bounded outer Virtuoso rows", () => {
      const tools = Array.from({ length: 1_000 }, (_, index) =>
        block(`tool-${index}`, "", { type: "tool_call", toolName: "Read" }),
      );

      const items = buildDisplayItems(tools, { compact: true });
      const flows = items.filter((item) => item.kind === "flow");

      expect(flows).toHaveLength(Math.ceil(tools.length / MAX_COMPACT_FLOW_BLOCKS));
      expect(Math.max(...flows.map((item) => item.blocks.length))).toBe(MAX_COMPACT_FLOW_BLOCKS);
      expect(flows.flatMap((item) => item.blocks.map((item) => item.id))).toEqual(
        tools.map((item) => item.id),
      );
      expect(countRenderableDisplayRows(tools, { compactMode: true })).toBe(flows.length);
    });

    it("keeps completed compact chunks stable when a tool crosses a chunk boundary", () => {
      const tools = Array.from({ length: MAX_COMPACT_FLOW_BLOCKS + 1 }, (_, index) =>
        block(`tool-${index}`, "", { type: "tool_call", toolName: "Read" }),
      );
      const before = buildDisplayItems(tools.slice(0, -1), { compact: true });
      const after = buildDisplayItems(tools, { compact: true });

      expect(before).toHaveLength(1);
      expect(after).toHaveLength(2);
      expect(after[0].key).toBe(before[0].key);
      expect(after[0].kind).toBe("flow");
      if (after[0].kind !== "flow") throw new Error("expected first compact chunk");
      expect(after[0].blocks.map((item) => item.id)).toEqual(
        tools.slice(0, MAX_COMPACT_FLOW_BLOCKS).map((item) => item.id),
      );
      expect(after[1].key).toBe(`flow:tool-${MAX_COMPACT_FLOW_BLOCKS}`);
    });

    it.each([10, 30])(
      "preserves current chunk keys and membership across a %i-tool prepend seam",
      (olderCount) => {
        const current = Array.from({ length: 1_000 }, (_, index) =>
          block(`current-${index}`, "", { type: "tool_call", toolName: "Read" }),
        );
        const older = Array.from({ length: olderCount }, (_, index) =>
          block(`older-${index}`, "", { type: "tool_call", toolName: "Read" }),
        );
        const before = buildDisplayItems(current, { compact: true });
        const withSeam = [
          ...older,
          { ...current[0], compactFlowBreakBefore: true as const },
          ...current.slice(1),
        ];
        const after = buildDisplayItems(withSeam, { compact: true });
        const firstCurrentRow = after.findIndex((item) => item.key === before[0].key);

        expect(firstCurrentRow).toBe(Math.ceil(olderCount / MAX_COMPACT_FLOW_BLOCKS));
        expect(after.slice(firstCurrentRow).map((item) => item.key)).toEqual(
          before.map((item) => item.key),
        );
        expect(
          after
            .slice(firstCurrentRow)
            .map((item) =>
              item.kind === "flow" ? item.blocks.map((block) => block.id) : [item.block.id],
            ),
        ).toEqual(
          before.map((item) =>
            item.kind === "flow" ? item.blocks.map((block) => block.id) : [item.block.id],
          ),
        );
      },
    );

    it("starts a fresh chunk after every flow-breaking row", () => {
      const tools = Array.from({ length: MAX_COMPACT_FLOW_BLOCKS + 2 }, (_, index) =>
        block(`tool-${index}`, "", { type: "tool_call", toolName: "Read" }),
      );
      const user = block("user", "continue", { type: "user_message" });
      const items = buildDisplayItems([...tools, user, ...tools.slice(0, 2)], { compact: true });

      expect(items.map((item) => item.kind)).toEqual(["flow", "flow", "block", "flow"]);
      expect(items.map((item) => item.key)).toEqual([
        "flow:tool-0",
        `flow:tool-${MAX_COMPACT_FLOW_BLOCKS}`,
        "user",
        "flow:tool-0#1",
      ]);
    });
  });

  it("keeps truncated generic results as standalone rows in compact mode", () => {
    const result = block("large-result", "preview", {
      type: "tool_result",
      sourceToolName: "Read",
      truncatedContent: true,
    });

    expect(filterRenderableBlocks([result])).toEqual([result]);
    expect(buildDisplayItems([result], { compact: true })).toEqual([
      { kind: "block", key: "large-result", block: result },
    ]);
    expect(countRenderableDisplayRows([result], { compactMode: true })).toBe(1);
  });

  it("keeps truncated patch and Bash arguments out of compact summary tiles", () => {
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
      { kind: "block", key: "partial-patch", block: patch },
      { kind: "block", key: "partial-command", block: bash },
    ]);
  });
});
