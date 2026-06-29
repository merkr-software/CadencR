import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/components/AgentBlock";
import {
  markPromptReceived,
  movePendingPromptBlocksToTail,
  stampPersistedMessageId,
  trimTailPromptTurnBoundary,
} from "./ws-pending-prompts";

function block(
  id: string,
  type: AgentBlockData["type"] = "text",
  pendingClientId?: string,
): AgentBlockData {
  return {
    id,
    type,
    content: id,
    isError: false,
    ...(pendingClientId
      ? {
          clientMessageId: pendingClientId,
          promptDeliveryState: "pending_agent" as const,
        }
      : {}),
  };
}

describe("pending prompt delivery ordering", () => {
  it("keeps unreceived steering messages at the conversation tail", () => {
    const pending = block("user-1", "user_message", "client-1");

    const reordered = movePendingPromptBlocksToTail([
      block("assistant-1"),
      pending,
      block("tool-1", "tool_call"),
      block("assistant-2"),
    ]);

    expect(reordered.map((item) => item.id)).toEqual([
      "assistant-1",
      "tool-1",
      "assistant-2",
      "user-1",
    ]);
  });

  it("only tail-pins steering messages that have not been received yet", () => {
    const received = markPromptReceived(
      [
        block("assistant-1"),
        block("user-1", "user_message", "client-1"),
        block("user-2", "user_message", "client-2"),
      ],
      "client-1",
    );

    const reordered = movePendingPromptBlocksToTail([...received, block("assistant-2")]);

    expect(reordered.map((item) => item.id)).toEqual([
      "assistant-1",
      "user-1",
      "assistant-2",
      "user-2",
    ]);
    expect(reordered[1].promptDeliveryState).toBe("received_agent");
    expect(reordered[3].promptDeliveryState).toBe("pending_agent");
  });

  it("identifies a tail prompt boundary for a received prompt", () => {
    const received = markPromptReceived([block("user-1", "user_message", "client-1")], "client-1");

    const trimmed = trimTailPromptTurnBoundary(received);
    const duplicate = trimTailPromptTurnBoundary(trimmed.blocks);

    expect(trimmed.shouldTrim).toBe(true);
    expect(duplicate.shouldTrim).toBe(true);
    expect(trimmed.blocks[0].promptDeliveryState).toBe("received_agent");
  });

  it("stamps the persisted DB id on the matching live block without touching its id", () => {
    const stamped = stampPersistedMessageId(
      [block("assistant-1"), block("ws-user-1", "user_message", "client-1")],
      "client-1",
      42,
    );

    expect(stamped[1].messageDbId).toBe(42);
    expect(stamped[1].id).toBe("ws-user-1"); // id/key unchanged → no Virtuoso remount
    expect(stamped[1].clientMessageId).toBe("client-1"); // still matchable by prompt_received
  });

  it("returns the same array when no block matches the client id", () => {
    const blocks = [block("ws-user-1", "user_message", "client-1")];
    expect(stampPersistedMessageId(blocks, "client-unknown", 7)).toBe(blocks);
  });

  it("removes stale turn summaries after a pending tail prompt", () => {
    const trimmed = trimTailPromptTurnBoundary([block("user-1", "user_message", "client-1")]);
    const summaryTrimmed = trimTailPromptTurnBoundary([
      ...trimmed.blocks,
      { id: "summary-1", type: "turn_summary" as const, content: "1s" },
    ]);

    expect(trimmed.shouldTrim).toBe(true);
    expect(summaryTrimmed.shouldTrim).toBe(true);
    expect(summaryTrimmed.blocks).toHaveLength(1);
    expect(summaryTrimmed.blocks[0].promptDeliveryState).toBe("pending_agent");
  });
});
