import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AgentBlockData } from "@/components/AgentBlock";

// Isolate the windowing logic: render a lightweight marker per child instead of
// the full AgentBlock tree (which needs code-block / link-routing contexts).
vi.mock("@/components/AgentBlock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/AgentBlock")>();
  return {
    ...actual,
    AgentBlock: ({ block }: { block: AgentBlockData }) => <div data-testid="child">{block.id}</div>,
  };
});

// ToolSummaryBlock re-enters the AgentBlock → ToolSummaryBlock → AgentStreamItem
// → AgentBlock import cycle; stub it so pulling the real AgentBlock above leaves
// its export resolved. Not exercised by subagent windowing.
vi.mock("@/components/agent-session/ToolSummaryBlock", () => ({ ToolSummaryBlock: () => null }));

const { TaskAgentBlock } = await import("./TaskAgentBlock");

function taskBlock(childCount: number, taskComplete = false): AgentBlockData {
  return {
    id: "task-1",
    type: "tool_call",
    content: "{}",
    toolName: "Task",
    toolArgs: JSON.stringify({ description: "sub" }),
    taskComplete,
    childBlocks: Array.from({ length: childCount }, (_, i) => ({
      id: `child-${i}`,
      type: "text" as const,
      content: `step ${i}`,
    })),
  };
}

describe("TaskAgentBlock windowing", () => {
  it("renders only the last N children while streaming, with a show-all affordance", () => {
    render(<TaskAgentBlock block={taskBlock(40)} />);
    // 40 children, cap 30 → last 30 rendered (child-10 … child-39).
    expect(screen.getAllByTestId("child")).toHaveLength(30);
    expect(screen.queryByText("child-9")).toBeNull();
    expect(screen.getByText("child-39")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: /show 10 earlier steps/i });
    fireEvent.click(button);

    expect(screen.getAllByTestId("child")).toHaveLength(40);
    expect(screen.getByText("child-0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /earlier step/i })).toBeNull();
  });

  it("renders all children (no cap, no button) once the task is complete", () => {
    render(<TaskAgentBlock block={taskBlock(40, true)} />);
    expect(screen.getAllByTestId("child")).toHaveLength(40);
    expect(screen.queryByRole("button", { name: /earlier step/i })).toBeNull();
  });

  it("does not window a small streaming child list", () => {
    render(<TaskAgentBlock block={taskBlock(5)} />);
    expect(screen.getAllByTestId("child")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /earlier step/i })).toBeNull();
  });
});
