import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { buildToolResultMap, toolResultOf } from "./tool-results";

const call: AgentBlockData = {
  id: "c1",
  type: "tool_call",
  content: "",
  toolName: "Bash",
  toolUseId: "tu-1",
};
const result: AgentBlockData = {
  id: "r1",
  type: "tool_result",
  content: "out",
  toolUseId: "tu-1",
  sourceToolName: "Bash",
};

describe("buildToolResultMap", () => {
  it("builds a map of toolUseId to tool_result blocks", () => {
    const map = buildToolResultMap([call, result, { id: "t1", type: "text", content: "hello" }]);
    expect(map.size).toBe(1);
    expect(map.get("tu-1")?.content).toBe("out");
  });

  it("returns empty map when no tool_results exist", () => {
    expect(buildToolResultMap([{ id: "t1", type: "text", content: "hi" }]).size).toBe(0);
  });
});

describe("toolResultOf", () => {
  it("finds a call's result, and none for a block without a call id", () => {
    const map = buildToolResultMap([result]);
    expect(toolResultOf(map, call)).toBe(result);
    expect(toolResultOf(map, { id: "t1", type: "thinking", content: "" })).toBeUndefined();
    expect(toolResultOf(undefined, call)).toBeUndefined();
  });
});
