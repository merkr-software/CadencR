import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyBlockContentBudget,
  BLOCK_CONTENT_MAX_CHARS,
  clampJsonText,
  clampParsedJsonText,
  clampTailText,
  clampText,
  TRUNCATION_NOTICE,
} from "./block-content-budget";
import { promptImageSrc, resetPromptBlobCacheForTest } from "./prompt-image-cache";
import type { AgentBlockData } from "@/types/agent-block";
import { buildUserMessageContent, parseUserMessageContent } from "@/types/agent-types";

afterEach(() => resetPromptBlobCacheForTest());

function block(overrides: Partial<AgentBlockData> = {}): AgentBlockData {
  return { id: "b1", type: "text", content: "hello", ...overrides };
}

describe("clampText", () => {
  it("leaves values under the cap untouched, by reference", () => {
    const text = "a".repeat(100);
    const result = clampText(text, 200);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  it("keeps both ends and drops the middle", () => {
    const text = `${"H".repeat(500)}${"M".repeat(9000)}${"T".repeat(500)}`;
    const result = clampText(text, 1000);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("H")).toBe(true);
    expect(result.text.endsWith("T")).toBe(true);
    expect(result.text).toContain(TRUNCATION_NOTICE);
    // Head + tail + notice — bounded by the cap plus the notice itself.
    expect(result.text.length).toBeLessThan(1000 + 100);
  });

  it("reports the hidden character count on a first clamp", () => {
    const result = clampText("x".repeat(10_000), 1000);
    expect(result.text).toMatch(/characters hidden/);
  });

  it("omits a character count when re-clamping an already-clamped value", () => {
    const once = clampText("x".repeat(10_000), 1000).text;
    const twice = clampText(once + "y".repeat(10_000), 1000);
    expect(twice.text).toContain(TRUNCATION_NOTICE);
    expect(twice.text).not.toMatch(/characters hidden/);
  });

  it("never splits a surrogate pair", () => {
    // Each emoji is two UTF-16 code units; an odd cap lands mid-pair.
    const text = "😀".repeat(1000);
    const result = clampText(text, 501);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("clampJsonText", () => {
  it("preserves JSON structure by clamping string leaves", () => {
    const payload = JSON.stringify({
      command: "ls",
      output: "z".repeat(50_000),
      status: "ok",
    });
    const result = clampJsonText(payload, 4000);
    expect(result.truncated).toBe(true);
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed.command).toBe("ls");
    expect(parsed.status).toBe("ok");
    expect(String(parsed.output)).toContain(TRUNCATION_NOTICE);
  });

  it("clamps nested string leaves", () => {
    const payload = JSON.stringify({ edits: [{ new_string: "q".repeat(50_000) }] });
    const result = clampJsonText(payload, 4000);
    const parsed = JSON.parse(result.text) as { edits: Array<{ new_string: string }> };
    expect(parsed.edits[0].new_string).toContain(TRUNCATION_NOTICE);
  });

  it("reuses an already-parsed value when structurally clamping", () => {
    const payload = JSON.stringify({ content: "x".repeat(50_000) });
    const parsed: unknown = JSON.parse(payload);
    const parse = vi.spyOn(JSON, "parse");
    const result = clampParsedJsonText(payload, parsed, 4_000);
    const parseCalls = parse.mock.calls.length;
    parse.mockRestore();
    expect(parseCalls).toBe(0);
    expect(JSON.parse(result.text)).toEqual({
      content: expect.stringContaining(TRUNCATION_NOTICE),
    });
  });

  // Tool content accumulates as partial JSON fragments across a turn. A raw
  // clamp drops the notice — raw newlines and all — inside a string literal, so
  // the envelope never parses again: `latestValidJsonSnapshot` stops resolving
  // `toolArgs` and the tool renderers dump raw JSON at the user for the rest of
  // the turn. Observed live as a Bash block rendering its own envelope.
  it("leaves an unfinished JSON fragment alone rather than corrupting it", () => {
    const fragment = `{"command":"build","output":"${"z".repeat(50_000)}`;
    const result = clampJsonText(fragment, 4000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(fragment);
  });

  // A Codex Bash envelope repeats its whole output under both `aggregatedOutput`
  // and `output`. With one fixed leaf budget of max/2, those two leaves alone
  // overshot the cap, the structural clamp gave up, and the raw fallback spliced
  // a notice into a string literal — the envelope never parsed again and the
  // Bash block rendered its own raw JSON. Observed live, not hypothetical.
  it("shrinks the leaf budget until an envelope with several big leaves fits", () => {
    const payload = JSON.stringify({
      command: "seq 1 9000",
      cwd: "/repo",
      aggregatedOutput: "line of output\n".repeat(30_000),
      output: "line of output\n".repeat(30_000),
    });
    const result = clampJsonText(payload, 20_000);

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(20_000);
    const parsed = JSON.parse(result.text) as Record<string, string>;
    expect(parsed.command).toBe("seq 1 9000");
    expect(parsed.aggregatedOutput).toContain(TRUNCATION_NOTICE);
    expect(parsed.output).toContain(TRUNCATION_NOTICE);
  });

  it("clamps the same envelope structurally once it completes", () => {
    const complete = `{"command":"build","output":"${"z".repeat(50_000)}"}`;
    const result = clampJsonText(complete, 4000);
    expect(result.truncated).toBe(true);
    expect(() => JSON.parse(result.text)).not.toThrow();
    expect(result.text.length).toBeLessThanOrEqual(4000);
  });

  it("falls back to a raw clamp for non-JSON content", () => {
    const result = clampJsonText("not json ".repeat(5000), 1000);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(TRUNCATION_NOTICE);
    expect(() => JSON.parse(result.text)).toThrow();
  });

  it("falls back to a raw clamp when structure alone exceeds the cap", () => {
    // Thousands of tiny fields: no string leaf is over budget, but the
    // serialized object still is.
    const wide: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = "v";
    const result = clampJsonText(JSON.stringify(wide), 1000);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(1000 + 100);
  });
});

describe("applyBlockContentBudget", () => {
  it("returns the same reference when nothing is over budget", () => {
    const input = block();
    expect(applyBlockContentBudget(input, 1000)).toBe(input);
  });

  it("clamps oversized prose content and flags it", () => {
    const input = block({ content: "p".repeat(50_000) });
    const result = applyBlockContentBudget(input, 1000);
    expect(result).not.toBe(input);
    expect(result.truncatedContent).toBe(true);
    expect(result.content).toContain(TRUNCATION_NOTICE);
  });

  it("clamps tool_call args as JSON so the renderers keep parsing them", () => {
    const args = JSON.stringify({ file_path: "/tmp/a.ts", content: "c".repeat(50_000) });
    const input = block({ type: "tool_call", toolName: "Write", content: args, toolArgs: args });
    const result = applyBlockContentBudget(input, 4000);
    expect(result.truncatedContent).toBe(true);
    const parsed = JSON.parse(result.toolArgs ?? "") as Record<string, unknown>;
    expect(parsed.file_path).toBe("/tmp/a.ts");
  });

  // Regression: a 3.3 MB prompt-with-screenshot was raw-clamped as prose, which
  // spliced the notice into the middle of the envelope. It stopped parsing, so
  // `parseUserMessageContent` fell back to "render it as text" and the bubble
  // showed a wall of base64 instead of the image. Observed in production on the
  // "Polish Meeting Mode UX" conversation.
  it("keeps a screenshot prompt renderable instead of dumping its envelope", () => {
    const content = buildUserMessageContent("Please fix the alignment here", [
      { base64: "A".repeat(3_000_000), fileName: "shot.png", kind: "image", mimeType: "image/png" },
    ]);
    const input = block({ id: "msg-42", type: "user_message", content });

    const result = applyBlockContentBudget(input);

    expect(result.content.length).toBeLessThan(BLOCK_CONTENT_MAX_CHARS);
    expect(result.content).not.toContain(TRUNCATION_NOTICE);
    const parsed = parseUserMessageContent(result.content);
    expect(parsed.text).toBe("Please fix the alignment here");
    expect(parsed.images).toHaveLength(1);
    expect(promptImageSrc(parsed.images[0])).toMatch(/^blob:/);
  });

  // Off-loading a payload is not truncation — nothing was dropped, so the block
  // must not claim it was.
  it("does not flag an off-loaded prompt as truncated", () => {
    const content = buildUserMessageContent("small one", [
      { base64: "A".repeat(64), fileName: "a.png", kind: "image", mimeType: "image/png" },
    ]);
    const result = applyBlockContentBudget(block({ type: "user_message", content }));
    expect(result.truncatedContent).toBeUndefined();
  });

  it("clamps a genuinely huge text-only prompt, keeping the envelope parseable", () => {
    const content = JSON.stringify([{ type: "text", text: "w".repeat(500_000) }]);
    const result = applyBlockContentBudget(block({ type: "user_message", content }), 4000);

    expect(result.truncatedContent).toBe(true);
    expect(() => JSON.parse(result.content)).not.toThrow();
    expect(parseUserMessageContent(result.content).text).toContain(TRUNCATION_NOTICE);
  });

  it("reproduces the production worst case without retaining it", () => {
    // The largest single message in production: an 18.5 MB Bash tool_call.
    const huge = JSON.stringify({ command: "build", output: "x".repeat(18_500_000) });
    const input = block({ type: "tool_call", toolName: "Bash", content: huge, toolArgs: huge });
    const result = applyBlockContentBudget(input);
    expect(result.content.length).toBeLessThan(200_000);
    expect(result.toolArgs?.length).toBeLessThan(200_000);
    expect(result.truncatedContent).toBe(true);
  });
});

describe("clampTailText", () => {
  it("leaves values under the cap untouched", () => {
    const result = clampTailText("short", 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("short");
  });

  // The server tail-truncates the same field when it persists it
  // (`truncate_bash_output`), so a head-biased clamp would leave the live view
  // and the reloaded view showing different halves of one output.
  it("keeps only the tail, with the notice ahead of it", () => {
    const result = clampTailText(`${"H".repeat(9000)}TAIL`, 1000);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(result.text.endsWith("TAIL")).toBe(true);
    expect(result.text).not.toContain("H".repeat(2000));
  });

  it("never splits a surrogate pair", () => {
    const result = clampTailText("😀".repeat(1000), 501);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

// The live streaming paths clamp the concatenation on every delta, so the
// repeated-application behaviour is what actually ships.
describe("clamping repeatedly, as the streaming paths do", () => {
  it("stays bounded across many appends", () => {
    let acc = "";
    for (let i = 0; i < 500; i++) acc = clampText(acc + "chunk".repeat(100), 2000).text;
    expect(acc.length).toBeLessThan(2000 + 100);
  });

  it("keeps the head stable and advances the tail", () => {
    const head = "START".padEnd(2000, "-");
    const acc = clampText(clampText(head, 2000).text + "NEWEST", 2000).text;
    expect(acc.startsWith("START")).toBe(true);
    expect(acc.endsWith("NEWEST")).toBe(true);
  });

  it("keeps tail-clamped output bounded and advancing", () => {
    let acc = "";
    for (let i = 0; i < 200; i++) acc = clampTailText(acc + `line${i}\n`, 500).text;
    expect(acc.length).toBeLessThan(500 + 100);
    expect(acc.endsWith("line199\n")).toBe(true);
  });
});
