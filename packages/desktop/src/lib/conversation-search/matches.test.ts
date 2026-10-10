// @vitest-environment happy-dom
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

  it("searches a completed Bash call's output from its paired tool_result", () => {
    // Once a command finishes the backend drops the duplicate output off the
    // tool_call (`session_tool_output_dedup.rs`), leaving the result row as the
    // only copy. Reading `toolArgs` alone would stop matching finished commands.
    const toolCall: AgentBlockData = {
      id: "t",
      type: "tool_call",
      content: "",
      toolName: "Bash",
      toolUseId: "tu-1",
      toolArgs: '{"command":"pnpm test","status":"completed"}',
    };
    const result: AgentBlockData = {
      id: "r",
      type: "tool_result",
      content: '{"output":"all 42 tests passed"}',
      sourceToolName: "Bash",
    };
    const resultMap = new Map([["tu-1", result]]);

    expect(blockSearchableText(toolCall, resultMap)).toContain("all 42 tests passed");
    // Without the map there is nothing left to find — the regression this guards.
    expect(blockSearchableText(toolCall)).not.toContain("all 42 tests passed");
  });

  it("keeps a non-Bash tool's arguments searchable when it has a result", () => {
    // `extractBashResultOutput` returns a plain-string result whole, so
    // resolving output from the result for *every* tool would take this branch
    // and drop the args — even though the diff is what renders in the DOM.
    const editCall: AgentBlockData = {
      id: "t",
      type: "tool_call",
      content: "",
      toolName: "Edit",
      toolUseId: "tu-9",
      toolArgs: '{"file_path":"src/app.ts","old_string":"oldToken","new_string":"newToken"}',
    };
    const result: AgentBlockData = {
      id: "r",
      type: "tool_result",
      content: "The file src/app.ts has been updated.",
      sourceToolName: "Edit",
    };
    const resultMap = new Map([["tu-9", result]]);

    const text = blockSearchableText(editCall, resultMap);
    expect(text).toContain("oldToken");
    expect(text).toContain("newToken");
    expect(text).toContain("src/app.ts");
  });

  it("does not mistake command-shaped custom-tool arguments for Bash", () => {
    const customCall: AgentBlockData = {
      id: "t",
      type: "tool_call",
      content: "",
      toolName: "mcp__runner__execute",
      toolUseId: "tu-custom",
      toolArgs: JSON.stringify({ command: "deploy", output: "configuration preview" }),
    };
    const result: AgentBlockData = {
      id: "r",
      type: "tool_result",
      content: "plain result that is rendered separately",
      sourceToolName: "mcp__runner__execute",
    };

    const text = blockSearchableText(customCall, new Map([["tu-custom", result]]));
    expect(text).toContain("deploy");
    expect(text).toContain("configuration preview");
    expect(text).not.toContain("plain result");
  });

  it("does not pull a Read result's file contents into the tool_call's text", () => {
    // The Read row never renders that content, so counting it would inflate
    // match counts against a row the user can't see the match in.
    const readCall: AgentBlockData = {
      id: "t",
      type: "tool_call",
      content: "",
      toolName: "Read",
      toolUseId: "tu-8",
      toolArgs: '{"file_path":"src/secret.ts"}',
    };
    const result: AgentBlockData = {
      id: "r",
      type: "tool_result",
      content: "const zebrafish = 1;",
      sourceToolName: "Read",
    };

    const text = blockSearchableText(readCall, new Map([["tu-8", result]]));
    expect(text).toContain("src/secret.ts");
    expect(text).not.toContain("zebrafish");
  });

  it("falls back to the tool_call payload while a command is still running", () => {
    // Providers that never emit tool_result rows (OpenCode) and in-flight
    // commands keep their output on the tool_call; it must stay searchable.
    const running: AgentBlockData = {
      id: "t",
      type: "tool_call",
      content: "",
      toolName: "Bash",
      toolUseId: "tu-2",
      toolArgs: '{"command":"pnpm dev","output":"listening on 1420","status":"running"}',
    };
    expect(blockSearchableText(running, new Map())).toContain("listening on 1420");
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
