import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { TRUNCATION_NOTICE } from "@/lib/block-content-budget";
import { latestValidJsonSnapshot, mergeToolContent } from "./ws-tool-content";

const bashBlock = (content: string): AgentBlockData => ({
  id: "bash-1",
  type: "tool_call",
  content,
  toolName: "Bash",
  toolArgs: content,
  toolUseId: "tu-bash-1",
});

describe("mergeToolContent", () => {
  it("appends Bash output delta patches without cumulative snapshots", () => {
    const previous = JSON.stringify({ command: "printf hi", status: "running" });

    const first = mergeToolContent(
      bashBlock(previous),
      JSON.stringify({ __cadencr_output_delta: "hi" }),
      "update",
    );
    const second = mergeToolContent(
      bashBlock(first.text),
      JSON.stringify({ __cadencr_output_delta: " there" }),
      "update",
    );

    expect(second.truncated).toBe(false);
    expect(JSON.parse(second.text)).toEqual({
      command: "printf hi",
      status: "running",
      output: "hi there",
    });
  });

  // A command that prints megabytes must not park them in the store: the server
  // persists only the last 200 lines / 8 KB of this field anyway.
  it("bounds accumulated Bash output and keeps the newest of it", () => {
    let merged = mergeToolContent(
      bashBlock(JSON.stringify({ command: "build" })),
      JSON.stringify({ __cadencr_output_delta: "x".repeat(200_000) }),
      "update",
    );
    merged = mergeToolContent(
      bashBlock(merged.text),
      JSON.stringify({ __cadencr_output_delta: "FINAL LINE" }),
      "update",
    );

    expect(merged.truncated).toBe(true);
    const parsed = JSON.parse(merged.text) as { command: string; output: string };
    // Still a valid envelope, so the renderers keep working on it.
    expect(parsed.command).toBe("build");
    expect(parsed.output.length).toBeLessThan(20_000);
    expect(parsed.output.endsWith("FINAL LINE")).toBe(true);
  });

  // Codex streams a tool envelope as raw JSON fragments, so the accumulator is
  // unparseable until the last one lands. Clamping it mid-flight left a notice
  // inside a string literal and the Bash block rendered its own raw JSON.
  it("keeps an accumulating tool envelope parseable rather than clamping it", () => {
    const head = `{"command":"seq","aggregatedOutput":"${"line of output\\n".repeat(20_000)}`;
    const existing: AgentBlockData = {
      id: "tc1",
      type: "tool_call",
      toolName: "Bash",
      content: head,
    };

    const midStream = mergeToolContent(existing, "more output", "update");
    expect(midStream.truncated).toBe(false);
    expect(midStream.text).not.toContain(TRUNCATION_NOTICE);

    // Once the closing brace arrives it can be clamped without breaking it.
    const completed = mergeToolContent({ ...existing, content: midStream.text }, '"}', "update");
    expect(completed.truncated).toBe(true);
    expect(() => JSON.parse(completed.text)).not.toThrow();
    expect(JSON.parse(completed.text).command).toBe("seq");
  });

  it("reports truncation on the raw append path so the block can be flagged", () => {
    const existing: AgentBlockData = { id: "t1", type: "text", content: "a".repeat(200_000) };
    const merged = mergeToolContent(existing, "b".repeat(200_000), "update");
    expect(merged.truncated).toBe(true);
    expect(merged.text).toContain(TRUNCATION_NOTICE);
  });
});

describe("latestValidJsonSnapshot", () => {
  it("returns content that already parses", () => {
    const json = JSON.stringify({ file_path: "/a.ts" });
    expect(latestValidJsonSnapshot(json)).toBe(json);
  });

  it("recovers the last complete object from concatenated snapshots", () => {
    const first = JSON.stringify({ file_path: "/a.ts", content: "one" });
    const second = JSON.stringify({ file_path: "/a.ts", content: "two" });
    expect(latestValidJsonSnapshot(first + second)).toBe(second);
  });

  // Tool args stream in as partial JSON fragments, so a clamped accumulator has
  // a notice spliced into its middle and can never parse again. Scanning
  // backward for the last `{` would then surface a *nested* object and pass it
  // off as the tool's arguments — a wrong file path or a wrong diff. Refusing
  // leaves the caller on its previous snapshot, which is stale but never wrong.
  it("refuses to guess once the accumulator has been clamped", () => {
    const clamped = `{"file_path":"/a.ts","edits":\n\n${TRUNCATION_NOTICE}\n\n{"new_string":"tail"}`;
    expect(latestValidJsonSnapshot(clamped)).toBeUndefined();
  });
});
