import { SessionTransportRegistry } from "./ws-session-transport";
import { describe, expect, it } from "vitest";

import { handleEnvelope, type StoreAccessors } from "./ws-envelope-handler";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";

function createTestContext(session: SessionEntry): StoreAccessors {
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;

  return {
    get: (): WsSessionStore => state,
    set: (partial: Partial<WsSessionStore>): void => {
      state = { ...state, ...partial };
    },
    transport: new SessionTransportRegistry(),
    getSession: (sessionId: string): SessionEntry => state.sessions[sessionId],
  };
}

function sendTranscriptBlock(ctx: StoreAccessors, payload: unknown): void {
  handleEnvelope(ctx, "s1", { domain: "session", action: "transcript_block", payload });
}

const summary = {
  session_id: "7",
  block: {
    id: "msg-42",
    type: "turn_summary",
    content: '{"totalMs":3000,"waitingMs":0,"agentMs":3000,"models":["opus"]}',
    createdAt: "2026-11-01 12:00:00",
  },
};

describe("handleEnvelope session.transcript_block", () => {
  it("appends the persisted row under the id history returns it with", () => {
    const session = { ...createSessionEntry(), sessionDbId: 7 };
    const ctx = createTestContext(session);

    sendTranscriptBlock(ctx, summary);

    const block = ctx.getSession("s1").blocks.at(-1);
    expect(block).toMatchObject({ id: "msg-42", type: "turn_summary", messageDbId: 42 });
  });

  it("ignores a row already in the transcript or meant for another session", () => {
    const session = { ...createSessionEntry(), sessionDbId: 7 };
    const ctx = createTestContext(session);

    sendTranscriptBlock(ctx, summary);
    sendTranscriptBlock(ctx, summary);
    sendTranscriptBlock(ctx, { ...summary, session_id: "8", block: { ...summary.block, id: "x" } });

    expect(ctx.getSession("s1").blocks).toHaveLength(1);
  });

  it("ignores rows until the conversation knows its own id", () => {
    const ctx = createTestContext(createSessionEntry());

    sendTranscriptBlock(ctx, summary);

    expect(ctx.getSession("s1").blocks).toHaveLength(0);
  });

  it("surfaces a malformed event instead of dropping it silently", () => {
    const ctx = createTestContext(createSessionEntry());

    sendTranscriptBlock(ctx, { session_id: "7", block: { id: "msg-1", type: "bogus" } });

    expect(ctx.getSession("s1").blocks.at(-1)).toMatchObject({
      type: "error",
      errorCode: "MALFORMED_TRANSCRIPT_BLOCK",
    });
  });
});
