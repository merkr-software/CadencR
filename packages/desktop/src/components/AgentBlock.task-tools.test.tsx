import { describe, expect, it } from "vitest";
import { render } from "@/test-utils";
import { AgentBlock, type AgentBlockData } from "./AgentBlock";

function makeTaskToolBlock(toolName: "TaskCreate" | "TaskUpdate"): AgentBlockData {
  return {
    id: toolName,
    type: "tool_call",
    content: JSON.stringify({ subject: "Hidden task" }),
    toolArgs: JSON.stringify({ subject: "Hidden task" }),
    toolName,
  };
}

describe("AgentBlock task todo tools", () => {
  it("hides TaskCreate tool calls like TodoWrite", () => {
    const { container } = render(<AgentBlock block={makeTaskToolBlock("TaskCreate")} />);
    expect(container.firstChild).toBeNull();
  });

  it("hides TaskUpdate tool calls like TodoWrite", () => {
    const { container } = render(<AgentBlock block={makeTaskToolBlock("TaskUpdate")} />);
    expect(container.firstChild).toBeNull();
  });
});
