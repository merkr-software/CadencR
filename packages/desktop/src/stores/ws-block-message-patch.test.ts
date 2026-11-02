import { describe, it, expect } from "vitest";
import { buildMessagePatch } from "./ws-block-mutations";
import type { AgentBlockData } from "@/types/agent-block";
import type { BlockMutation } from "./ws-message-processing";

describe("buildMessagePatch", () => {
  it("detects file change tools", () => {
    const blocks: AgentBlockData[] = [
      { id: "b1", type: "tool_call", content: "", toolName: "Write" },
    ];
    const mutations: BlockMutation[] = [{ action: "append", block: blocks[0] }];
    const patch = buildMessagePatch(blocks, mutations, {
      enterPlanModeRequested: false,
    });
    expect(patch.hasFileChanges).toBe(true);
  });

  it("detects apply_patch as a file change tool", () => {
    const blocks: AgentBlockData[] = [
      { id: "b1", type: "tool_call", content: "", toolName: "apply_patch" },
    ];
    const mutations: BlockMutation[] = [{ action: "append", block: blocks[0] }];
    const patch = buildMessagePatch(blocks, mutations, {
      enterPlanModeRequested: false,
    });
    expect(patch.hasFileChanges).toBe(true);
  });

  it("does not set hasFileChanges for non-file tools", () => {
    const blocks: AgentBlockData[] = [
      { id: "b1", type: "tool_call", content: "", toolName: "Read" },
    ];
    const mutations: BlockMutation[] = [{ action: "append", block: blocks[0] }];
    const patch = buildMessagePatch(blocks, mutations, {
      enterPlanModeRequested: false,
    });
    expect(patch.hasFileChanges).toBeUndefined();
  });

  it("detects enterPlanMode and sets permissionMode", () => {
    const blocks: AgentBlockData[] = [];
    const mutations: BlockMutation[] = [];
    const patch = buildMessagePatch(blocks, mutations, {
      enterPlanModeRequested: true,
    });
    expect(patch.permissionMode).toBe("plan");
  });

  it("extracts todos from mutated TodoWrite block", () => {
    const todoContent = JSON.stringify({
      todos: [{ content: "Do X", status: "pending", activeForm: "Doing X" }],
    });
    const blocks: AgentBlockData[] = [
      {
        id: "t1",
        type: "tool_call",
        content: todoContent,
        toolName: "TodoWrite",
        toolArgs: todoContent,
      },
    ];
    const mutations: BlockMutation[] = [{ action: "append", block: blocks[0] }];
    const patch = buildMessagePatch(blocks, mutations, {
      enterPlanModeRequested: false,
    });
    expect(patch.todos).toEqual([{ content: "Do X", status: "pending", activeForm: "Doing X" }]);
  });
});
