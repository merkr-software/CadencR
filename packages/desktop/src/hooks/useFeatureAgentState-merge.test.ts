import { describe, expect, it } from "vitest";
import type { AgentBlock } from "../api/generated";
import type { AgentBlockData } from "@/components/AgentBlock";
import { BLOCK_CONTENT_MAX_CHARS, TRUNCATION_NOTICE } from "@/lib/block-content-budget";
import {
  applyToolCallUpdates,
  mergeIncrementalBlocks,
  serverBlocksToAgentBlocks,
  type AccumulatedSession,
} from "./useFeatureAgentState-merge";

const OVER_BUDGET = BLOCK_CONTENT_MAX_CHARS + 1000;

const serverBlock = (overrides: Partial<AgentBlock> = {}): AgentBlock =>
  ({
    id: "msg-1",
    type: "text",
    content: "hello",
    parentToolUseId: null,
    ...overrides,
  }) as AgentBlock;

const session = (blocks: AgentBlockData[] = []): AccumulatedSession => ({
  blocks,
  maxMessageId: 0,
  toolUseIdMap: new Map(),
  todos: null,
  hasMore: false,
  oldestMessageId: null,
});

describe("serverBlocksToAgentBlocks", () => {
  it("clamps oversized hydrated content before it is retained", () => {
    const [block] = serverBlocksToAgentBlocks([serverBlock({ content: "x".repeat(OVER_BUDGET) })]);
    expect(block.content.length).toBeLessThan(OVER_BUDGET);
    expect(block.content).toContain(TRUNCATION_NOTICE);
    expect(block.truncatedContent).toBe(true);
  });

  it("clamps child blocks of a subagent too", () => {
    const child = serverBlock({ id: "msg-child", content: "y".repeat(OVER_BUDGET) });
    const [parent] = serverBlocksToAgentBlocks([
      serverBlock({
        id: "msg-parent",
        type: "tool_call",
        toolName: "Task",
        childBlocks: [child] as unknown as AgentBlock["childBlocks"],
      }),
    ]);
    expect(parent.childBlocks?.[0].content).toContain(TRUNCATION_NOTICE);
  });

  it("leaves ordinary content alone", () => {
    const [block] = serverBlocksToAgentBlocks([serverBlock()]);
    expect(block.content).toBe("hello");
    expect(block.truncatedContent).toBe(false);
  });
});

describe("mergeIncrementalBlocks", () => {
  // Boundary-merged text accumulates across every incremental fetch, so the
  // budget has to hold on the concatenation, not just on each arriving block.
  it("bounds text merged across fetches and flags it", () => {
    const acc = session([{ id: "msg-1", type: "text", content: "a".repeat(OVER_BUDGET / 2) }]);
    mergeIncrementalBlocks(acc, [
      { id: "msg-2", type: "text", content: "b".repeat(OVER_BUDGET), parentToolUseId: null },
    ] as AgentBlockData[]);

    expect(acc.blocks).toHaveLength(1);
    expect(acc.blocks[0].content.length).toBeLessThan(OVER_BUDGET);
    expect(acc.blocks[0].truncatedContent).toBe(true);
  });

  it("merges normally without flagging anything under budget", () => {
    const acc = session([{ id: "msg-1", type: "text", content: "one " }]);
    mergeIncrementalBlocks(acc, [
      { id: "msg-2", type: "text", content: "two", parentToolUseId: null },
    ] as AgentBlockData[]);

    expect(acc.blocks[0].content).toBe("one two");
    expect(acc.blocks[0].truncatedContent).toBeUndefined();
  });
});

describe("applyToolCallUpdates", () => {
  it("clamps an oversized update as JSON so the renderers keep parsing it", () => {
    const blocks: AgentBlockData[] = [{ id: "t1", type: "tool_call", content: "{}" }];
    const args = JSON.stringify({ file_path: "/a.ts", content: "c".repeat(OVER_BUDGET) });

    const updated = applyToolCallUpdates(blocks, { t1: args });
    expect(updated).not.toBe(blocks);
    expect(updated[0].truncatedContent).toBe(true);
    expect(updated[0].content).toBe(updated[0].toolArgs);
    const parsed = JSON.parse(updated[0].toolArgs ?? "") as Record<string, unknown>;
    expect(parsed.file_path).toBe("/a.ts");
    expect(blocks[0].content).toBe("{}");
  });

  it("drops the hydrated full size once a revision replaces the content", () => {
    const blocks: AgentBlockData[] = [
      {
        id: "t1",
        type: "tool_call",
        content: "{}",
        truncatedContent: true,
        fullContentBytes: 70_000,
      },
    ];
    const updated = applyToolCallUpdates(blocks, { t1: '{"a":1}' });
    expect(updated[0].fullContentBytes).toBeUndefined();
  });

  it("reports no change when the content already matches", () => {
    const blocks: AgentBlockData[] = [
      { id: "t1", type: "tool_call", content: "same", toolArgs: "same" },
    ];
    expect(applyToolCallUpdates(blocks, { t1: "same" })).toBe(blocks);
    expect(blocks[0].truncatedContent).toBeUndefined();
  });

  it("matches a canonical update through messageDbId and applies server truncation", () => {
    const blocks: AgentBlockData[] = [
      { id: "live-tool", messageDbId: 9, type: "tool_call", content: "before" },
    ];

    const updated = applyToolCallUpdates(blocks, { "msg-9": "after" }, new Set(["msg-9"]));

    expect(updated[0]).toMatchObject({
      content: "after",
      toolArgs: "after",
      truncatedContent: true,
    });
  });
});
