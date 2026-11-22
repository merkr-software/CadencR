import { SessionTransportRegistry } from "./ws-session-transport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import type { StoreAccessors } from "./ws-envelope-handler";
import { loadSessionPromptTurn } from "./ws-session-prompt-turn";

const apiMocks = vi.hoisted(() => ({ getFeatureAgentState: vi.fn() }));

vi.mock("@/api/generated", () => ({ getFeatureAgentState: apiMocks.getFeatureAgentState }));
vi.mock("@/hooks/useFeatureAgentState", () => ({
  serverBlocksToAgentBlocks: (blocks: AgentBlockData[]) => blocks,
}));

function block(id: string, type: AgentBlockData["type"] = "text"): AgentBlockData {
  return { id, type, content: id };
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

/** First-prompt anchor (msg-10), then a window starting at msg-500. */
function anchoredSession(): SessionEntry {
  return {
    ...createSessionEntry(),
    blocks: [block("msg-10", "user_message"), block("msg-500"), block("msg-501", "user_message")],
    historyGaps: [
      { id: "g0", afterId: null, beforeId: 10 },
      { id: "g1", afterId: 10, beforeId: 500 },
    ],
    featureId: 7,
    sessionDbId: 42,
    historyPrependDisplayOffset: 3,
  };
}

describe("loadSessionPromptTurn", () => {
  beforeEach(() => apiMocks.getFeatureAgentState.mockReset());

  it("fetches the prompt's turn forward and slots it in by database order", async () => {
    const ctx = createCtx(anchoredSession());
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 42,
          blocks: [block("msg-200", "user_message"), block("msg-201"), block("msg-202")],
          hasMoreIncrementalMessages: true,
          maxMessageId: 202,
        },
      ],
    });

    await expect(loadSessionPromptTurn(ctx, "s1", 200)).resolves.toBe(true);

    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(7, {
      after: JSON.stringify({ 42: 199 }),
      after_revisions: JSON.stringify({ 42: Number.MAX_SAFE_INTEGER }),
      until: JSON.stringify({ 42: 500 }),
    });
    const session = ctx.get().sessions.s1;
    expect(session.blocks.map((b) => b.id)).toEqual([
      "msg-10",
      "msg-200",
      "msg-201",
      "msg-202",
      "msg-500",
      "msg-501",
    ]);
    // Three rows, and the gap row the turn splits off below it.
    expect(session.historyPrependDisplayOffset).toBe(7);
    // The turn is an island: a gap on each side, each filling on its own.
    expect(session.historyGaps.map(({ afterId, beforeId }) => [afterId, beforeId])).toEqual([
      [null, 10],
      [10, 200],
      [202, 500],
    ]);
  });

  it("closes the gap below the turn when its page reaches the loaded window", async () => {
    const ctx = createCtx(anchoredSession());
    // Bounded by \`until\`, the page ends right above the window.
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 42,
          blocks: [block("msg-490", "user_message"), block("msg-491")],
          hasMoreIncrementalMessages: false,
          maxMessageId: 491,
        },
      ],
    });

    await expect(loadSessionPromptTurn(ctx, "s1", 490)).resolves.toBe(true);

    expect(ctx.get().sessions.s1.historyGaps.map((gap) => gap.beforeId)).toEqual([10, 490]);
  });

  it("fetches the turn again when a gap fill moved its gap meanwhile", async () => {
    const ctx = createCtx(anchoredSession());
    const turn = {
      sessionDbId: 42,
      blocks: [block("msg-200", "user_message"), block("msg-201")],
      hasMoreIncrementalMessages: true,
      maxMessageId: 201,
    };
    apiMocks.getFeatureAgentState
      .mockImplementationOnce(async () => {
        // A fill lands meanwhile: the gap now ends at msg-300.
        const session = ctx.get().sessions.s1;
        const historyGaps = [session.historyGaps[0], { id: "g1", afterId: 10, beforeId: 300 }];
        ctx.set({ sessions: { s1: { ...session, historyGaps } } } as Partial<WsSessionStore>);
        return { sessions: [turn] };
      })
      .mockResolvedValueOnce({ sessions: [turn] });

    await expect(loadSessionPromptTurn(ctx, "s1", 200)).resolves.toBe(true);

    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledTimes(2);
    expect(apiMocks.getFeatureAgentState).toHaveBeenLastCalledWith(7, {
      after: JSON.stringify({ 42: 199 }),
      after_revisions: JSON.stringify({ 42: Number.MAX_SAFE_INTEGER }),
      until: JSON.stringify({ 42: 300 }),
    });
  });

  it("gives up with an error when its gap keeps moving", async () => {
    const ctx = createCtx(anchoredSession());
    let bound = 500;
    apiMocks.getFeatureAgentState.mockImplementation(async () => {
      // Each attempt sees a gap fill land first.
      bound -= 10;
      const session = ctx.get().sessions.s1;
      const historyGaps = [session.historyGaps[0], { id: "g1", afterId: 10, beforeId: bound }];
      ctx.set({ sessions: { s1: { ...session, historyGaps } } } as Partial<WsSessionStore>);
      return {
        sessions: [
          { sessionDbId: 42, blocks: [block("msg-200", "user_message")], maxMessageId: 200 },
        ],
      };
    });

    await expect(loadSessionPromptTurn(ctx, "s1", 200)).rejects.toThrow("kept changing");
    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledTimes(3);
  });

  it("leaves the transcript alone when the prompt no longer exists", async () => {
    const ctx = createCtx(anchoredSession());
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [{ sessionDbId: 42, blocks: [block("msg-203"), block("msg-204")] }],
    });

    await expect(loadSessionPromptTurn(ctx, "s1", 200)).resolves.toBe(false);
    expect(ctx.get().sessions.s1.blocks.map((b) => b.id)).toEqual(["msg-10", "msg-500", "msg-501"]);
  });
});
