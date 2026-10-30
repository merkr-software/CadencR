import { describe, expect, it } from "vitest";
import type { SubagentRun } from "@/api/generated";
import type { AgentBlockData } from "@/types/agent-block";
import { buildDisplayItems } from "@/lib/agent-stream-display";
import { countSubagentToolCalls } from "@/components/subagent-actions";
import { displayShellCommand } from "@/lib/tool-adapter";
import { subagentActionCount, subagentElapsedMs, subagentView } from "./subagent-presentation";
import { subagentChildren, subagentReport, subagentReportFor } from "./subagent-report";
import { parseSubagentRun, upsertSubagentRun } from "./subagent-runs";

const T0 = Date.parse("2026-10-30T10:00:00.000Z");

function run(id: string, overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    sessionId: 1,
    toolUseId: id,
    status: "completed",
    modelResolved: false,
    background: false,
    startedAt: "2026-10-30T10:00:00.000Z",
    endedAt: "2026-10-30T10:01:00.000Z",
    ...overrides,
  };
}

describe("sub-agent pushes", () => {
  it("validates the wire payload", () => {
    expect(parseSubagentRun({ toolUseId: "x" })).toBeNull();
    expect(parseSubagentRun(run("a"))?.toolUseId).toBe("a");
  });

  it("prepends new runs and keeps listed transcript counts on update", () => {
    const listed = [run("a", { actionCount: 7 })];
    const added = upsertSubagentRun(listed, run("b"));
    expect(added.map((entry) => entry.toolUseId)).toEqual(["b", "a"]);
    const updated = upsertSubagentRun(added, run("a", { status: "failed", actionCount: null }));
    expect(updated[1].status).toBe("failed");
    expect(updated[1].actionCount).toBe(7);
  });
});

describe("sub-agent view", () => {
  it("prefers the registry run and falls back to the carrier input", () => {
    const carrier = {
      toolName: "Agent",
      toolArgs: JSON.stringify({
        subagent_type: "Explore",
        description: "scan",
        model: "haiku",
      }),
    };
    const fallback = subagentView(undefined, carrier);
    expect(fallback).toMatchObject({
      status: "running",
      title: "Explore",
      model: "haiku",
    });
    const tracked = subagentView(
      run("a", {
        agentName: "scout",
        model: "claude-haiku-5-5",
        modelResolved: true,
      }),
      carrier,
    );
    expect(tracked).toMatchObject({
      status: "completed",
      title: "scout",
      modelRequested: false,
    });
  });

  it("reports elapsed time from the run, live while running", () => {
    const done = subagentView(run("a", { durationMs: 42_500 }));
    expect(subagentElapsedMs(done, T0)).toBe(42_500);
    const live = subagentView(run("b", { status: "running", endedAt: null }));
    expect(subagentElapsedMs(live, T0 + 5_000)).toBe(5_000);
  });
});

describe("sub-agent report", () => {
  const block = (overrides: Partial<AgentBlockData>): AgentBlockData => ({
    id: Math.random().toString(36),
    type: "text",
    content: "",
    ...overrides,
  });

  it("prefers the carrier's result, skipping a background launch ack", () => {
    const children = [
      block({ content: "thinking out loud" }),
      block({
        type: "tool_result",
        sourceToolName: "Agent",
        content: "Async agent launched successfully. The agent is working in the background.",
      }),
      block({ content: "Final findings" }),
    ];
    expect(subagentReport(children)).toBe("Final findings");
    children.push(
      block({
        type: "tool_result",
        sourceToolName: "Agent",
        content: JSON.stringify([{ type: "text", text: "Report body" }]),
      }),
    );
    expect(subagentReport(children)).toBe("Report body");
  });

  it("reads a handed-back report over the carrier's pointer to it", () => {
    const pointer =
      'This agent\'s report was delivered to you as a message from "a35a" (its SubagentHandback call). Read it there; it is not repeated here.';
    const children = [
      block({ type: "tool_call", toolName: "Read", toolArgs: "{}" }),
      block({ type: "tool_call", toolName: "TodoWrite", toolArgs: "{}" }),
      block({ content: "Done reading." }),
      block({
        type: "tool_call",
        toolName: "SubagentHandback",
        toolArgs: JSON.stringify({ message: "  Three adapters found.  " }),
      }),
      block({ type: "tool_result", sourceToolName: "Agent", content: pointer }),
    ];
    expect(subagentReport(children)).toBe("Three adapters found.");
    expect(countSubagentToolCalls(children)).toBe(1);
    // Without the handback in view, the pointer still never reads as the report.
    expect(subagentReport(children.filter((child) => child.toolName !== "SubagentHandback"))).toBe(
      "Done reading.",
    );
  });
});

describe("one report and one count per card", () => {
  it("prefers the provider's count, else the most the transcript shows", () => {
    expect(subagentActionCount(subagentView(run("a", { toolUseCount: 4 })), { shown: 9 })).toBe(4);
    expect(subagentActionCount(subagentView(run("a")), { shown: 2, listed: 5 })).toBe(5);
    expect(subagentActionCount(subagentView(run("a")), { shown: 0 })).toBeNull();
  });

  it("reads an older carrier's persisted output and hides the report while running", () => {
    const children = subagentChildren({
      id: "c",
      toolArgs: JSON.stringify({ output: "Persisted report" }),
    });
    expect(children.map((child) => child.content)).toEqual(["Persisted report"]);
    expect(subagentReportFor(subagentView(run("a")), children)).toBe("Persisted report");
    const live = subagentView(run("a", { status: "running", resultSummary: "x" }));
    expect(subagentReportFor(live, children)).toBeNull();
    const summaryOnly = subagentView(run("a", { resultSummary: "From the registry" }));
    expect(subagentReportFor(summaryOnly, [])).toBe("From the registry");
  });
});

describe("compact flow", () => {
  it("keeps a sub-agent carrier out of folded tool runs", () => {
    const blocks: AgentBlockData[] = [
      {
        id: "read",
        type: "tool_call",
        content: "",
        toolName: "Read",
        toolArgs: "{}",
      },
      {
        id: "agent",
        type: "tool_call",
        content: "",
        toolName: "Agent",
        toolArgs: "{}",
      },
      {
        id: "grep",
        type: "tool_call",
        content: "",
        toolName: "Grep",
        toolArgs: "{}",
      },
    ];
    const items = buildDisplayItems(blocks, { compact: true });
    expect(items.map((item) => item.kind)).toEqual(["flow", "block", "flow"]);
  });
});

describe("one-line summaries", () => {
  it("drops a login-shell wrapper and says a name once", () => {
    expect(displayShellCommand("/bin/zsh -lc 'sleep 5 && wc -l README.md'")).toBe(
      "sleep 5 && wc -l README.md",
    );
    expect(displayShellCommand(`bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
    expect(displayShellCommand("ls -la")).toBe("ls -la");
    const view = subagentView(run("a", { agentName: "readme_check", description: "readme_check" }));
    expect(view.description).toBeNull();
  });
});
