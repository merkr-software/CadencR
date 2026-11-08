import { render, screen } from "@/test-utils";
import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { TaskAgentBlock } from "./TaskAgentBlock";

function taskWithLastCall(result: Partial<AgentBlockData>): AgentBlockData {
  return {
    id: "task-peek",
    type: "tool_call",
    content: "{}",
    toolName: "Task",
    toolUseId: "task-1",
    toolArgs: JSON.stringify({ description: "Run the checks" }),
    childBlocks: [
      {
        id: "child-call",
        type: "tool_call",
        content: "",
        toolName: "Bash",
        toolUseId: "call-1",
        parentToolUseId: "task-1",
        toolArgs: JSON.stringify({ command: "pnpm test" }),
      },
      {
        id: "child-result",
        type: "tool_result",
        toolUseId: "call-1",
        parentToolUseId: "task-1",
        sourceToolName: "Bash",
        content: "",
        ...result,
      },
    ],
  };
}

describe("TaskAgentBlock latest action", () => {
  it("marks a latest action whose result failed, with the failure's first line", () => {
    render(
      <TaskAgentBlock
        block={taskWithLastCall({ isError: true, content: "Exit code 1\n3 tests failed" })}
      />,
    );

    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("Exit code 1")).toBeInTheDocument();
    expect(screen.queryByText(/3 tests failed/)).not.toBeInTheDocument();
  });

  it("leaves a latest action whose result succeeded unmarked", () => {
    render(<TaskAgentBlock block={taskWithLastCall({ isError: false, content: "all green" })} />);

    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.queryByText("all green")).not.toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });
});
