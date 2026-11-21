import { fireEvent, render, screen } from "@/test-utils";
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
  it("keeps filenames visible at the end of long paths in the activity list", () => {
    const block = taskWithLastCall({});
    const filePath = `/workspace/${"long-directory/".repeat(12)}marker-two.txt`;
    const call = {
      ...block.childBlocks![0],
      toolName: "Read",
      toolArgs: JSON.stringify({ file_path: filePath }),
    };
    render(<TaskAgentBlock block={{ ...block, childBlocks: [call] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent actions" }));
    const detail = screen.getByTitle(filePath);
    expect(detail).toHaveTextContent(filePath);
    expect(detail).toHaveAttribute("dir", "rtl");
  });

  it("matches concurrent actions to their own results while the card is open", () => {
    const block = taskWithLastCall({ content: "done", isError: false });
    const [call, result] = block.childBlocks!;
    const pending = { ...call, id: "child-pending", toolUseId: "call-2" };
    const { rerender } = render(
      <TaskAgentBlock block={{ ...block, childBlocks: [call, pending] }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent actions" }));
    expect(screen.getAllByText("Awaiting result")).toHaveLength(2);

    rerender(<TaskAgentBlock block={{ ...block, childBlocks: [call, pending, result] }} />);
    expect(
      screen.getByText("Result received").closest("[data-subagent-action-id]"),
    ).toHaveAttribute("data-subagent-action-id", call.id);
    expect(
      screen.getByText("Awaiting result").closest("[data-subagent-action-id]"),
    ).toHaveAttribute("data-subagent-action-id", pending.id);

    const failed = {
      ...result,
      id: "result-2",
      toolUseId: pending.toolUseId,
      isError: true,
      content: "File missing",
    };
    rerender(
      <TaskAgentBlock
        block={{ ...block, childBlocks: [call, pending, result, failed], taskComplete: true }}
      />,
    );
    expect(screen.getByTitle("File missing")).toHaveTextContent("Failed");
    expect(screen.queryByText("Awaiting result")).toBeNull();
  });

  it("marks a finished agent's failed latest action with the failure's first line", () => {
    render(
      <TaskAgentBlock
        block={{
          ...taskWithLastCall({ isError: true, content: "Exit code 1\n3 tests failed" }),
          taskComplete: true,
        }}
      />,
    );

    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("Exit code 1")).toBeInTheDocument();
    expect(screen.queryByText(/3 tests failed/)).not.toBeInTheDocument();
  });

  it("keeps a running agent's failed latest action to one line", () => {
    render(<TaskAgentBlock block={taskWithLastCall({ isError: true, content: "Exit code 1" })} />);

    // The next action replaces it soon: a reason line would grow, then shrink the card.
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("Exit code 1")).toHaveClass("sr-only");
    expect(screen.getByTitle("Exit code 1")).toBeInTheDocument();
  });

  it("leaves a latest action whose result succeeded unmarked", () => {
    render(<TaskAgentBlock block={taskWithLastCall({ isError: false, content: "all green" })} />);

    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.queryByText("all green")).not.toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });
});
