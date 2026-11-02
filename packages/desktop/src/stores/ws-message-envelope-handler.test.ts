import { SessionTransportRegistry } from "./ws-session-transport";
import { describe, expect, it } from "vitest";
import { TRUNCATION_NOTICE } from "@/lib/block-content-budget";
import { handleMessageBatch } from "./ws-message-envelope-handler";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import type { StoreAccessors } from "./ws-envelope-types";

function createTestContext(session: SessionEntry): StoreAccessors {
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;
  return {
    get: () => state,
    set: (partial) => {
      state = { ...state, ...partial };
    },
    transport: new SessionTransportRegistry(),
    getSession: (sessionId) => state.sessions[sessionId],
  };
}

function streamEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { type: "stream_event", event };
}

describe("handleMessageBatch structured tool input", () => {
  it("does not clamp a large middle-of-string delta before reconstruction", () => {
    const ctx = createTestContext(createSessionEntry());
    const middle = "x".repeat(140_000);
    handleMessageBatch(ctx, "s1", [
      {
        blocks: [
          streamEvent({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tool-1", name: "Write", input: {} },
          }),
          streamEvent({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"file_path":"/tmp/large","content":"',
            },
          }),
          streamEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: middle },
          }),
          streamEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '"}' },
          }),
        ],
      },
    ]);

    const block = ctx.getSession("s1").blocks[0];
    const args = JSON.parse(block.toolArgs ?? "") as Record<string, unknown>;
    expect(args.file_path).toBe("/tmp/large");
    expect(String(args.content)).toContain(TRUNCATION_NOTICE);
    expect(String(args.content).startsWith("x")).toBe(true);
    expect(String(args.content).endsWith("x")).toBe(true);
  });
});
