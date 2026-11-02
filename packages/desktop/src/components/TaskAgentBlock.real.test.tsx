import { fireEvent, render, screen } from "@/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";

// The shared setup renders every Virtuoso item. This regression deliberately
// uses the real library to prove a 1,000-action expansion mounts a bounded DOM.
vi.unmock("react-virtuoso");
vi.mock("@/components/SubagentActionRow", () => ({
  SubagentActionRow: ({ block }: { block: AgentBlockData }) => <span>{block.id}</span>,
}));

const { TaskAgentBlock } = await import("./TaskAgentBlock");

function largeTask(taskComplete: boolean): AgentBlockData {
  return {
    id: "large-task",
    type: "tool_call",
    content: "{}",
    toolName: "Task",
    toolArgs: JSON.stringify({ description: "Large timeline" }),
    taskComplete,
    childBlocks: Array.from({ length: 1_000 }, (_, index) => ({
      id: `child-${index}`,
      type: "text" as const,
      content: `step ${index}`,
    })),
  };
}

describe("TaskAgentBlock with real Virtuoso", () => {
  it("mounts a bounded, keyboard-accessible window from completed history's start", () => {
    const { container } = render(<TaskAgentBlock block={largeTask(true)} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent actions" }));

    const timeline = screen.getByRole("region", { name: "Large timeline actions" });
    const mounted = container.querySelectorAll("[data-subagent-action-id]");
    expect(timeline).toHaveAttribute("tabindex", "0");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(20);
    expect(mounted[0]).toHaveAttribute("data-subagent-action-id", "child-0");
  });

  it("keeps the running timeline's initial render bounded before measurement settles", () => {
    const { container } = render(<TaskAgentBlock block={largeTask(false)} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent actions" }));

    const mounted = container.querySelectorAll("[data-subagent-action-id]");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(20);
  });
});
