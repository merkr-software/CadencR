import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/components/AgentBlock";
import {
  deferTailPromptTurnBoundary,
  markPromptReceived,
  movePendingPromptBlocksToTail,
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

  it("defers stale turn boundaries for a received tail prompt", () => {
    const received = markPromptReceived([block("user-1", "user_message", "client-1")], "client-1");

    const deferred = deferTailPromptTurnBoundary(received);
    const duplicate = deferTailPromptTurnBoundary(deferred.blocks);

    expect(deferred.shouldDefer).toBe(true);
    expect(duplicate.shouldDefer).toBe(true);
    expect(deferred.blocks[0].promptDeliveryState).toBe("received_agent");
  });

  it("removes stale turn summaries after a pending tail prompt", () => {
    const deferred = deferTailPromptTurnBoundary([block("user-1", "user_message", "client-1")]);
    const summaryDeferred = deferTailPromptTurnBoundary([
      ...deferred.blocks,
      { id: "summary-1", type: "turn_summary" as const, content: "1s" },
    ]);

    expect(deferred.shouldDefer).toBe(true);
    expect(summaryDeferred.shouldDefer).toBe(true);
    expect(summaryDeferred.blocks).toHaveLength(1);
    expect(summaryDeferred.blocks[0].promptDeliveryState).toBe("pending_agent");
  });
});
