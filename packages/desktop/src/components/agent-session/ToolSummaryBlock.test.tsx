import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { fireEvent } from "@testing-library/react";
import { ToolSummaryBlock } from "./ToolSummaryBlock";
import type { AgentBlockData } from "@/types/agent-block";

function makeToolBlock(id: string): AgentBlockData {
  return {
    id,
    type: "tool_call",
    content: JSON.stringify({ file_path: "a.ts" }),
    toolArgs: JSON.stringify({ file_path: "a.ts" }),
    toolName: "Read",
  };
}

const DETAIL = [makeToolBlock("t1"), makeToolBlock("t2")];

describe("ToolSummaryBlock footer collapse button", () => {
  it("has no footer button while collapsed, then reveals one that collapses the block", () => {
    render(<ToolSummaryBlock childBlocks={DETAIL} />);

    const header = screen.getByRole("button", { name: /tools used/i });
    // Collapsed: only the header exists — the footer lives inside the collapsible.
    expect(screen.queryByRole("button", { name: /^collapse$/i })).toBeNull();

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");

    // Expanded: the footer "Collapse" button appears and re-collapses the block.
    const footer = screen.getByRole("button", { name: /^collapse$/i });
    fireEvent.click(footer);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });
});
