import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import {
  markPendingPromptsUnknown,
  markPromptDeliveryFailed,
  markPromptReceived,
  markPromptsReceived,
  movePendingPromptBlocksToTail,
  pendingPromptTailStartIndex,
  trimTailPromptTurnBoundary,
} from "./ws-pending-prompts";

const MESSAGE_UUID_1 = "a48cc11a-8a72-47f7-8577-d5c533d7909c";
const MESSAGE_UUID_2 = "293319b5-bf87-48a4-a454-cf9a452d3581";

function block(
  id: string,
  type: AgentBlockData["type"] = "text",
  pendingMessageUuid?: string,
): AgentBlockData {
  return {
    id,
    type,
    content: id,
    isError: false,
    ...(pendingMessageUuid
      ? {
          messageUuid: pendingMessageUuid,
          promptDeliveryState: "pending_agent" as const,
        }
      : {}),
  };
}

describe("pending prompt delivery ordering", () => {
  it("keeps pending steering prompts after stream blocks that arrive before replay", () => {
    const reordered = movePendingPromptBlocksToTail([
      block("assistant-1"),
      block("user-1", "user_message", MESSAGE_UUID_1),
      block("compact-divider", "compact_divider"),
    ]);

    expect(reordered.map((item) => item.id)).toEqual(["assistant-1", "compact-divider", "user-1"]);
    expect(reordered.at(-1)?.promptDeliveryState).toBe("pending_agent");
  });

  it("keeps canonical pending order stable when prompts are already tail-pinned", () => {
    const blocks = [
      block("assistant-1"),
      block("user-1", "user_message", MESSAGE_UUID_1),
      block("user-2", "user_message", MESSAGE_UUID_2),
    ];

    expect(movePendingPromptBlocksToTail(blocks)).toBe(blocks);
    expect(pendingPromptTailStartIndex(blocks)).toBe(1);
  });

  it("delivery receipts never reorder the persisted transcript", () => {
    const received = markPromptReceived(
      [
        block("assistant-1"),
        block("user-1", "user_message", MESSAGE_UUID_1),
        block("user-2", "user_message", MESSAGE_UUID_2),
      ],
      MESSAGE_UUID_1,
    );

    expect(received.map((item) => item.id)).toEqual(["assistant-1", "user-1", "user-2"]);
    expect(received[1].promptDeliveryState).toBe("received_agent");
    expect(received[2].promptDeliveryState).toBe("pending_agent");
  });

  it("matches a canonical message UUID and keeps its existing position", () => {
    const pending = {
      ...block("user-1", "user_message", MESSAGE_UUID_1),
      messageDbId: 20,
      messageUuid: MESSAGE_UUID_1,
    };
    const laterAgentBlock = { ...block("assistant-2"), messageDbId: 21 };

    const received = markPromptsReceived(
      [{ ...block("assistant-1"), messageDbId: 19 }, pending, laterAgentBlock],
      [MESSAGE_UUID_1],
    );

    expect(received.map((item) => item.id)).toEqual(["assistant-1", "user-1", "assistant-2"]);
    expect(received[1].promptDeliveryState).toBe("received_agent");
  });

  it("keeps the original array for a repeated receipt", () => {
    const received = markPromptReceived(
      [block("user-1", "user_message", MESSAGE_UUID_1)],
      MESSAGE_UUID_1,
    );

    expect(markPromptsReceived(received, [MESSAGE_UUID_1])).toBe(received);
  });

  it("turns unresolved terminal receipts into an explicit unknown state", () => {
    const unknown = markPendingPromptsUnknown([
      block("assistant-1"),
      block("user-1", "user_message", MESSAGE_UUID_1),
    ]);

    expect(unknown.map((item) => item.id)).toEqual(["assistant-1", "user-1"]);
    expect(unknown[1].promptDeliveryState).toBe("delivery_unknown");
  });

  it("marks a provider send failure without deleting the canonical message", () => {
    const pending = {
      ...block("msg-42", "user_message", MESSAGE_UUID_1),
      messageUuid: MESSAGE_UUID_1,
    };
    const failed = markPromptDeliveryFailed([pending], MESSAGE_UUID_1);

    expect(failed).toHaveLength(1);
    expect(failed[0].promptDeliveryState).toBe("delivery_failed");
  });

  it("identifies a tail prompt boundary for a received prompt", () => {
    const received = markPromptReceived(
      [block("user-1", "user_message", MESSAGE_UUID_1)],
      MESSAGE_UUID_1,
    );

    const trimmed = trimTailPromptTurnBoundary(received);
    const duplicate = trimTailPromptTurnBoundary(trimmed.blocks);

    expect(trimmed.shouldTrim).toBe(true);
    expect(duplicate.shouldTrim).toBe(true);
    expect(trimmed.blocks[0].promptDeliveryState).toBe("received_agent");
  });

  it("removes stale turn summaries after a pending tail prompt", () => {
    const trimmed = trimTailPromptTurnBoundary([block("user-1", "user_message", MESSAGE_UUID_1)]);
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
