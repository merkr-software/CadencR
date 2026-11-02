import { fireEvent, render, screen } from "@/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";

vi.mock("@/components/SubagentActionRow", () => ({
  SubagentActionRow: () => <button type="button">Nested action</button>,
}));

const { TaskAgentBlock } = await import("./TaskAgentBlock");

function changeTotalHeight(timeline: HTMLElement): void {
  fireEvent(
    timeline,
    new CustomEvent("virtuoso-total-height-change", { detail: { height: 2_400 } }),
  );
}

function taskBlock(taskComplete = true): AgentBlockData {
  return {
    id: "task-keyboard",
    type: "tool_call",
    content: "{}",
    toolName: "Task",
    toolArgs: JSON.stringify({ description: "Keyboard timeline" }),
    taskComplete,
    childBlocks: Array.from({ length: 100 }, (_, index) => ({
      id: `child-${index}`,
      type: "text" as const,
      content: `step ${index}`,
    })),
  };
}

describe("TaskAgentBlock virtualized keyboard navigation", () => {
  it("sends unmodified Home and End to Virtuoso while retaining focus", () => {
    render(<TaskAgentBlock block={taskBlock()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent actions" }));
    const timeline = screen.getByRole("region", { name: "Keyboard timeline actions" });
    timeline.focus();
    timeline.scrollTop = 200;

    expect(fireEvent.keyDown(timeline, { key: "Home" })).toBe(false);
    expect(timeline.scrollTop).toBe(0);
    expect(fireEvent.keyDown(timeline, { key: "End" })).toBe(false);

    expect(timeline.scrollTop).toBe(Number.MAX_SAFE_INTEGER);
    expect(timeline).toHaveFocus();
  });

  it("ignores modifiers and events originating from nested controls", () => {
    render(<TaskAgentBlock block={taskBlock()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent actions" }));
    const timeline = screen.getByRole("region", { name: "Keyboard timeline actions" });
    const nested = screen.getAllByRole("button", { name: "Nested action" })[0];
    timeline.scrollTop = 200;

    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      fireEvent.keyDown(timeline, { key: "End", [modifier]: true });
    }
    nested.focus();
    fireEvent.keyDown(nested, { key: "End" });

    expect(timeline.scrollTop).toBe(200);
    expect(nested).toHaveFocus();
  });

  it("settles completed timelines at End until a wheel gesture detaches", () => {
    render(<TaskAgentBlock block={taskBlock()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent actions" }));
    const timeline = screen.getByRole("region", { name: "Keyboard timeline actions" });

    fireEvent.keyDown(timeline, { key: "End" });
    timeline.scrollTop = 200;
    changeTotalHeight(timeline);
    expect(timeline.scrollTop).toBe(Number.MAX_SAFE_INTEGER);

    fireEvent.wheel(timeline, { deltaY: -20 });
    timeline.scrollTop = 200;
    changeTotalHeight(timeline);
    expect(timeline.scrollTop).toBe(200);
  });

  it("disengages following before Home or wheel-up can trigger a height repin", () => {
    render(<TaskAgentBlock block={taskBlock(false)} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent actions" }));
    const timeline = screen.getByRole("region", { name: "Keyboard timeline actions" });

    fireEvent.keyDown(timeline, { key: "Home" });
    timeline.scrollTop = 200;
    changeTotalHeight(timeline);
    expect(timeline.scrollTop).toBe(200);

    fireEvent.keyDown(timeline, { key: "End" });
    timeline.scrollTop = 200;
    changeTotalHeight(timeline);
    expect(timeline.scrollTop).toBe(Number.MAX_SAFE_INTEGER);

    fireEvent.wheel(timeline, { deltaY: -20 });
    timeline.scrollTop = 200;
    changeTotalHeight(timeline);
    expect(timeline.scrollTop).toBe(200);
  });
});
