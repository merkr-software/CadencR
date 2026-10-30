import { describe, expect, it } from "vitest";
import { shouldGateFullContent } from "@/lib/agent-block-content";
import type { AgentBlockData } from "@/types/agent-block";

const gate = (args: unknown) =>
  shouldGateFullContent({
    id: "msg-42",
    type: "tool_call",
    toolName: "Bash",
    content: JSON.stringify(args),
    toolArgs: JSON.stringify(args),
    truncatedContent: true,
  });

describe("Bash output previews", () => {
  it("keeps the Bash card for a bounded output tail and a complete command", () => {
    expect(gate({ command: "pnpm test", output: "ok\n".repeat(200) })).toBe(false);
  });

  it("keeps the protected preview for a single enormous output line", () => {
    expect(gate({ command: "cat data.json", output: "x".repeat(8192) })).toBe(true);
    expect(gate({ command: "cat data.json", output: "é".repeat(4096) })).toBe(true);
    expect(gate({ command: "cat data.json", output: "€".repeat(2730) })).toBe(true);
    expect(gate({ command: "cat data.json", output: "😀".repeat(2047) + "x" })).toBe(true);
  });

  it("invalidates cached eligibility when a streamed block changes in place", () => {
    const block: AgentBlockData = {
      id: "msg-42",
      type: "tool_call",
      toolName: "Bash",
      truncatedContent: true,
      content: JSON.stringify({ command: "cat log", output: "ok" }),
    };
    expect(shouldGateFullContent(block)).toBe(false);
    expect(shouldGateFullContent(block)).toBe(false);
    block.content = JSON.stringify({ command: "cat log", output: "x".repeat(8192) });
    expect(shouldGateFullContent(block)).toBe(true);
  });

  it("does not present truncated or missing arguments as a complete command", () => {
    expect(gate({ command: "echo … content truncated …", output: "ok" })).toBe(true);
    expect(
      gate({ command: "echo … [preview truncated; expand to load full content]", output: "ok" }),
    ).toBe(true);
    expect(gate({ command: "echo hi" })).toBe(true);
    expect(gate({ _cadencrPreview: "structure too large" })).toBe(true);
  });
});
