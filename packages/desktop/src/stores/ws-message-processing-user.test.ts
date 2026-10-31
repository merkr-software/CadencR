import { describe, expect, it } from "vitest";

import type { AgentBlockData } from "@/types/agent-block";
import { createStreamingState, type ParserSignals } from "./ws-message-processing";
import { processUserMessage } from "./ws-message-processing-user";
import { applyBlockContentBudget } from "@/lib/block-content-budget";
import { mergeCanonicalBlocks } from "./ws-user-message-reconciliation";

function signals(): ParserSignals {
  return {
    enterPlanModeRequested: false,
    compactBoundaryObserved: false,
    compactBoundaryTrigger: null,
  };
}

function taskResultMessage(toolUseId: string, content: unknown = "done") {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
  };
}

/** The internal metadata Claude returns when it launches a subagent async. */
const LAUNCH_ACK = [
  {
    type: "text",
    text: "Async agent launched successfully. agentId: abc123. The agent is working in the background. You will be notified automatically when it completes.",
  },
];

describe("processUserMessage subagent completion", () => {
  it("preserves each persisted result id through truncation and reconnect", () => {
    const state = createStreamingState();
    const message = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            agent_message_id: 41,
            content: "x".repeat(150_000),
          },
          { type: "tool_result", tool_use_id: "b", agent_message_id: "42", content: "second" },
        ],
      },
    };
    const blocks = processUserMessage(message, state, signals()).map((m) =>
      applyBlockContentBudget(m.block),
    );
    expect(blocks.map((b) => b.id)).toEqual(["msg-41", "msg-42"]);
    expect(blocks[0].truncatedContent).toBe(true);
    expect(
      mergeCanonicalBlocks(
        blocks,
        blocks.map((b, index) => ({ ...b, messageDbId: index + 41 })),
      ),
    ).toHaveLength(2);
  });

  it("accepts a legacy envelope id only for one result and rejects invalid ids", () => {
    const state = createStreamingState();
    const single = { ...taskResultMessage("a"), agent_message_id: 51 };
    expect(processUserMessage(single, state, signals())[0].block.id).toBe("msg-51");
    const multi = {
      ...single,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "a", agent_message_id: -1 },
          { type: "tool_result", tool_use_id: "b", agent_message_id: "9007199254740992" },
        ],
      },
    };
    expect(processUserMessage(multi, state, signals()).map((m) => m.block.id)).toEqual([
      "ws-1",
      "ws-2",
    ]);
  });
  it("marks the Task/Agent tool_call complete when its own tool_result arrives", () => {
    const state = createStreamingState();
    const task: AgentBlockData = {
      id: "block-task",
      type: "tool_call",
      content: "",
      toolName: "Agent",
      toolUseId: "toolu_task",
      childBlocks: [],
      taskComplete: false,
    };
    state.toolUseIdToBlock.set("toolu_task", task);

    const mutations = processUserMessage(taskResultMessage("toolu_task"), state, signals());

    expect(task.taskComplete).toBe(true);
    // The result is re-nested under the Task (parentToolUseId === its own id).
    expect(mutations).toHaveLength(1);
    expect(mutations[0].block.parentToolUseId).toBe("toolu_task");
  });

  it("does NOT complete a background subagent on its launch ack, and skips the ack block", () => {
    const state = createStreamingState();
    const task: AgentBlockData = {
      id: "block-task",
      type: "tool_call",
      content: "",
      toolName: "Agent",
      toolUseId: "toolu_task",
      childBlocks: [],
      taskComplete: false,
    };
    state.toolUseIdToBlock.set("toolu_task", task);

    const mutations = processUserMessage(
      taskResultMessage("toolu_task", LAUNCH_ACK),
      state,
      signals(),
    );

    // The subagent is still running in the background — do not complete it.
    expect(task.taskComplete).toBe(false);
    expect(task.taskBackground).toBe(true);
    // The "Async agent launched" internal metadata must not render.
    expect(mutations).toHaveLength(0);
  });

  it("leaves taskComplete untouched for a non-subagent tool_result", () => {
    const state = createStreamingState();
    const bash: AgentBlockData = {
      id: "block-bash",
      type: "tool_call",
      content: "",
      toolName: "Bash",
      toolUseId: "toolu_bash",
      taskComplete: false,
    };
    state.toolUseIdToBlock.set("toolu_bash", bash);

    processUserMessage(taskResultMessage("toolu_bash"), state, signals());

    expect(bash.taskComplete).toBe(false);
  });
});
