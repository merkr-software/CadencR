import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/components/AgentBlock";
import {
  firstSubagentMarkdownLine,
  isNestedSubagentBlock,
  isSubagentAction,
  selectSubagentActions,
  truncateSubagentText,
} from "./subagent-actions";

function block(
  partial: Partial<AgentBlockData> & Pick<AgentBlockData, "id" | "type">,
): AgentBlockData {
  return { content: "", ...partial };
}

describe("selectSubagentActions", () => {
  it("keeps tool calls, text, and thinking — drops tool results and todos", () => {
    const selected = selectSubagentActions([
      block({ id: "t1", type: "tool_call", toolName: "Bash" }),
      block({ id: "r1", type: "tool_result", content: "out" }),
      block({ id: "txt", type: "text", content: "hello" }),
      block({ id: "empty", type: "text", content: "  " }),
      block({ id: "th", type: "thinking", content: "…" }),
      block({ id: "todo", type: "tool_call", toolName: "TodoWrite" }),
      block({ id: "hidden", type: "tool_call", toolName: "collaboration__wait_agent" }),
    ]);
    expect(selected.map((b) => b.id)).toEqual(["t1", "txt", "th"]);
  });
});

describe("isNestedSubagentBlock", () => {
  it("detects Task/Agent carriers with childBlocks", () => {
    expect(
      isNestedSubagentBlock(
        block({ id: "n", type: "tool_call", toolName: "Task", childBlocks: [] }),
      ),
    ).toBe(true);
    expect(isNestedSubagentBlock(block({ id: "b", type: "tool_call", toolName: "Bash" }))).toBe(
      false,
    );
  });
});

describe("truncateSubagentText", () => {
  it("collapses whitespace and truncates", () => {
    expect(truncateSubagentText("a\n\nb", 10)).toBe("a b");
    expect(truncateSubagentText("abcdefghijklmnop", 8)).toBe("abcdefg…");
  });
});

describe("firstSubagentMarkdownLine", () => {
  it("returns the first non-empty source line", () => {
    expect(firstSubagentMarkdownLine("## Title\n\nbody **bold**")).toBe("## Title");
    expect(firstSubagentMarkdownLine("\n\nhello **x**\nmore")).toBe("hello **x**");
    expect(firstSubagentMarkdownLine("   ")).toBe("");
  });
});

describe("isSubagentAction", () => {
  it("rejects empty text", () => {
    expect(isSubagentAction(block({ id: "e", type: "text", content: "" }))).toBe(false);
  });
});
