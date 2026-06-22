import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/components/AgentBlock";
import type { DisplayItem } from "@/components/agentStreamDisplay";
import { blockSearchableText, computeConversationMatches } from "./matches";

function block(id: string, content: string, type: AgentBlockData["type"] = "text"): AgentBlockData {
  return { id, type, content };
}

function row(b: AgentBlockData): DisplayItem {
  return { kind: "block", key: b.id, block: b };
}

describe("blockSearchableText", () => {
  it("returns prose content for text-like blocks", () => {
    expect(blockSearchableText(block("1", "hello world"))).toBe("hello world");
    expect(blockSearchableText(block("2", "thinking…", "thinking"))).toBe("thinking…");
  });

  it("combines tool name, args, and content for tool calls", () => {
    const toolCall: AgentBlockData = {
      id: "t",
      type: "tool_call",
      content: "",
      toolName: "Bash",
      toolArgs: '{"command":"grep foo"}',
    };
    const text = blockSearchableText(toolCall);
    expect(text).toContain("Bash");
    expect(text).toContain("grep foo");
  });

  it("ignores dividers and turn summaries", () => {
    expect(blockSearchableText(block("d", "ignored", "clear_divider"))).toBe("");
    expect(blockSearchableText(block("s", "ignored", "turn_summary"))).toBe("");
  });

  it("searches a Bash payload's command and visible output tail, not its hidden head", () => {
    // Bash `toolArgs` embeds the full output, but the row only renders the
    // command plus the output's last lines — so matches in the collapsed head
    // (which can never be highlighted) must not be counted. Regression for
    // navigation landing repeatedly on the same visible match.
    const lines = [
      "needle in head",
      ...Array.from({ length: 11 }, (_, i) => `filler ${i}`),
      "needle in tail",
    ];
    const bash: AgentBlockData = {
      id: "bash",
      type: "tool_call",
      content: "",
      toolName: "Bash",
      toolArgs: JSON.stringify({ command: "run pipeline", output: lines.join("\n") }),
    };
    const text = blockSearchableText(bash);
    expect(text).toContain("run pipeline");
    expect(text).toContain("needle in tail");
    expect(text).not.toContain("needle in head");
    expect(computeConversationMatches([row(bash)], "needle")).toHaveLength(1);
  });
});

describe("computeConversationMatches", () => {
  const items: DisplayItem[] = [
    row(block("a", "The quick brown fox")),
    row(block("b", "fox fox fox", "user_message")),
  ];

  it("returns no matches for an empty or whitespace query", () => {
    expect(computeConversationMatches(items, "")).toEqual([]);
    expect(computeConversationMatches(items, "   ")).toEqual([]);
  });

  it("matches case-insensitively across blocks in document order", () => {
    const matches = computeConversationMatches(items, "FOX");
    expect(matches).toHaveLength(4);
    expect(matches.map((m) => m.blockId)).toEqual(["a", "b", "b", "b"]);
    expect(matches.map((m) => m.rowIndex)).toEqual([0, 1, 1, 1]);
    expect(matches.map((m) => m.occurrenceInBlock)).toEqual([0, 0, 1, 2]);
  });

  it("counts every occurrence within a block separately", () => {
    const matches = computeConversationMatches([row(block("x", "aaaa"))], "aa");
    // Non-overlapping scan: "aaaa" contains "aa" twice.
    expect(matches).toHaveLength(2);
  });

  it("searches every block inside a compact flow row", () => {
    const flow: DisplayItem = {
      kind: "flow",
      key: "flow",
      blocks: [block("c1", "needle one", "tool_call"), block("c2", "needle two", "tool_call")],
    };
    const matches = computeConversationMatches([flow], "needle");
    expect(matches.map((m) => m.blockId)).toEqual(["c1", "c2"]);
    expect(matches.every((m) => m.rowIndex === 0)).toBe(true);
  });
});
