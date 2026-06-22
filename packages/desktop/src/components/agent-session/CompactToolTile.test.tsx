import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import type { AgentBlockData } from "@/components/AgentBlock";
import { CompactToolTile } from "./CompactToolTile";

function toolCall(overrides: Partial<AgentBlockData> = {}): AgentBlockData {
  return { id: "t1", type: "tool_call", content: "", toolName: "Bash", ...overrides };
}

describe("CompactToolTile", () => {
  it("renders a 'Thinking' tile for thinking blocks", () => {
    render(<CompactToolTile block={{ id: "th1", type: "thinking", content: "musing" }} />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("renders Bash tiles with the command head as detail text", () => {
    render(
      <CompactToolTile
        block={toolCall({
          toolName: "Bash",
          toolArgs: JSON.stringify({ command: "ls -la" }),
        })}
      />,
    );
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText(/ls -la/)).toBeInTheDocument();
  });

  it("renders Edit tiles with a numstat trailing widget", () => {
    render(
      <CompactToolTile
        block={toolCall({
          toolName: "Edit",
          toolArgs: JSON.stringify({
            file_path: "src/foo.ts",
            old_string: "one",
            new_string: "two",
          }),
        })}
      />,
    );
    expect(screen.getByText("Edit")).toBeInTheDocument();
    // NumStat shows additions and deletions next to the label.
    expect(screen.getByText(/\+\d/)).toBeInTheDocument();
    expect(screen.getByText(/-\d/)).toBeInTheDocument();
  });

  it("falls back to the tool name for unknown tools", () => {
    render(<CompactToolTile block={toolCall({ toolName: "Grep" })} />);
    expect(screen.getByText("Grep")).toBeInTheDocument();
  });

  it("gives file-change tools a distinct accent from generic tools", () => {
    const { rerender } = render(
      <CompactToolTile
        block={toolCall({
          toolName: "Edit",
          toolArgs: JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y" }),
        })}
      />,
    );
    // File-patch tools use the green "lines changed" accent so they stand apart.
    expect(screen.getByText("Edit").className).toContain("--numstat-add-fg");

    rerender(<CompactToolTile block={toolCall({ toolName: "Grep" })} />);
    expect(screen.getByText("Grep").className).toContain("--block-tool-accent");
  });

  it("renders nothing for unsupported block types", () => {
    const { container } = render(
      <CompactToolTile block={{ id: "x", type: "text", content: "hello" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
