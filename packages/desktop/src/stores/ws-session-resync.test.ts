import { SessionTransportRegistry } from "./ws-session-transport";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import { repairPersistedBlocksAfterTurn, resyncMessagesOnReconnect } from "./ws-session-resync";
import type { StoreAccessors } from "./ws-envelope-handler";

const apiMocks = vi.hoisted(() => ({
  getFeatureAgentState: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  getFeatureAgentState: apiMocks.getFeatureAgentState,
  getListFeatureSubagentsQueryKey: (featureId: number) => [`/api/features/${featureId}/subagents`],
}));

vi.mock("@/hooks/useFeatureAgentState", () => ({
  serverBlocksToAgentBlocks: (blocks: AgentBlockData[]) => blocks,
}));

function makeBlock(id: string, content: string): AgentBlockData {
  return { id, type: "text", content };
}

function createCtx(session: SessionEntry): StoreAccessors {
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;
  return {
    get: () => state,
    set: (partial: Partial<WsSessionStore>) => {
      state = { ...state, ...partial } as WsSessionStore;
    },
    transport: new SessionTransportRegistry(),
    getSession: (sessionId: string) => state.sessions[sessionId],
  };
}

function createSession(
  blocks: AgentBlockData[],
  lastAppliedMessageId: number | null,
): SessionEntry {
  return {
    ...createSessionEntry(),
    blocks,
    featureId: 1077,
    sessionDbId: 2586,
    lastAppliedMessageId,
    lastAppliedContentRevision: 7,
  };
}

const afterCursor = (cursor: number, revision = 0) => ({
  after: JSON.stringify({ 2586: cursor }),
  after_revisions: JSON.stringify({ 2586: revision }),
});

describe("resyncMessagesOnReconnect", () => {
  beforeEach(() => {
    apiMocks.getFeatureAgentState.mockReset();
  });

  it("appends messages that streamed while the socket was disconnected", async () => {
    const ctx = createCtx(createSession([makeBlock("msg-10", "before sleep")], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [makeBlock("msg-11", "during sleep"), makeBlock("msg-12", "more")],
          maxMessageId: 12,
        },
      ],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    const session = ctx.get().sessions.s1;
    expect(session.blocks.map((b) => b.id)).toEqual(["msg-10", "msg-11", "msg-12"]);
    expect(session.lastAppliedMessageId).toBe(12);
    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077, afterCursor(10, 7));
  });

  it("drops the stale reconnect notice once the server reports a restart", async () => {
    const notice: AgentBlockData = {
      id: "ws-err-close-1",
      type: "error",
      content: "Connection lost while streaming. Reconnecting…",
      errorCode: "WS_RECONNECTING",
    };
    const ctx = createCtx(createSession([makeBlock("msg-10", "working"), notice], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [{ id: "msg-11", type: "turn_interrupted", content: "restart" }],
          maxMessageId: 11,
        },
      ],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    expect(ctx.get().sessions.s1.blocks.map((b) => b.id)).toEqual(["msg-10", "msg-11"]);
  });

  it("keeps the reconnect notice when the catch-up says nothing about a restart", async () => {
    const notice: AgentBlockData = {
      id: "ws-err-close-1",
      type: "error",
      content: "Connection lost while streaming. Reconnecting…",
      errorCode: "WS_RECONNECTING",
    };
    const ctx = createCtx(createSession([makeBlock("msg-10", "working"), notice], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [{ id: "msg-11", type: "turn_interrupted", content: "" }],
          maxMessageId: 11,
        },
      ],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    expect(ctx.get().sessions.s1.blocks.map((b) => b.id)).toContain("ws-err-close-1");
  });

  it("de-dupes messages already received live while using the snapshot cursor", async () => {
    // A live message is present, but only the completed snapshot cursor is a
    // safe assertion that every preceding row was received.
    const ctx = createCtx(
      createSession([makeBlock("msg-10", "a"), makeBlock("msg-11", "live")], 10),
    );
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [{ sessionDbId: 2586, blocks: [makeBlock("msg-11", "live")], maxMessageId: 11 }],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    const session = ctx.get().sessions.s1;
    expect(session.blocks.map((b) => b.id)).toEqual(["msg-10", "msg-11"]);
    expect(session.lastAppliedMessageId).toBe(11);
    // The overlapping fetch is reconciled rather than skipped.
    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077, afterCursor(10, 7));
  });

  it("does not treat an explicitly stamped live DB id as a gap-free cursor", async () => {
    const liveUser: AgentBlockData = {
      id: "legacy-local-user-1",
      type: "user_message",
      content: "live",
      messageDbId: 11,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
    };
    const ctx = createCtx(createSession([makeBlock("msg-10", "a"), liveUser], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [{ sessionDbId: 2586, blocks: [], maxMessageId: 11 }],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077, afterCursor(10, 7));
  });

  it("recovers an earlier dropped row even after a later canonical event arrived", async () => {
    const liveUser: AgentBlockData = {
      id: "msg-12",
      type: "user_message",
      content: "later live message",
      messageDbId: 12,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
    };
    const ctx = createCtx(createSession([makeBlock("msg-10", "snapshot"), liveUser], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [makeBlock("msg-11", "dropped"), { ...liveUser }],
          maxMessageId: 12,
        },
      ],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    const session = ctx.get().sessions.s1;
    expect(session.blocks.map((block) => block.id)).toEqual(["msg-10", "msg-11", "msg-12"]);
    expect(session.lastAppliedMessageId).toBe(12);
    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077, afterCursor(10, 7));
  });

  it("reconciles the former ws-user id with its canonical persisted clone", async () => {
    const messageUuid = "a48cc11a-8a72-47f7-8577-d5c533d7909c";
    const liveUser: AgentBlockData = {
      id: "legacy-local-user-1",
      type: "user_message",
      content: "live",
      messageUuid,
    };
    const ctx = createCtx(createSession([makeBlock("msg-10", "a"), liveUser], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [
            {
              id: "msg-11",
              type: "user_message",
              content: "live",
              messageDbId: 11,
              messageUuid,
            },
          ],
          maxMessageId: 11,
        },
      ],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    const users = ctx.get().sessions.s1.blocks.filter((block) => block.type === "user_message");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: "msg-11", messageDbId: 11, messageUuid });
  });

  it("reconciles a slept pending prompt from persisted delivery state", async () => {
    const pending: AgentBlockData = {
      id: "msg-11",
      type: "user_message",
      content: "steer before sleep",
      messageDbId: 11,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      promptDeliveryState: "pending_agent",
    };
    const ctx = createCtx(createSession([pending], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          status: "completed",
          blocks: [{ ...pending, promptDeliveryState: "delivery_unknown" }],
          maxMessageId: 11,
        },
      ],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    expect(ctx.get().sessions.s1.blocks[0].promptDeliveryState).toBe("delivery_unknown");
    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077, afterCursor(10, 7));
  });

  it("coalesces concurrent reconnect and gap resyncs", async () => {
    const ctx = createCtx(createSession([makeBlock("msg-10", "before")], 10));
    let resolveRequest: ((value: unknown) => void) | undefined;
    apiMocks.getFeatureAgentState.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const first = resyncMessagesOnReconnect(ctx, "s1");
    const second = resyncMessagesOnReconnect(ctx, "s1");
    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledTimes(1);
    resolveRequest?.({
      sessions: [{ sessionDbId: 2586, blocks: [], maxMessageId: 10 }],
    });
    await Promise.all([first, second]);
  });

  it("applies a late tool-call revision even when no new message row exists", async () => {
    const tool: AgentBlockData = {
      id: "msg-9",
      type: "tool_call",
      content: '{"path":"before"}',
      toolArgs: '{"path":"before"}',
      toolName: "Read",
    };
    const ctx = createCtx(createSession([tool, makeBlock("msg-10", "done")], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [],
          maxMessageId: 10,
          maxContentRevision: 8,
          toolCallUpdates: { "msg-9": '{"path":"after"}' },
          truncatedToolCallUpdateIds: ["msg-9"],
        },
      ],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    expect(ctx.get().sessions.s1.blocks[0]).toMatchObject({
      content: '{"path":"after"}',
      toolArgs: '{"path":"after"}',
      truncatedContent: true,
    });
    expect(ctx.get().sessions.s1.lastAppliedContentRevision).toBe(8);
    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077, afterCursor(10, 7));
  });

  it("maps a persisted tool revision onto a live block id via messageDbId", async () => {
    const tool: AgentBlockData = {
      id: "live-tool-call",
      messageDbId: 9,
      type: "tool_call",
      content: "{}",
    };
    const ctx = createCtx(createSession([tool], 10));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [],
          maxMessageId: 10,
          maxContentRevision: 8,
          toolCallUpdates: { "msg-9": '{"path":"after"}' },
          truncatedToolCallUpdateIds: ["msg-9"],
        },
      ],
    });

    await resyncMessagesOnReconnect(ctx, "s1");

    expect(ctx.get().sessions.s1.blocks[0]).toMatchObject({
      id: "live-tool-call",
      content: '{"path":"after"}',
      truncatedContent: true,
    });
  });

  it("drains bounded incremental message pages while the cursor progresses", async () => {
    const ctx = createCtx(createSession([makeBlock("msg-10", "before")], 10));
    const publish = vi.spyOn(ctx, "set");
    apiMocks.getFeatureAgentState
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionDbId: 2586,
            blocks: [makeBlock("msg-11", "page one")],
            maxMessageId: 11,
            maxContentRevision: 7,
            hasMoreIncrementalMessages: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionDbId: 2586,
            blocks: [makeBlock("msg-12", "page two")],
            maxMessageId: 12,
            maxContentRevision: 7,
            hasMoreIncrementalMessages: false,
          },
        ],
      });

    await resyncMessagesOnReconnect(ctx, "s1");

    expect(ctx.get().sessions.s1.blocks.map((block) => block.id)).toEqual([
      "msg-10",
      "msg-11",
      "msg-12",
    ]);
    expect(apiMocks.getFeatureAgentState).toHaveBeenNthCalledWith(1, 1077, afterCursor(10, 7));
    expect(apiMocks.getFeatureAgentState).toHaveBeenNthCalledWith(2, 1077, afterCursor(11, 7));
    expect(publish).toHaveBeenCalledOnce();
  });

  it("continues past a bounded pending-prompt overlap without skipping new rows", async () => {
    const pending: AgentBlockData = {
      id: "msg-20",
      messageDbId: 20,
      type: "user_message",
      content: "pending",
      promptDeliveryState: "pending_agent",
    };
    const ctx = createCtx(createSession([pending, makeBlock("msg-100", "confirmed")], 100));
    const publish = vi.spyOn(ctx, "set");
    const page = (start: number, end: number, hasMore: boolean) => ({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: Array.from({ length: end - start + 1 }, (_, index) =>
            makeBlock(`msg-${start + index}`, `row ${start + index}`),
          ),
          maxMessageId: end,
          maxContentRevision: 7,
          hasMoreIncrementalMessages: hasMore,
        },
      ],
    });
    apiMocks.getFeatureAgentState
      .mockResolvedValueOnce(page(20, 59, true))
      .mockResolvedValueOnce(page(60, 99, true))
      .mockResolvedValueOnce(page(100, 139, true))
      .mockResolvedValueOnce(page(140, 141, false));

    await resyncMessagesOnReconnect(ctx, "s1");

    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledTimes(4);
    expect(apiMocks.getFeatureAgentState).toHaveBeenNthCalledWith(1, 1077, afterCursor(19, 7));
    expect(apiMocks.getFeatureAgentState).toHaveBeenNthCalledWith(2, 1077, afterCursor(59, 7));
    expect(apiMocks.getFeatureAgentState).toHaveBeenNthCalledWith(3, 1077, afterCursor(99, 7));
    expect(apiMocks.getFeatureAgentState).toHaveBeenNthCalledWith(4, 1077, afterCursor(139, 7));
    expect(ctx.get().sessions.s1.lastAppliedMessageId).toBe(141);
    expect(ctx.get().sessions.s1.blocks.some((block) => block.id === "msg-141")).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("grafts every child when bounded reconnect pages split a persisted task subtree", async () => {
    const parent: AgentBlockData = {
      id: "msg-10",
      messageDbId: 10,
      type: "tool_call",
      toolUseId: "task-1",
      content: "live parent",
      childBlocks: [],
    };
    const pending: AgentBlockData = {
      id: "msg-20",
      messageDbId: 20,
      type: "user_message",
      content: "pending",
      promptDeliveryState: "pending_agent",
    };
    const ctx = createCtx(createSession([parent, pending, makeBlock("msg-100", "confirmed")], 100));
    const parentPage = (start: number, end: number, hasMore: boolean) => ({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [
            {
              ...parent,
              content: "persisted parent",
              childBlocks: Array.from({ length: end - start + 1 }, (_, index) =>
                makeBlock(`msg-${start + index}`, `child ${start + index}`),
              ),
            },
          ],
          maxMessageId: end,
          maxContentRevision: 7,
          hasMoreIncrementalMessages: hasMore,
        },
      ],
    });
    apiMocks.getFeatureAgentState
      .mockResolvedValueOnce(parentPage(20, 59, true))
      .mockResolvedValueOnce(parentPage(60, 99, true))
      .mockResolvedValueOnce(parentPage(100, 104, false));

    await resyncMessagesOnReconnect(ctx, "s1");

    const restoredParent = ctx.get().sessions.s1.blocks.find((block) => block.id === "msg-10");
    expect(restoredParent?.content).toBe("live parent");
    expect(restoredParent?.childBlocks).toHaveLength(85);
    expect(new Set(restoredParent?.childBlocks?.map((child) => child.id)).size).toBe(85);
  });

  it("hydrates from a full snapshot before the initial cursor exists", async () => {
    const ctx = createCtx(createSession([], null));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [{ sessionDbId: 2586, blocks: [makeBlock("msg-1", "restored")], maxMessageId: 1 }],
    });
    await resyncMessagesOnReconnect(ctx, "s1");
    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077);
    expect(ctx.get().sessions.s1.blocks.map((block) => block.id)).toEqual(["msg-1"]);
  });
});

describe("repairPersistedBlocksAfterTurn", () => {
  beforeEach(() => {
    apiMocks.getFeatureAgentState.mockReset();
  });

  function taskWithChildren(childIds: string[]): AgentBlockData {
    return {
      ...makeBlock("msg-1", ""),
      type: "tool_call",
      childBlocks: childIds.map((id) => ({ ...makeBlock(id, id), type: "tool_call" as const })),
    };
  }

  it("grafts a nested server child that was lost from the middle, in server order", async () => {
    // Client holds [child-a, child-c]; the middle child (child-b) streamed while
    // its `content_block_start` was lost. It must be re-inserted at position 1,
    // not appended at the end — child order is display order.
    const ctx = createCtx(createSession([taskWithChildren(["child-a", "child-c"])], 1));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [taskWithChildren(["child-a", "child-b", "child-c"])],
          maxMessageId: 1,
        },
      ],
    });

    await repairPersistedBlocksAfterTurn(ctx, "s1");

    const repairedParent = ctx.get().sessions.s1.blocks[0];
    expect(repairedParent.childBlocks?.map((c) => c.id)).toEqual(["child-a", "child-b", "child-c"]);
  });
});
