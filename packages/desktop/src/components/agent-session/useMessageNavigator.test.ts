import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { rowsByBlockId } from "./useMessageNavigator";

function block(id: string, type: AgentBlockData["type"] = "tool_call"): AgentBlockData {
  return { id, type, content: "" };
}

describe("rowsByBlockId", () => {
  it("maps every step of a compact run to the run's row", () => {
    const items: DisplayItem[] = [
      { kind: "block", key: "prompt", block: block("prompt", "user_message") },
      { kind: "flow", key: "flow:a", blocks: [block("a"), block("b"), block("c")] },
      { kind: "block", key: "reply", block: block("reply", "text") },
    ];

    expect(Object.fromEntries(rowsByBlockId(items))).toEqual({
      prompt: 0,
      a: 1,
      b: 1,
      c: 1,
      reply: 2,
    });
  });
});
