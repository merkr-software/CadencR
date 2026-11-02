import { describe, it, expect } from "vitest";
import {
  applyMutations,
  blocksPatchWithDerived,
  rebuildDerivedAgentStreamState,
} from "./ws-block-mutations";
import { createStreamingState } from "./ws-message-processing";
import type { AgentBlockData } from "@/types/agent-block";
import { createStructuredToolStream } from "./ws-structured-tool-stream";

describe("rebuildDerivedAgentStreamState", () => {
  it("filters out children and indexes tool_result blocks by toolUseId", () => {
    const streamState = createStreamingState();
    const blocks: AgentBlockData[] = [
      { id: "a", type: "text", content: "hi" },
      { id: "b", type: "text", content: "child", parentToolUseId: "tu-x" },
      { id: "c", type: "tool_result", content: "ok", toolUseId: "tu-x" },
    ];
    rebuildDerivedAgentStreamState(streamState, blocks);
    expect(streamState.rootBlocks.map((b) => b.id)).toEqual(["a", "c"]);
    expect(streamState.toolResultMap.get("tu-x")?.id).toBe("c");
    expect(streamState.rootBlockPosById.get("a")).toBe(0);
    expect(streamState.rootBlockPosById.get("c")).toBe(1);
  });

  it("indexes nested tool calls so streamed children can reconcile after hydration", () => {
    const streamState = createStreamingState();
    const task: AgentBlockData = {
      id: "task",
      type: "tool_call",
      content: "{}",
      toolUseId: "task-1",
      childBlocks: [{ id: "child", type: "text", content: "nested" }],
    };
    rebuildDerivedAgentStreamState(streamState, [task]);
    expect(streamState.toolUseIdToBlock.get("task-1")).toBe(task);
  });

  it("drops incomplete live tool buffers when their block is removed", () => {
    const streamState = createStreamingState();
    streamState.structuredToolStreams.set("stale", createStructuredToolStream());
    rebuildDerivedAgentStreamState(streamState, []);
    expect(streamState.structuredToolStreams.size).toBe(0);
  });

  it("drops an incomplete buffer when the same block is authoritatively replaced", () => {
    const streamState = createStreamingState();
    const stream = createStructuredToolStream();
    stream.preview = { text: '{"partial":', truncated: false };
    streamState.structuredToolStreams.set("tool", stream);
    rebuildDerivedAgentStreamState(streamState, [
      { id: "tool", type: "tool_call", content: '{"complete":true}' },
    ]);
    expect(streamState.structuredToolStreams.size).toBe(0);
  });

  it("preserves an unchanged incomplete stream across an unrelated rebuild", () => {
    const streamState = createStreamingState();
    const prefix = `{"file_path":"/tmp/large","content":"${"x".repeat(140_000)}`;
    let blocks: AgentBlockData[] = [
      { id: "write", type: "tool_call", toolName: "Write", content: prefix },
    ];
    blocks = applyMutations(
      blocks,
      [{ action: "update", block: { id: "write", type: "tool_call", content: "tail" } }],
      streamState,
    );
    const older: AgentBlockData = { id: "older", type: "text", content: "history" };
    const rebuilt = blocksPatchWithDerived(streamState, [older, ...blocks]).blocks;
    expect(streamState.structuredToolStreams.has("write")).toBe(true);

    const completed = applyMutations(
      rebuilt,
      [{ action: "update", block: { id: "write", type: "tool_call", content: '"}' } }],
      streamState,
    );
    const args = JSON.parse(completed[1].toolArgs ?? "") as Record<string, unknown>;
    expect(args.file_path).toBe("/tmp/large");
    expect(String(args.content)).toContain("tail");
  });

  it("drops a stale raw stream when an authoritative clone has the same preview", () => {
    const streamState = createStreamingState();
    let blocks: AgentBlockData[] = [
      { id: "write", type: "tool_call", toolName: "Write", content: "" },
    ];
    blocks = applyMutations(
      blocks,
      [{ action: "update", block: { id: "write", type: "tool_call", content: '{"value":' } }],
      streamState,
    );
    expect(streamState.structuredToolStreams.has("write")).toBe(true);

    rebuildDerivedAgentStreamState(streamState, [{ ...blocks[0] }]);
    expect(streamState.structuredToolStreams.has("write")).toBe(false);
  });
});

describe("blocksPatchWithDerived", () => {
  it("returns fresh refs for blocks, rootBlocks, and toolResultMap", () => {
    const streamState = createStreamingState();
    const blocks: AgentBlockData[] = [
      { id: "a", type: "text", content: "hi" },
      { id: "b", type: "tool_result", content: "ok", toolUseId: "tu-1" },
    ];
    const patch = blocksPatchWithDerived(streamState, blocks);
    expect(patch.blocks).toBe(blocks);
    expect(patch.rootBlocks).not.toBe(streamState.rootBlocks);
    expect(patch.rootBlocks.map((b) => b.id)).toEqual(["a", "b"]);
    expect(patch.toolResultMap).not.toBe(streamState.toolResultMap);
    expect(patch.toolResultMap.get("tu-1")?.id).toBe("b");
  });
});
