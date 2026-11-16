import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { mergeCanonicalBlocks } from "./ws-user-message-reconciliation";

function result(id: string, parentToolUseId: string | null = null): AgentBlockData {
  return {
    id,
    type: "tool_result",
    toolUseId: "tool",
    parentToolUseId,
    content: "preview",
    truncatedContent: true,
  };
}

describe("legacy live tool identity recovery", () => {
  it("repairs a temporary id without duplicating or replacing its live content", () => {
    const live = result("ws-1");
    const merged = mergeCanonicalBlocks(
      [live],
      [{ ...result("msg-42"), content: "different preview" }],
    );
    expect(merged).toEqual([{ ...live, messageDbId: 42 }]);
    expect(live.messageDbId).toBeUndefined();
  });

  it("recovers nested identities through the parent tool call", () => {
    const parent: AgentBlockData = {
      id: "ws-parent",
      type: "tool_call",
      toolUseId: "parent",
      content: "{}",
      childBlocks: [result("ws-child", "parent")],
    };
    const incoming = { ...parent, id: "msg-41", childBlocks: [result("msg-42", "parent")] };
    const merged = mergeCanonicalBlocks([parent], [incoming]);
    expect(merged).toHaveLength(1);
    expect(merged[0].messageDbId).toBe(41);
    expect(merged[0].childBlocks).toEqual([{ ...result("ws-child", "parent"), messageDbId: 42 }]);
  });

  it("does not guess across parents, multiple results, or conflicting persisted ids", () => {
    const live = result("ws-1");
    expect(mergeCanonicalBlocks([live], [result("msg-42", "other")])[0]).toBe(live);
    expect(mergeCanonicalBlocks([live], [result("msg-42"), result("msg-43")])[0]).toBe(live);
    const duplicate = result("ws-2");
    expect(mergeCanonicalBlocks([live, duplicate], [result("msg-42")]).slice(0, 2)).toEqual([
      live,
      duplicate,
    ]);
    const identified = { ...live, messageDbId: 20 };
    expect(mergeCanonicalBlocks([identified], [result("msg-42")])[0]).toBe(identified);
  });
});
