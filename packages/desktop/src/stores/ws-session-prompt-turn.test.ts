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
    hasMore: true,
    oldestMessageId: 500,
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
        },
      ],
    });

    await expect(loadSessionPromptTurn(ctx, "s1", 200)).resolves.toBe(true);

    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(7, {
      after: JSON.stringify({ 42: 199 }),
      after_revisions: JSON.stringify({ 42: Number.MAX_SAFE_INTEGER }),
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
    expect(session.historyPrependDisplayOffset).toBe(6);
    // The pagination cursor still points at the window: paging fills the gap.
    expect(session.oldestMessageId).toBe(500);
    expect(session.hasMore).toBe(true);
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
