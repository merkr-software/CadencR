import { describe, it, expect, vi } from "vitest";
import { BLOCK_CONTENT_MAX_CHARS, TRUNCATION_NOTICE } from "@/lib/block-content-budget";
import { applyMutations, parseTodosFromBlocks } from "./ws-block-mutations";
import { createStreamingState } from "./ws-message-processing";
import type { AgentBlockData } from "@/types/agent-block";

function replayLargeToolEnvelope(contentChars: number): {
  block: AgentBlockData;
  parseCalls: number;
  parsedChars: number;
  payloadLength: number;
} {
  const streamState = createStreamingState();
  const payload = `{"file_path":"/tmp/large","content":"${"x".repeat(contentChars)}"}`;
  let blocks: AgentBlockData[] = [
    { id: "write-1", type: "tool_call", content: "", toolName: "Write", toolArgs: "" },
  ];
  const parse = vi.spyOn(JSON, "parse");
  let parseCalls = 0;
  let parsedChars = 0;
  try {
    for (let offset = 0; offset < payload.length; offset += 1024) {
      blocks = applyMutations(
        blocks,
        [
          {
            action: "update",
            block: {
              id: "write-1",
              type: "tool_call",
              content: payload.slice(offset, offset + 1024),
            },
          },
        ],
        streamState,
      );
    }
    parseCalls = parse.mock.calls.length;
    parsedChars = parse.mock.calls.reduce(
      (sum, [value]) => sum + (typeof value === "string" ? value.length : 0),
      0,
    );
  } finally {
    parse.mockRestore();
  }
  return { block: blocks[0], parseCalls, parsedChars, payloadLength: payload.length };
}

describe("parseTodosFromBlocks", () => {
  it("extracts todos from the last TodoWrite block", () => {
    const blocks: AgentBlockData[] = [
      { id: "1", type: "text", content: "hello" },
      {
        id: "2",
        type: "tool_call",
        content: JSON.stringify({
          todos: [
            {
              content: "Fix bug",
              status: "in_progress",
              activeForm: "Fixing bug",
            },
            {
              content: "Write tests",
              status: "pending",
              activeForm: "Writing tests",
            },
          ],
        }),
        toolName: "TodoWrite",
        toolArgs: JSON.stringify({
          todos: [
            {
              content: "Fix bug",
              status: "in_progress",
              activeForm: "Fixing bug",
            },
            {
              content: "Write tests",
              status: "pending",
              activeForm: "Writing tests",
            },
          ],
        }),
      },
    ];
    const result = parseTodosFromBlocks(blocks);
    expect(result).toEqual([
      { content: "Fix bug", status: "in_progress", activeForm: "Fixing bug" },
      {
        content: "Write tests",
        status: "pending",
        activeForm: "Writing tests",
      },
    ]);
  });

  it("returns undefined when no TodoWrite block exists", () => {
    const blocks: AgentBlockData[] = [{ id: "1", type: "text", content: "hello" }];
    expect(parseTodosFromBlocks(blocks)).toBeUndefined();
  });

  it("extracts todos from child blocks", () => {
    const blocks: AgentBlockData[] = [
      {
        id: "agent-1",
        type: "tool_call",
        content: "",
        toolName: "Agent",
        childBlocks: [
          {
            id: "child-1",
            type: "tool_call",
            content: JSON.stringify({
              todos: [
                {
                  content: "Task A",
                  status: "completed",
                  activeForm: "Doing A",
                },
              ],
            }),
            toolName: "TodoWrite",
            toolArgs: JSON.stringify({
              todos: [
                {
                  content: "Task A",
                  status: "completed",
                  activeForm: "Doing A",
                },
              ],
            }),
          },
        ],
      },
    ];
    const result = parseTodosFromBlocks(blocks);
    expect(result).toEqual([{ content: "Task A", status: "completed", activeForm: "Doing A" }]);
  });

  it("returns undefined for malformed JSON", () => {
    const blocks: AgentBlockData[] = [
      {
        id: "1",
        type: "tool_call",
        content: "{bad json",
        toolName: "TodoWrite",
        toolArgs: "{bad json",
      },
    ];
    expect(parseTodosFromBlocks(blocks)).toBeUndefined();
  });
});

describe("applyMutations", () => {
  it("merges Bash output patches into the command args", () => {
    const streamState = createStreamingState();
    const previous = JSON.stringify({ command: "pwd" });
    const latest = JSON.stringify({ output: "/tmp/project\n" });
    const existing: AgentBlockData[] = [
      {
        id: "bash-1",
        type: "tool_call",
        content: previous,
        toolName: "Bash",
        toolArgs: previous,
        toolUseId: "tu-bash-1",
      },
    ];

    const result = applyMutations(
      existing,
      [
        {
          action: "update",
          block: {
            id: "bash-1",
            type: "tool_call",
            content: latest,
            toolName: "Bash",
          },
        },
      ],
      streamState,
    );

    expect(JSON.parse(result[0].content)).toEqual({
      command: "pwd",
      output: "/tmp/project\n",
    });
    expect(result[0].toolArgs).toBe(result[0].content);
  });

  it("seeds a valid Bash base when toolArgs is initially absent", () => {
    const streamState = createStreamingState();
    const base = JSON.stringify({ command: "pwd", status: "running" });
    const result = applyMutations(
      [{ id: "bash", type: "tool_call", toolName: "Bash", content: base }],
      [
        {
          action: "update",
          block: {
            id: "bash",
            type: "tool_call",
            content: JSON.stringify({ output: "/tmp", status: "completed" }),
          },
        },
      ],
      streamState,
    );
    expect(JSON.parse(result[0].toolArgs ?? "")).toEqual({
      command: "pwd",
      output: "/tmp",
      status: "completed",
    });
  });

  it("merges ApplyPatch object deltas without dropping patch_text", () => {
    const streamState = createStreamingState();
    const previous = JSON.stringify({
      patch_text: "*** Begin Patch\n*** Update File: toto.txt\n@@\n-old\n+new\n*** End Patch",
      status: "running",
    });
    const latest = JSON.stringify({ output: "Success", status: "completed" });
    const existing: AgentBlockData[] = [
      {
        id: "patch-1",
        type: "tool_call",
        content: previous,
        toolName: "ApplyPatch",
        toolArgs: previous,
        toolUseId: "tu-patch-1",
      },
    ];

    const result = applyMutations(
      existing,
      [
        {
          action: "update",
          block: {
            id: "patch-1",
            type: "tool_call",
            content: latest,
            toolName: "ApplyPatch",
          },
        },
      ],
      streamState,
    );

    expect(JSON.parse(result[0].content)).toEqual({
      patch_text: "*** Begin Patch\n*** Update File: toto.txt\n@@\n-old\n+new\n*** End Patch",
      output: "Success",
      status: "completed",
    });
    expect(result[0].toolArgs).toBe(result[0].content);
  });

  it("publishes only the latest valid snapshot for non-merging tools", () => {
    const streamState = createStreamingState();
    const previous = JSON.stringify({ pattern: "old" });
    const latest = JSON.stringify({ pattern: "new" });
    const existing: AgentBlockData[] = [
      {
        id: "grep-1",
        type: "tool_call",
        content: previous,
        toolName: "Grep",
        toolArgs: previous,
      },
    ];

    const result = applyMutations(
      existing,
      [
        {
          action: "update",
          block: {
            id: "grep-1",
            type: "tool_call",
            content: latest,
            toolName: "Grep",
          },
        },
      ],
      streamState,
    );

    expect(result[0].content).toBe(latest);
    expect(result[0].toolArgs).toBe(latest);
  });

  it("maintains rootBlocks and toolResultMap when a root block is appended", () => {
    const streamState = createStreamingState();
    const rootBlock: AgentBlockData = { id: "r1", type: "text", content: "hello" };
    applyMutations([], [{ action: "append", block: rootBlock }], streamState);
    expect(streamState.rootBlocks).toEqual([rootBlock]);
    expect(streamState.rootBlockPosById.get("r1")).toBe(0);

    const resultBlock: AgentBlockData = {
      id: "r2",
      type: "tool_result",
      content: "ok",
      toolUseId: "tu-1",
    };
    applyMutations([rootBlock], [{ action: "append", block: resultBlock }], streamState);
    expect(streamState.rootBlocks).toEqual([rootBlock, resultBlock]);
    expect(streamState.toolResultMap.get("tu-1")).toBe(resultBlock);
  });

  it("inserts root appends before a pending prompt suffix without rebuilding stream state", () => {
    const streamState = createStreamingState();
    const assistant: AgentBlockData = { id: "assistant", type: "text", content: "working" };
    const pending: AgentBlockData = {
      id: "pending",
      type: "user_message",
      content: "steer",
      promptDeliveryState: "pending_agent",
    };
    applyMutations([], [{ action: "append", block: assistant }], streamState);
    applyMutations([assistant], [{ action: "append", block: pending }], streamState);

    const divider: AgentBlockData = {
      id: "compact-divider",
      type: "compact_divider",
      content: "",
    };
    const result = applyMutations(
      [assistant, pending],
      [{ action: "append", block: divider }],
      streamState,
      1,
    );

    expect(result.map((block) => block.id)).toEqual(["assistant", "compact-divider", "pending"]);
    expect(streamState.rootBlocks.map((block) => block.id)).toEqual([
      "assistant",
      "compact-divider",
      "pending",
    ]);
    expect(streamState.rootBlockPosById.get("assistant")).toBe(0);
    expect(streamState.rootBlockPosById.get("compact-divider")).toBe(1);
    expect(streamState.rootBlockPosById.get("pending")).toBe(2);
  });

  it("does not push child appends into rootBlocks but bumps the parent ref", () => {
    const streamState = createStreamingState();
    const parent: AgentBlockData = {
      id: "p1",
      type: "tool_call",
      content: "{}",
      toolName: "Agent",
      toolUseId: "tu-parent",
      childBlocks: [],
    };
    streamState.toolUseIdToBlock.set("tu-parent", parent);
    applyMutations([], [{ action: "append", block: parent }], streamState);
    expect(streamState.rootBlocks).toHaveLength(1);
    const initialParentRef = streamState.rootBlocks[0];
    expect(initialParentRef.id).toBe("p1");

    const child: AgentBlockData = {
      id: "c1",
      type: "text",
      content: "child text",
      parentToolUseId: "tu-parent",
    };
    applyMutations([parent], [{ action: "append", block: child }], streamState);
    // Child must NOT appear at root level.
    expect(streamState.rootBlocks).toHaveLength(1);
    expect(streamState.rootBlocks[0].id).toBe("p1");
    // Parent ref must have been swapped (replace_parent).
    expect(streamState.rootBlocks[0]).not.toBe(initialParentRef);
  });

  it("swaps the rootBlocks ref when a root block content is updated", () => {
    const streamState = createStreamingState();
    const root: AgentBlockData = { id: "t1", type: "text", content: "hi " };
    applyMutations([], [{ action: "append", block: root }], streamState);
    const initialRef = streamState.rootBlocks[0];

    const result = applyMutations(
      [root],
      [{ action: "update", block: { id: "t1", type: "text", content: "world" } }],
      streamState,
    );
    expect(result[0].content).toBe("hi world");
    expect(streamState.rootBlocks[0]).not.toBe(initialRef);
    expect(streamState.rootBlocks[0].content).toBe("hi world");
  });

  it("reconciles duplicate appends by block id instead of adding a second block", () => {
    const streamState = createStreamingState();
    const existing: AgentBlockData = { id: "msg-10", type: "text", content: "hello" };
    applyMutations([], [{ action: "append", block: existing }], streamState);

    const result = applyMutations(
      [existing],
      [{ action: "append", block: { id: "msg-10", type: "text", content: "" } }],
      streamState,
    );

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hello");
    expect(streamState.rootBlocks).toHaveLength(1);
  });

  it("keeps existing children when a duplicate task append has an empty child list", () => {
    const streamState = createStreamingState();
    const task: AgentBlockData = {
      id: "task",
      type: "tool_call",
      content: "{}",
      toolName: "Agent",
      toolUseId: "task-tu",
      childBlocks: [{ id: "child", type: "text", content: "done" }],
    };
    applyMutations([], [{ action: "append", block: task }], streamState);
    const result = applyMutations(
      [task],
      [
        {
          action: "append",
          block: { ...task, content: "", childBlocks: [] },
        },
      ],
      streamState,
    );
    expect(result).toHaveLength(1);
    expect(result[0].childBlocks?.map((block) => block.id)).toEqual(["child"]);
  });

  it("skips no-op duplicate child appends instead of appending again", () => {
    const streamState = createStreamingState();
    const parent: AgentBlockData = {
      id: "parent",
      type: "tool_call",
      content: "{}",
      toolUseId: "tu-parent",
      childBlocks: [{ id: "child", type: "text", content: "already streamed" }],
    };
    applyMutations([], [{ action: "append", block: parent }], streamState);
    const initialParentRef = streamState.rootBlocks[0];
    const result = applyMutations(
      [parent],
      [
        {
          action: "append",
          block: {
            id: "child",
            type: "text",
            content: "",
            parentToolUseId: "tu-parent",
          },
        },
      ],
      streamState,
    );
    expect(result[0].childBlocks).toHaveLength(1);
    expect(result[0]).toBe(initialParentRef);
  });

  it("does not loop forever when partial json starts with '{'", () => {
    const streamState = createStreamingState();
    const validArgs = JSON.stringify({
      description: "Find files",
      prompt: "search",
    });
    const existing: AgentBlockData[] = [
      {
        id: "agent-1",
        type: "tool_call",
        content: validArgs,
        toolName: "Agent",
        toolArgs: validArgs,
      },
    ];

    const result = applyMutations(
      existing,
      [
        {
          action: "replace",
          block: {
            id: "agent-1",
            type: "tool_call",
            content: '{"description": "Fi',
            toolName: "Agent",
          },
        },
      ],
      streamState,
    );

    expect(result[0].toolArgs).toBe(validArgs);
    expect(result[0].content).toBe('{"description": "Fi');
  });

  it("parses a large unfinished tool envelope in near-linear total input", () => {
    const small = replayLargeToolEnvelope(256 * 1024);
    const large = replayLargeToolEnvelope(1024 * 1024);
    for (const result of [small, large]) {
      expect(result.parseCalls).toBe(1);
      expect(result.parsedChars).toBe(result.payloadLength);
      expect(result.block.content.length).toBeLessThan(BLOCK_CONTENT_MAX_CHARS + 1_000);
      expect(result.block.content).toContain(TRUNCATION_NOTICE);
      expect(result.block.toolArgs).toBe(result.block.content);
    }
    expect(large.parsedChars).toBeLessThan(small.parsedChars * 5);
  });

  it("publishes the same canonical content and args for a large generic tool snapshot", () => {
    const streamState = createStreamingState();
    const payload = JSON.stringify({ query: "x".repeat(256 * 1024) });
    const blocks = applyMutations(
      [{ id: "mcp-1", type: "tool_call", content: "", toolName: "mcp__search" }],
      [{ action: "update", block: { id: "mcp-1", type: "tool_call", content: payload } }],
      streamState,
    );

    expect(blocks[0].content).toBe(blocks[0].toolArgs);
    expect(() => JSON.parse(blocks[0].toolArgs ?? "")).not.toThrow();
    expect(blocks[0].content).toContain(TRUNCATION_NOTICE);
  });

  it("cleans up a complete stream without replacing an unchanged block", () => {
    const streamState = createStreamingState();
    let blocks: AgentBlockData[] = [
      { id: "write-1", type: "tool_call", content: "", toolName: "Write" },
    ];
    blocks = applyMutations(
      blocks,
      [
        {
          action: "update",
          block: { id: "write-1", type: "tool_call", content: '{"file_path":"/tmp/a"}' },
        },
      ],
      streamState,
    );
    const version = streamState.rootBlocksVersion;
    const finalized = applyMutations(
      blocks,
      [{ action: "finalize", block: { id: "write-1", type: "tool_call", content: "" } }],
      streamState,
    );

    expect(finalized).toBe(blocks);
    expect(streamState.rootBlocksVersion).toBe(version);
    expect(streamState.structuredToolStreams.has("write-1")).toBe(false);
  });

  it("keeps the last authoritative args when a malformed stream finalizes", () => {
    const streamState = createStreamingState();
    const initial = JSON.stringify({ file_path: "/tmp/original" });
    let blocks: AgentBlockData[] = [
      {
        id: "write-1",
        type: "tool_call",
        content: initial,
        toolName: "Write",
        toolArgs: initial,
      },
    ];
    blocks = applyMutations(
      blocks,
      [{ action: "update", block: { id: "write-1", type: "tool_call", content: '{"bad":' } }],
      streamState,
    );
    blocks = applyMutations(
      blocks,
      [{ action: "finalize", block: { id: "write-1", type: "tool_call", content: "" } }],
      streamState,
    );

    expect(blocks[0].toolArgs).toBe(initial);
    expect(streamState.structuredToolStreams.has("write-1")).toBe(false);
  });

  it("continues scanning an incomplete prefix already present on the block", () => {
    const streamState = createStreamingState();
    const prefix = '{"file_path":"/tmp/file","content":"';
    const blocks = applyMutations(
      [{ id: "write-1", type: "tool_call", content: prefix, toolName: "Write" }],
      [
        { action: "update", block: { id: "write-1", type: "tool_call", content: "hello" } },
        { action: "update", block: { id: "write-1", type: "tool_call", content: '"}' } },
      ],
      streamState,
    );

    expect(JSON.parse(blocks[0].toolArgs ?? "")).toEqual({
      file_path: "/tmp/file",
      content: "hello",
    });
  });
});

// Version counters let the streaming caller skip re-snapshotting rootBlocks /
// toolResultMap when a delta didn't touch them. Every mutation that changes a
// root block's subtree MUST bump rootBlocksVersion, and every tool_result write
// MUST bump toolResultMapVersion — a missed bump would silently stall the UI.
describe("applyMutations derived-state version counters", () => {
  it("bumps rootBlocksVersion but not toolResultMapVersion on a text append", () => {
    const streamState = createStreamingState();
    const root0 = streamState.rootBlocksVersion;
    const trm0 = streamState.toolResultMapVersion;
    applyMutations(
      [],
      [{ action: "append", block: { id: "t1", type: "text", content: "hi" } }],
      streamState,
    );
    expect(streamState.rootBlocksVersion).toBeGreaterThan(root0);
    expect(streamState.toolResultMapVersion).toBe(trm0);
  });

  it("does not bump either version on a no-op duplicate append", () => {
    const streamState = createStreamingState();
    const existing: AgentBlockData = { id: "msg-10", type: "text", content: "hello" };
    applyMutations([], [{ action: "append", block: existing }], streamState);
    const root0 = streamState.rootBlocksVersion;
    const trm0 = streamState.toolResultMapVersion;
    // A shorter duplicate merges to the existing block with no change.
    applyMutations(
      [existing],
      [{ action: "append", block: { id: "msg-10", type: "text", content: "" } }],
      streamState,
    );
    expect(streamState.rootBlocksVersion).toBe(root0);
    expect(streamState.toolResultMapVersion).toBe(trm0);
  });

  it("bumps rootBlocksVersion on a root text update", () => {
    const streamState = createStreamingState();
    const root: AgentBlockData = { id: "t1", type: "text", content: "hi " };
    applyMutations([], [{ action: "append", block: root }], streamState);
    const v = streamState.rootBlocksVersion;
    applyMutations(
      [root],
      [{ action: "update", block: { id: "t1", type: "text", content: "world" } }],
      streamState,
    );
    expect(streamState.rootBlocksVersion).toBeGreaterThan(v);
  });

  it("bumps toolResultMapVersion when a tool_result is appended", () => {
    const streamState = createStreamingState();
    const trm0 = streamState.toolResultMapVersion;
    applyMutations(
      [],
      [
        {
          action: "append",
          block: { id: "r1", type: "tool_result", content: "ok", toolUseId: "tu-1" },
        },
      ],
      streamState,
    );
    expect(streamState.toolResultMapVersion).toBeGreaterThan(trm0);
  });

  it("bumps rootBlocksVersion when a child block inside a root subtree is updated in place", () => {
    const streamState = createStreamingState();
    const parent: AgentBlockData = {
      id: "p1",
      type: "tool_call",
      content: "{}",
      toolName: "Agent",
      toolUseId: "tu-parent",
      childBlocks: [],
    };
    streamState.toolUseIdToBlock.set("tu-parent", parent);
    applyMutations([], [{ action: "append", block: parent }], streamState);
    applyMutations(
      [parent],
      [
        {
          action: "append",
          block: {
            id: "c1",
            type: "tool_call",
            content: "{",
            parentToolUseId: "tu-parent",
            toolUseId: "tu-child",
          },
        },
      ],
      streamState,
    );
    const v = streamState.rootBlocksVersion;
    // Streaming input_json_delta for the child tool call — an in-place child
    // content update with no root ref swap. Must still bump so rootBlocks is
    // re-snapshotted and the subagent panel re-renders.
    applyMutations(
      [parent],
      [{ action: "update", block: { id: "c1", type: "tool_call", content: '"foo"}' } }],
      streamState,
    );
    expect(streamState.rootBlocksVersion).toBeGreaterThan(v);
  });
});
