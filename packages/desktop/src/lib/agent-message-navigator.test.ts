import { describe, expect, it } from "vitest";
import type { SessionPrompt } from "@/api/generated";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import {
  adjacentMarkIndex,
  collectLoadedMarks,
  markIndexAtFraction,
  markIndexAtRow,
  mergeMarks,
  parseAgentMessageNavigator,
  promptListDrift,
  reuseMarksIfEqual,
} from "./agent-message-navigator";

function block(
  id: string,
  type: AgentBlockData["type"],
  content = "",
  extra: Partial<AgentBlockData> = {},
): DisplayItem {
  return { kind: "block", key: id, block: { id, type, content, ...extra } };
}

function prompt(id: number, preview: string): SessionPrompt {
  return { id, preview, image_count: 0, attachment_count: 0, created_at: null };
}

/** Loaded window: prompts 30 and 40 are paged in, 10 and 20 are older history. */
const ITEMS: DisplayItem[] = [
  block("a0", "text", "tail of an older turn"),
  block("msg-30", "user_message", "  Third\n  question ", { messageDbId: 30 }),
  block("a1", "text", "On it"),
  { kind: "flow", key: "flow:t1", blocks: [{ id: "t1", type: "tool_call", content: "" }] },
  block(
    "msg-40",
    "user_message",
    JSON.stringify([
      { type: "text", text: "Fourth" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]),
    { messageDbId: 40 },
  ),
  block("a2", "text", "Looks good"),
];

const PROMPTS = [prompt(10, "First"), prompt(20, "Second"), prompt(30, "Third question")];

describe("collectLoadedMarks", () => {
  it("lists loaded prompts with their row, collapsed text and parts", () => {
    const marks = collectLoadedMarks(ITEMS);
    expect(marks.map((m) => [m.key, m.rowIndex, m.text])).toEqual([
      ["db:30", 1, "Third question"],
      ["db:40", 4, "Fourth"],
    ]);
    expect(marks[1].imageCount).toBe(1);
  });

  it("skips messages written by another session or the system", () => {
    const generated = block("g", "user_message", "reply", {
      origin: { originKind: "session_generated" } as AgentBlockData["origin"],
    });
    const system = block("s", "user_message", "Plan approved", {
      origin: { originKind: "system_generated" } as AgentBlockData["origin"],
    });
    expect(collectLoadedMarks([generated, system])).toEqual([]);
  });
});

describe("mergeMarks", () => {
  it("lists every server prompt, placing loaded ones on their row", () => {
    const marks = mergeMarks(PROMPTS, collectLoadedMarks(ITEMS));
    expect(marks.map((m) => [m.key, m.rowIndex, m.blockId])).toEqual([
      ["db:10", null, null],
      ["db:20", null, null],
      ["db:30", 1, "msg-30"],
      // Persisted after the list was fetched: appended from the transcript.
      ["db:40", 4, "msg-40"],
    ]);
  });

  it("appends a live prompt that has no DB id yet", () => {
    const live = block("ws-user-1", "user_message", "Just sent");
    const marks = mergeMarks(PROMPTS, collectLoadedMarks([...ITEMS, live]));
    expect(marks.at(-1)).toMatchObject({ key: "ws-user-1", rowIndex: 6, text: "Just sent" });
  });

  it("falls back to the loaded prompts without a server list", () => {
    expect(mergeMarks(undefined, collectLoadedMarks(ITEMS)).map((m) => m.key)).toEqual([
      "db:30",
      "db:40",
    ]);
  });
});

describe("promptListDrift", () => {
  const loaded = collectLoadedMarks(ITEMS);

  it("flags a persisted prompt missing from the list", () => {
    expect(promptListDrift(PROMPTS, loaded)).toBe("40|");
  });

  it("flags a listed prompt newer than anything loaded (rewound away)", () => {
    expect(promptListDrift([...PROMPTS, prompt(40, "x"), prompt(50, "gone")], loaded)).toBe("|50");
  });

  it("is null when the list matches the transcript", () => {
    expect(promptListDrift([...PROMPTS, prompt(40, "Fourth")], loaded)).toBeNull();
    expect(promptListDrift(undefined, loaded)).toBeNull();
  });
});

describe("reuseMarksIfEqual", () => {
  it("keeps the previous identity when nothing a mark shows changed", () => {
    const first = collectLoadedMarks(ITEMS);
    const second = collectLoadedMarks([...ITEMS, block("a3", "text", "more")]);
    expect(reuseMarksIfEqual(first, second)).toBe(first);
  });

  it("adopts the new list when a prompt is added", () => {
    const first = collectLoadedMarks(ITEMS);
    const second = collectLoadedMarks([...ITEMS, block("u5", "user_message", "again")]);
    expect(reuseMarksIfEqual(first, second)).toBe(second);
  });
});

describe("mark lookup", () => {
  const marks = mergeMarks([...PROMPTS, prompt(40, "Fourth")], collectLoadedMarks(ITEMS));

  it("attributes rows above the first loaded prompt to the newest unloaded one", () => {
    expect(markIndexAtRow(marks, 0)).toBe(1);
    expect(markIndexAtRow(marks, 2)).toBe(2);
    expect(markIndexAtRow(marks, 5)).toBe(3);
  });

  it("walks back into unloaded history and forward through loaded rows", () => {
    expect(adjacentMarkIndex(marks, 1, -1)).toBe(1);
    expect(adjacentMarkIndex(marks, 1, 1)).toBe(3);
    expect(adjacentMarkIndex(marks, 4, 1)).toBe(-1);
  });

  it("places the gap after the server's first-prompt anchor between its rows", () => {
    // Row 0 is the session's first prompt, shipped ahead of the window; 20 and
    // 30 are unloaded; the window starts at row 1 with the tail of 30's turn.
    const anchored = mergeMarks(
      [prompt(10, "First"), prompt(20, "Second"), prompt(30, "Third"), prompt(40, "Fourth")],
      collectLoadedMarks([
        block("msg-10", "user_message", "First", { messageDbId: 10 }),
        block("a0", "text", "tail of the third turn"),
        block("msg-40", "user_message", "Fourth", { messageDbId: 40 }),
      ]),
    );
    expect(markIndexAtRow(anchored, 0)).toBe(0);
    expect(markIndexAtRow(anchored, 1)).toBe(2);
    expect(markIndexAtRow(anchored, 2)).toBe(3);
    expect(adjacentMarkIndex(anchored, 0, 1)).toBe(1);
    expect(adjacentMarkIndex(anchored, 2, -1)).toBe(2);
  });

  it("maps a rail position to a tick, clamped to the ends", () => {
    expect(markIndexAtFraction(0, 4)).toBe(0);
    expect(markIndexAtFraction(0.5, 4)).toBe(2);
    expect(markIndexAtFraction(1, 4)).toBe(3);
    expect(markIndexAtFraction(-2, 4)).toBe(0);
    expect(markIndexAtFraction(0.5, 0)).toBe(-1);
  });
});

describe("parseAgentMessageNavigator", () => {
  it("defaults to enabled and only an explicit false turns it off", () => {
    expect(parseAgentMessageNavigator(null)).toBe(true);
    expect(parseAgentMessageNavigator("true")).toBe(true);
    expect(parseAgentMessageNavigator("false")).toBe(false);
  });
});
