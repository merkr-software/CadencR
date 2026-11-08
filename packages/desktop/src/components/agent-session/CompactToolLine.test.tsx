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

  describe("a failed call", () => {
    const sleep = toolCall({
      toolUseId: "u1",
      toolArgs: JSON.stringify({ command: "sleep 120 | cat" }),
    });

    it("marks an interrupted shell command with its reason, without its output", () => {
      render(
        <CompactToolLine
          block={sleep}
          result={{
            id: "r1",
            type: "tool_result",
            toolUseId: "u1",
            isError: true,
            content: "Shell command interrupted by user.\npartial output",
          }}
        />,
      );
      expect(screen.getByText("sleep 120 | cat")).toBeInTheDocument();
      expect(screen.getByText("Shell command interrupted by user.")).toBeInTheDocument();
      expect(screen.queryByText(/partial output/)).not.toBeInTheDocument();
      expect(screen.getByTitle("Shell command interrupted by user.")).toBeInTheDocument();
    });

    it("marks any tool whose result is an error", () => {
      render(
        <CompactToolLine
          block={toolCall({ toolName: "Grep", toolUseId: "u2", toolArgs: '{"pattern":"x"}' })}
          result={{
            id: "r2",
            type: "tool_result",
            toolUseId: "u2",
            isError: true,
            content: "\n  ripgrep: no such directory\n",
          }}
        />,
      );
      expect(screen.getByText("ripgrep: no such directory")).toBeInTheDocument();
    });

    it("reads a provider's failed status before any result arrives", () => {
      render(
        <CompactToolLine
          block={toolCall({
            toolArgs: JSON.stringify({
              command: "false",
              status: "failed",
              error: { message: "exit code 1" },
            }),
          })}
        />,
      );
      expect(screen.getByText("exit code 1")).toBeInTheDocument();
    });

    it("reads the reason a `!` command carries in its own output", () => {
      render(
        <CompactToolLine
          block={toolCall({
            toolArgs: JSON.stringify({
              command: "sleep 120 | cat",
              output: "Shell command interrupted by user.",
              status: "failed",
            }),
          })}
        />,
      );
      expect(screen.getByText("Shell command interrupted by user.")).toBeInTheDocument();
    });

    it("says Failed when the failure gave no reason", () => {
      render(
        <CompactToolLine
          block={toolCall({ toolName: "Read", toolArgs: '{"file_path":"a","status":"failed"}' })}
        />,
      );
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });

    it("reads no status from a cut wire preview", () => {
      render(
        <CompactToolLine
          block={toolCall({
            toolName: "Read",
            toolArgs: '{"file_path":"a","status":"failed"}',
            truncatedContent: true,
          })}
        />,
      );
      expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    });

    it("leaves a successful call unmarked", () => {
      render(
        <CompactToolLine
          block={sleep}
          result={{ id: "r3", type: "tool_result", toolUseId: "u1", content: "done" }}
        />,
      );
      expect(screen.queryByText("done")).not.toBeInTheDocument();
      expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    });
  });
});
