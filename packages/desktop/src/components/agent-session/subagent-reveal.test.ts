import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { findSubagentRow } from "./subagent-reveal";

function block(id: string, extra: Partial<AgentBlockData> = {}): AgentBlockData {
  return { id, type: "tool_call", content: "", ...extra } as AgentBlockData;
}

describe("findSubagentRow", () => {
  const nested = block("child", { toolUseId: "toolu_child" });
  const items = [
    { kind: "block", key: "0", block: block("prompt", { type: "user_message" }) },
    { kind: "flow", key: "1", blocks: [block("read", { toolUseId: "toolu_read" })] },
    {
      kind: "block",
      key: "2",
      block: block("carrier", { toolUseId: "toolu_parent", childBlocks: [nested] }),
    },
  ] as unknown as DisplayItem[];

  it("finds a top-level carrier's own row", () => {
    expect(findSubagentRow(items, "toolu_parent")).toEqual({ rowIndex: 2, blockId: "carrier" });
  });

  it("finds a nested sub-agent through its root card", () => {
    expect(findSubagentRow(items, "toolu_child")).toEqual({ rowIndex: 2, blockId: "carrier" });
  });

  it("answers null for a card outside the loaded transcript", () => {
    expect(findSubagentRow(items, "toolu_gone")).toBeNull();
  });
});
