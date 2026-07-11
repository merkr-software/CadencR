import { describe, it, expect, vi } from "vitest";
import { createStreamingState, processSdkMessage } from "./ws-message-processing";

describe("stream resilience — fault injection", () => {
  const streamEvent = (event: Record<string, unknown>): Record<string, unknown> => ({
    type: "stream_event",
    session_id: "thread",
    event,
  });

  it("self-heals an orphan delta whose content_block_start was never seen", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createStreamingState();
    // The start envelope for index 0 was lost. Dropping this delta would also
    // drop every following delta of the block — text stopping mid-message.
    const first = processSdkMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "recovered " },
      }),
      state,
    );
    expect(first.mutations).toHaveLength(1);
    expect(first.mutations[0].action).toBe("append");
    expect(first.mutations[0].block.type).toBe("text");
    expect(first.mutations[0].block.content).toBe("recovered ");

    // The next delta for the same index updates the synthesized block.
    const second = processSdkMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "tail" },
      }),
      state,
    );
    expect(second.mutations).toHaveLength(1);
    expect(second.mutations[0].action).toBe("update");
    expect(second.mutations[0].block.id).toBe(first.mutations[0].block.id);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("self-heals a persisted orphan thinking delta instead of updating a missing block", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createStreamingState();

    const first = processSdkMessage(
      {
        ...streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "visible summary" },
        }),
        agent_message_id: 77,
      },
      state,
    );

    expect(first.mutations).toHaveLength(1);
    expect(first.mutations[0].action).toBe("append");
    expect(first.mutations[0].block).toMatchObject({
      id: "msg-77",
      type: "thinking",
      content: "visible summary",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps the started block id when a later delta gains a persisted id", () => {
    const state = createStreamingState();
    const started = processSdkMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "visible" },
      }),
      state,
    );
    const startedBlockId = started.mutations[0].block.id;

    const delta = processSdkMessage(
      {
        ...streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: " summary" },
        }),
        agent_message_id: 77,
      },
      state,
    );

    expect(delta.mutations).toHaveLength(1);
    expect(delta.mutations[0]).toMatchObject({
      action: "update",
      block: { id: startedBlockId, type: "thinking", content: " summary" },
    });
    expect(delta.mutations[0].block.id).not.toBe("msg-77");
  });

  it("self-heals deltas that follow an unrenderable content_block_start", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createStreamingState();
    // A block type we can't render must not claim the index…
    const start = processSdkMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srv1", name: "web_search" },
      }),
      state,
    );
    expect(start.mutations).toHaveLength(0);

    // …so its deltas synthesize a renderable block instead of vanishing.
    const delta = processSdkMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":' },
      }),
      state,
    );
    expect(delta.mutations).toHaveLength(1);
    expect(delta.mutations[0].action).toBe("append");
    expect(delta.mutations[0].block.type).toBe("tool_call");
    warn.mockRestore();
  });

  it("drops an unknown delta type with a trace, without corrupting the stream", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createStreamingState();
    processSdkMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      state,
    );
    const unknown = processSdkMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "abc" },
      }),
      state,
    );
    expect(unknown.mutations).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "[agent-stream] dropping unknown content delta type",
      "signature_delta",
    );

    // A known delta for the same block still lands.
    const text = processSdkMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "still streaming" },
      }),
      state,
    );
    expect(text.mutations).toHaveLength(1);
    warn.mockRestore();
  });

  it("warns on unknown stream event and message types, but not on envelope markers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createStreamingState();

    processSdkMessage(streamEvent({ type: "some_future_event", foo: 1 }), state);
    expect(warn).toHaveBeenCalledWith(
      "[agent-stream] dropping unknown stream event type",
      "some_future_event",
    );

    processSdkMessage({ type: "some_future_message", session_id: "s" }, state);
    expect(warn).toHaveBeenCalledWith(
      "[agent-stream] dropping unknown message type",
      "some_future_message",
    );

    // Intentionally-ignored markers must stay silent — no warn spam per block.
    warn.mockClear();
    processSdkMessage(streamEvent({ type: "content_block_stop", index: 0 }), state);
    processSdkMessage(streamEvent({ type: "message_stop" }), state);
    processSdkMessage({ type: "result", session_id: "s" }, state);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
