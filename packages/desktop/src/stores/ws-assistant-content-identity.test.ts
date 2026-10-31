import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import {
  applyMutations,
  blocksPatchWithDerived,
  createStreamingState,
  processSdkMessage,
  type BlockMutation,
} from "./ws-message-processing";
import { blockMessageDbId } from "./ws-message-identity";
import { mergeCanonicalBlocks } from "./ws-user-message-reconciliation";

function harness() {
  const state = createStreamingState();
  let blocks: AgentBlockData[] = [];
  const send = (message: Record<string, unknown>): void => {
    blocks = applyMutations(blocks, processSdkMessage(message, state).mutations, state);
  };
  const batch = (messages: Array<Record<string, unknown>>): void => {
    const mutations = messages.flatMap((message) => processSdkMessage(message, state).mutations);
    blocks = applyMutations(blocks, mutations, state);
  };
  const stream = (
    event: Record<string, unknown>,
    parent: string | null = null,
    session = "runtime",
  ): void => {
    send({ type: "stream_event", session_id: session, parent_tool_use_id: parent, event });
  };
  const start = (
    text: string,
    index = 0,
    parent: string | null = null,
    session = "runtime",
  ): void => {
    stream({ type: "message_start", message: {} }, parent, session);
    stream(
      { type: "content_block_start", index, content_block: { type: "text", text } },
      parent,
      session,
    );
  };
  const assistant = (
    content: Array<Record<string, unknown>>,
    parent: string | null = null,
    session = "runtime",
  ): void => {
    send({
      type: "assistant",
      session_id: session,
      parent_tool_use_id: parent,
      message: { content },
    });
  };
  return { state, send, batch, stream, start, assistant, blocks: () => blocks };
}

describe("repaired assistant content identity", () => {
  it("protects queued root and nested identities across many claims in one repair batch", () => {
    const state = createStreamingState();
    const task: AgentBlockData = {
      id: "task",
      type: "tool_call",
      toolName: "Task",
      toolUseId: "task",
      content: "",
      childBlocks: [
        {
          id: "known-child",
          type: "text",
          content: "saved",
          messageDbId: 400,
          parentToolUseId: "task",
        },
      ],
    };
    const existing: AgentBlockData[] = [
      task,
      { id: "replacement", type: "text", content: "short" },
    ];
    blocksPatchWithDerived(state, existing);
    const append = (id: string, parentToolUseId?: string): BlockMutation => ({
      action: "append",
      block: { id, type: "text", content: id, parentToolUseId },
    });
    const identify = (id: string, messageDbId: number): BlockMutation => ({
      action: "identify",
      block: { id, type: "text", content: "", messageDbId },
    });
    const mutations: BlockMutation[] = [
      ...["a", "b", "c", "d", "reserved", "staged-collision"].map((id) => append(id)),
      append("child", "task"),
      identify("a", 500),
      identify("b", 500),
      identify("child", 501),
      identify("c", 501),
      identify("d", 400),
      identify("reserved", 502),
      identify("staged-collision", 503),
      {
        action: "append",
        block: { id: "replacement", type: "text", content: "longer replacement", messageDbId: 502 },
      },
      {
        action: "append",
        block: { id: "staged-owner", type: "text", content: "already saved", messageDbId: 503 },
      },
      { action: "identify", block: { id: "b", type: "thinking", content: "", messageDbId: 504 } },
    ];
    const result = applyMutations(existing, mutations, state);
    const roots = new Map(result.map((block) => [block.id, block]));
    expect(blockMessageDbId(roots.get("a")!)).toBe(500);
    for (const id of ["b", "c", "d", "reserved", "staged-collision"])
      expect(blockMessageDbId(roots.get(id)!)).toBeNull();
    expect(roots.get("task")?.childBlocks?.map(blockMessageDbId)).toEqual([400, 501]);
    expect(blockMessageDbId(roots.get("replacement")!)).toBe(502);
    expect(blockMessageDbId(roots.get("staged-owner")!)).toBe(503);
  });

  it("adopts an identity when live start and repaired snapshot share a message batch", () => {
    const h = harness();
    h.batch([
      {
        type: "stream_event",
        session_id: "runtime",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "batched" },
        },
      },
      {
        type: "assistant",
        session_id: "runtime",
        message: { content: [{ type: "text", text: "batched", agent_message_id: 51 }] },
      },
    ]);
    expect(h.blocks()).toHaveLength(1);
    expect(h.blocks()[0]).toMatchObject({ content: "batched", messageDbId: 51 });
  });

  it("does not assign one durable row to two different live blocks in a batch", () => {
    const h = harness();
    h.batch(
      ["a", "b"].flatMap((session_id) => [
        {
          type: "stream_event",
          session_id,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: session_id },
          },
        },
        {
          type: "assistant",
          session_id,
          message: { content: [{ type: "text", text: session_id, agent_message_id: 52 }] },
        },
      ]),
    );
    expect(h.blocks()).toHaveLength(2);
    expect(h.blocks().map(blockMessageDbId)).toEqual([52, null]);
  });

  it("adopts the repaired row after an initial insert failure so canonical resync deduplicates", () => {
    const h = harness();
    h.start("hello"); // Failed backend insert: no agent_message_id on live start.
    const liveId = h.blocks()[0].id;
    h.stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    });
    h.stream({ type: "content_block_stop", index: 0 });
    h.assistant([{ type: "text", text: "hello world", agent_message_id: 42 }]);
    expect(h.blocks()).toHaveLength(1);
    expect(h.blocks()[0]).toMatchObject({ id: liveId, messageDbId: 42, content: "hello world" });
    expect(h.state.rootBlocks[0]).toBe(h.blocks()[0]);
    const merged = mergeCanonicalBlocks(h.blocks(), [
      { id: "msg-42", type: "text", content: "hello world", messageDbId: 42 },
    ]);
    expect(merged).toHaveLength(1);
    // A late delta still routes to the existing live key after identity adoption.
    h.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } });
    expect(h.blocks()[0].content).toBe("hello world!");
  });

  it("keeps interleaved runtime and nested parent scopes separate", () => {
    const h = harness();
    for (const parent of ["a", "b"]) {
      h.stream({
        type: "content_block_start",
        index: parent === "a" ? 8 : 9,
        content_block: { type: "tool_use", id: parent, name: "Task", input: {} },
      });
    }
    h.start("child A", 0, "a");
    h.start("child B", 0, "b");
    h.start("root", 0, null, "other-runtime");
    h.assistant([{ type: "text", text: "child A", agent_message_id: 101 }], "a");
    h.assistant([{ type: "text", text: "child B", agent_message_id: 102 }], "b");
    h.assistant([{ type: "text", text: "root", agent_message_id: 103 }], null, "other-runtime");
    expect(h.blocks()).toHaveLength(3);
    expect(h.blocks()[0].childBlocks).toHaveLength(1);
    expect(h.blocks()[1].childBlocks).toHaveLength(1);
    expect(h.blocks()[0].childBlocks?.[0]).toMatchObject({ content: "child A", messageDbId: 101 });
    expect(h.blocks()[1].childBlocks?.[0]).toMatchObject({ content: "child B", messageDbId: 102 });
    expect(h.blocks()[2]).toMatchObject({ content: "root", messageDbId: 103 });
  });

  it("resets recovered content indices for each message cycle", () => {
    const h = harness();
    h.start("first");
    h.assistant([{ type: "text", text: "first", agent_message_id: 11 }]);
    h.start("second");
    h.assistant([{ type: "text", text: "second", agent_message_id: 12 }]);
    expect(h.blocks().map(blockMessageDbId)).toEqual([11, 12]);
    h.assistant([{ type: "text", text: "second", agent_message_id: 12 }]);
    expect(h.blocks()).toHaveLength(2);
  });

  it("rejects duplicate, conflicting, mismatched and invalid identities", () => {
    const h = harness();
    h.start("first");
    h.stream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "reason" },
    });
    h.assistant([
      { type: "text", text: "first", agent_message_id: 4 },
      { type: "thinking", thinking: "reason", agent_message_id: 4 },
    ]);
    expect(h.blocks().map(blockMessageDbId)).toEqual([null, null]);
    h.assistant([{ type: "thinking", thinking: "wrong type", agent_message_id: 5 }]);
    h.assistant([{ type: "text", text: "first", agent_message_id: -1 }]);
    expect(h.blocks().map(blockMessageDbId)).toEqual([null, null]);
    h.assistant([
      { type: "text", text: "first", agent_message_id: 6 },
      { type: "thinking", thinking: "reason", agent_message_id: 7 },
    ]);
    h.assistant([
      { type: "text", text: "first", agent_message_id: 7 },
      { type: "thinking", thinking: "reason", agent_message_id: 6 },
    ]);
    expect(h.blocks().map(blockMessageDbId)).toEqual([6, 7]);
    expect(h.blocks().map((block) => block.content)).toEqual(["first", "reason"]);
  });
});
