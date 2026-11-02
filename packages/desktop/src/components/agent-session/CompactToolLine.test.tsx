import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import type { AgentBlockData } from "@/types/agent-block";
import { CompactToolLine } from "./CompactToolLine";

function toolCall(overrides: Partial<AgentBlockData> = {}): AgentBlockData {
  return { id: "t1", type: "tool_call", content: "", toolName: "Bash", ...overrides };
}

describe("CompactToolLine", () => {
  it("shows the first line of a thinking block, without markdown marks", () => {
    render(
      <CompactToolLine
        block={{ id: "th1", type: "thinking", content: "\n**Planning** the fix\nmore" }}
      />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Planning the fix")).toBeInTheDocument();
    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });

  it("shows the Bash command on one line, relative to the worktree", () => {
    render(
      <CompactToolLine
        basePath="/repo"
        block={toolCall({ toolArgs: JSON.stringify({ command: "cat /repo/a.ts\n  | head" }) })}
      />,
    );
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("cat a.ts | head")).toBeInTheDocument();
  });

  it("shows the edited path and a numstat for file changes", () => {
    render(
      <CompactToolLine
        basePath="/repo"
        block={toolCall({
          toolName: "Edit",
          toolArgs: JSON.stringify({
            file_path: "/repo/src/foo.ts",
            old_string: "one",
            new_string: "two",
          }),
        })}
      />,
    );
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
    expect(screen.getByText(/\+\d/)).toBeInTheDocument();
    expect(screen.getByText(/-\d/)).toBeInTheDocument();
  });

  it("shows the main argument of other tools", () => {
    render(
      <CompactToolLine
        block={toolCall({ toolName: "Grep", toolArgs: JSON.stringify({ pattern: "TODO" }) })}
      />,
    );
    expect(screen.getByText("Grep")).toBeInTheDocument();
    expect(screen.getByText("TODO")).toBeInTheDocument();
  });

  it("shows only the name of a truncated wire preview", () => {
    render(
      <CompactToolLine
        block={toolCall({
          toolArgs: JSON.stringify({ command: "printf partial" }),
          truncatedContent: true,
        })}
      />,
    );
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.queryByText(/printf/)).not.toBeInTheDocument();
  });

  it("renders semantic skill reads as a Skill line", () => {
    render(
      <CompactToolLine
        block={toolCall({
          toolName: "Read",
          toolArgs: JSON.stringify({
            type: "read",
            command: "cat .agents/skills/qa/SKILL.md",
            path: "/repo/.agents/skills/qa/SKILL.md",
          }),
        })}
      />,
    );
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(screen.getByText("qa")).toBeInTheDocument();
  });

  it.each(["collaboration__wait_agent", "TodoWrite"])("renders nothing for %s", (toolName) => {
    const { container } = render(<CompactToolLine block={toolCall({ toolName })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("gives file-change tools a distinct icon accent from generic tools", () => {
    const { container, rerender } = render(
      <CompactToolLine
        block={toolCall({
          toolName: "Edit",
          toolArgs: JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y" }),
        })}
      />,
    );
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("--numstat-add-fg");

    rerender(<CompactToolLine block={toolCall({ toolName: "Grep" })} />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("--block-tool-accent");
  });

  it("renders nothing for unsupported block types", () => {
    const { container } = render(
      <CompactToolLine block={{ id: "x", type: "text", content: "hello" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
