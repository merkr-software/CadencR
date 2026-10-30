import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { buildToolChips } from "./agentStreamToolChips";

function tool(id: string, toolName: string, toolArgs?: string): AgentBlockData {
  return { id, type: "tool_call", content: "", toolName, toolArgs };
}

describe("buildToolChips", () => {
  it("groups by tool name preserving first-appearance order", () => {
    const chips = buildToolChips([tool("t1", "Read"), tool("t2", "Bash"), tool("t3", "Read")]);
    expect(chips.map((c) => [c.label, c.count])).toEqual([
      ["Read", 2],
      ["Bash", 1],
    ]);
  });

  it("assigns the shared accent per tool kind", () => {
    const chips = buildToolChips([tool("t1", "Bash"), tool("t2", "Edit"), tool("t3", "Read")]);
    const accents = Object.fromEntries(chips.map((c) => [c.label, c.accent]));
    expect(accents).toEqual({ Bash: "bash", Edit: "edit", Read: "tool" });
  });

  it("skips todo bookkeeping tools", () => {
    const chips = buildToolChips([
      tool("t1", "TodoWrite"),
      tool("t2", "TaskCreate"),
      tool("t3", "Read"),
    ]);
    expect(chips.map((c) => c.label)).toEqual(["Read"]);
  });

  it("aggregates numstat across every call in a file-change group", () => {
    const edit = (id: string, oldStr: string, newStr: string): AgentBlockData =>
      tool(
        id,
        "Edit",
        JSON.stringify({ file_path: "a.ts", old_string: oldStr, new_string: newStr }),
      );
    const chips = buildToolChips([edit("t1", "one", "one\ntwo"), edit("t2", "x", "x\ny\nz")]);
    expect(chips).toHaveLength(1);
    expect(chips[0].accent).toBe("edit");
    expect(chips[0].additions).toBe(3);
    expect(chips[0].deletions).toBe(0);
  });

  it("labels MCP tools with the friendly name, accent, and server badge", () => {
    const chips = buildToolChips([
      tool("t1", "mcp__cadencr-browser__browser_open_url", JSON.stringify({ url: "https://x" })),
    ]);
    expect(chips[0]).toMatchObject({
      label: "Opening URL",
      accent: "mcp",
      mcpServer: "browser",
      count: 1,
    });
  });

  it("groups semantic skill reads as Skill without changing ordinary reads", () => {
    const skillArgs = JSON.stringify({
      type: "read",
      command: "cat .agents/skills/db/SKILL.md",
      path: "/repo/.agents/skills/db/SKILL.md",
    });
    const chips = buildToolChips([tool("t1", "Read", skillArgs), tool("t2", "Read")]);
    expect(chips.map((chip) => [chip.label, chip.count])).toEqual([
      ["Skill", 1],
      ["Read", 1],
    ]);
  });

  it("normalizes historical bare MCP tool names", () => {
    const chips = buildToolChips([
      tool(
        "t1",
        "chrome-devtools_take_screenshot",
        JSON.stringify({ filePath: "/tmp/capture.png" }),
      ),
    ]);
    expect(chips[0]).toMatchObject({
      label: "Taking screenshot",
      accent: "mcp",
      mcpServer: "chrome-devtools",
    });
  });

  it("groups equivalent MCP namespace variants by semantic identity", () => {
    const chips = buildToolChips([
      tool("t1", "mcp__chrome-devtools__click"),
      tool("t2", "mcp__chrome_devtools____click"),
    ]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ label: "Clicking", count: 2 });
  });
});
