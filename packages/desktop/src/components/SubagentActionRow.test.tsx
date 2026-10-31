import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import type { AgentBlockData } from "@/types/agent-block";
import { SubagentActionRow } from "./SubagentActionRow";

function toolCall(overrides: Partial<AgentBlockData> = {}): AgentBlockData {
  return { id: "t1", type: "tool_call", content: "", toolName: "Bash", ...overrides };
}

describe("SubagentActionRow", () => {
  it("renders only the first markdown line when collapsed", () => {
    render(
      <SubagentActionRow
        block={{
          id: "txt",
          type: "text",
          content: "## System audio\n\nhello **world** from the subagent",
        }}
      />,
    );
    expect(screen.queryByText("Text")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "System audio" })).toBeInTheDocument();
    expect(screen.queryByText("world")).toBeNull();
  });

  it("renders the full compact markdown when expanded", () => {
    render(
      <SubagentActionRow
        block={{
          id: "txt",
          type: "text",
          content: "## System audio\n\nhello **world** from the subagent",
        }}
        expanded
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "System audio" })).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
  });

  it("renders Bash with the command as detail", () => {
    render(
      <SubagentActionRow
        block={toolCall({ toolArgs: JSON.stringify({ command: "pnpm test" }) })}
      />,
    );
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
  });

  it("renders Edit with a path detail", () => {
    render(
      <SubagentActionRow
        block={toolCall({
          toolName: "Edit",
          toolArgs: JSON.stringify({
            file_path: "src/foo.ts",
            old_string: "a",
            new_string: "b",
          }),
        })}
      />,
    );
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });

  it("renders thinking", () => {
    render(<SubagentActionRow block={{ id: "th", type: "thinking", content: "ponder" }} />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("ponder")).toBeInTheDocument();
  });
});
