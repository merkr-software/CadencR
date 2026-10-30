import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBlockData } from "@/components/AgentBlock";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import type { StoreAccessors } from "./ws-envelope-types";
import { applyMutations, blocksPatchWithDerived, processSdkMessage } from "./ws-message-processing";
import { resyncMessagesOnReconnect, resyncRecoveredPersistence } from "./ws-session-resync";
import { repairRecoveredPersistence } from "./ws-persistence-resync";

const api = vi.hoisted(() => ({ getFeatureAgentState: vi.fn() }));
vi.mock("@/api/generated", () => ({ getFeatureAgentState: api.getFeatureAgentState }));
vi.mock("@/hooks/useFeatureAgentState", () => ({
  serverBlocksToAgentBlocks: (blocks: AgentBlockData[]) => blocks,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function setup(texts = ["repaired output"]) {
  const session = createSessionEntry();
  Object.assign(session, {
    featureId: 1,
    sessionDbId: 2,
    lastAppliedMessageId: 99,
    lifecycle: { phase: "terminal", reason: "streamClosed" },
    persistenceStatus: { status: "recovered", message: "History repaired." },
  });
  session.blocks = [
    { id: "msg-5", type: "text", content: "unrelated history" },
    { id: "msg-10", type: "user_message", content: "prompt" },
  ];
  blocksPatchWithDerived(session.streamingState, session.blocks);
  const emit = (event: Record<string, unknown>): void => {
    const result = processSdkMessage(
      { type: "stream_event", session_id: "runtime", event },
      session.streamingState,
    );
    session.blocks = applyMutations(session.blocks, result.mutations, session.streamingState);
  };
  emit({ type: "message_start", message: {} });
  texts.forEach((text, index) =>
    emit({ type: "content_block_start", index, content_block: { type: "text", text } }),
  );
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;
  const ctx: StoreAccessors = {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    getSession: (id): SessionEntry => state.sessions[id],
  };
  return { ctx, emit, session };
}

function page(blocks: AgentBlockData[], more = false, maxMessageId = 11) {
  return {
    sessions: [
      {
        sessionDbId: 2,
        status: "completed",
        isIncremental: true,
        blocks,
        maxMessageId,
        hasMoreIncrementalMessages: more,
        hasMoreContentRevisions: false,
      },
    ],
  };
}
const text = (id: number, content: string): AgentBlockData => ({
  id: `msg-${id}`,
  type: "text",
  content,
});

describe("reconnect after a repaired assistant frame was lost", () => {
  beforeEach(() => api.getFeatureAgentState.mockReset());

  it("replaces captured synthetic copies using the canonical tail after recovery replay", async () => {
    const { ctx } = setup();
    api.getFeatureAgentState.mockResolvedValue(page([text(11, "repaired output")]));
    await resyncMessagesOnReconnect(ctx, "s1"); // Reconnect arrives before the replayed recovery.
    expect(ctx.getSession("s1").blocks).toHaveLength(4);
    await resyncRecoveredPersistence(ctx, "s1");
    expect(ctx.getSession("s1").blocks.map((block) => block.id)).toEqual([
      "msg-5",
      "msg-10",
      "msg-11",
    ]);
    expect(api.getFeatureAgentState).toHaveBeenLastCalledWith(1, {
      after: JSON.stringify({ 2: 10 }),
      after_revisions: JSON.stringify({ 2: 0 }),
    });
  });

  it("retains unsaved output without explicit recovery proof", async () => {
    const { ctx } = setup();
    ctx.getSession("s1").persistenceStatus = {
      status: "failed",
      message: "Unsaved output remains.",
    };
    const before = ctx.getSession("s1").blocks;
    await resyncRecoveredPersistence(ctx, "s1");
    expect(api.getFeatureAgentState).not.toHaveBeenCalled();
    expect(ctx.getSession("s1").blocks).toBe(before);
  });

  it("rejects a stale response when a new turn starts and retries at its completion", async () => {
    const { ctx, emit } = setup();
    let resolve: (value: unknown) => void = () => {};
    api.getFeatureAgentState.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = resyncRecoveredPersistence(ctx, "s1");
    await vi.waitFor(() => expect(api.getFeatureAgentState).toHaveBeenCalledOnce());
    const before = ctx.getSession("s1");
    ctx.set({ sessions: { s1: { ...before, lifecycle: { phase: "active" } } } });
    // Even a content-free message_start invalidates the captured generation.
    emit({ type: "message_start", message: {} });
    const newPrompt: AgentBlockData = {
      id: "msg-12",
      type: "user_message",
      content: "next prompt",
    };
    const current = ctx.getSession("s1");
    ctx.set({ sessions: { s1: { ...current, blocks: [...current.blocks, newPrompt] } } });
    resolve(page([text(11, "repaired output")]));
    await pending;
    expect(ctx.getSession("s1").blocks.some((block) => block.id.startsWith("ws-"))).toBe(true);
    expect(ctx.getSession("s1").blocks).toContain(newPrompt);
    ctx.set({
      sessions: {
        s1: { ...ctx.getSession("s1"), lifecycle: { phase: "terminal", reason: "completed" } },
      },
    });
    api.getFeatureAgentState.mockResolvedValue(
      page([text(11, "repaired output"), newPrompt], false, 12),
    );
    await resyncRecoveredPersistence(ctx, "s1");
    expect(ctx.getSession("s1").blocks.map((block) => block.id)).toEqual([
      "msg-5",
      "msg-10",
      "msg-11",
      "msg-12",
    ]);
  });

  it("drains every incremental page and keeps identical repeated canonical messages", async () => {
    const { ctx } = setup(["same", "same"]);
    api.getFeatureAgentState
      .mockResolvedValueOnce(page([text(11, "same")], true, 11))
      .mockResolvedValueOnce(page([{ ...text(12, "same"), truncatedContent: true }], false, 12));
    await resyncRecoveredPersistence(ctx, "s1");
    expect(ctx.getSession("s1").blocks.map((block) => block.id)).toEqual([
      "msg-5",
      "msg-10",
      "msg-11",
      "msg-12",
    ]);
    expect(api.getFeatureAgentState).toHaveBeenCalledTimes(2);
  });

  it.each(["limited", "stalled", "running"])(
    "keeps captured output when snapshot coverage is %s",
    async (kind) => {
      const { ctx } = setup();
      const response = page(
        [text(11, "repaired output")],
        kind === "stalled",
        kind === "stalled" ? 10 : 11,
      );
      if (kind === "limited") response.sessions[0].isIncremental = false;
      if (kind === "running") response.sessions[0].status = "running";
      api.getFeatureAgentState.mockResolvedValue(response);
      const synthetic = ctx.getSession("s1").blocks.at(-1)!;
      await resyncRecoveredPersistence(ctx, "s1");
      expect(ctx.getSession("s1").blocks).toContain(synthetic);
    },
  );

  it("defers recovery during an active turn without polling", async () => {
    const { ctx } = setup();
    ctx.getSession("s1").lifecycle = { phase: "active" };
    repairRecoveredPersistence(ctx, "s1");
    await Promise.resolve();
    await Promise.resolve();
    expect(api.getFeatureAgentState).not.toHaveBeenCalled();
  });

  it("retries once when a new turn completes while the stale repair request is pending", async () => {
    const { ctx, emit } = setup();
    let resolve: (value: unknown) => void = () => {};
    api.getFeatureAgentState
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(page([text(11, "repaired output")]));
    repairRecoveredPersistence(ctx, "s1");
    await vi.waitFor(() => expect(api.getFeatureAgentState).toHaveBeenCalledOnce());
    emit({ type: "message_start", message: {} });
    ctx.set({
      sessions: {
        s1: { ...ctx.getSession("s1"), lifecycle: { phase: "terminal", reason: "completed" } },
      },
    });
    repairRecoveredPersistence(ctx, "s1");
    resolve(page([text(11, "repaired output")]));
    await vi.waitFor(() => {
      expect(api.getFeatureAgentState).toHaveBeenCalledTimes(2);
      expect(ctx.getSession("s1").blocks.map((block) => block.id)).toEqual([
        "msg-5",
        "msg-10",
        "msg-11",
      ]);
    });
  });
});
