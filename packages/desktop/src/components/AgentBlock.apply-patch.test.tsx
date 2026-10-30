import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { AgentBlock } from "./AgentBlock";
import type { AgentBlockData } from "@/types/agent-block";

vi.mock("./InlineDiffBlock", () => ({
  InlineDiffBlock: ({ filePath }: { filePath: string }) => (
    <div data-testid="inline-diff">{filePath}</div>
  ),
}));

function makeBlock(overrides: Partial<AgentBlockData>): AgentBlockData {
  return {
    id: "block-1",
    type: "text",
    content: "Default content",
    ...overrides,
  };
}

describe("AgentBlock ApplyPatch rendering", () => {
  it("renders every file from a multi-file OpenCode ApplyPatch payload", () => {
    render(
      <AgentBlock
        block={makeBlock({
          type: "tool_call",
          toolName: "ApplyPatch",
          toolArgs: JSON.stringify({
            patchText:
              "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: src/b.ts\n@@\n-c\n+d\n*** End Patch",
          }),
        })}
      />,
    );

    const diffs = screen.getAllByTestId("inline-diff");
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toHaveTextContent("src/a.ts");
    expect(diffs[1]).toHaveTextContent("src/b.ts");
  });
});
