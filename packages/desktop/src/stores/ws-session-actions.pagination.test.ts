import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentBlockData } from "@/components/AgentBlock";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import { applyPersistedState, loadOlderSessionMessages } from "./ws-session-actions";
import type { StoreAccessors } from "./ws-envelope-handler";

const apiMocks = vi.hoisted(() => ({
  getFeatureAgentState: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  getFeatureAgentState: apiMocks.getFeatureAgentState,
}));

vi.mock("@/hooks/useFeatureAgentState", () => ({
  serverBlocksToAgentBlocks: (blocks: AgentBlockData[]) => blocks,
}));

function makeBlock(
  id: string,
  content: string,
  type: AgentBlockData["type"] = "text",
  extra: Partial<AgentBlockData> = {},
): AgentBlockData {
  return { id, type, content, ...extra };
}

function createCtx(session: SessionEntry): StoreAccessors {
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;
  return {
    get: () => state,
    set: (partial: Partial<WsSessionStore>) => {
      state = { ...state, ...partial } as WsSessionStore;
    },
    getSession: (sessionId: string) => state.sessions[sessionId],
  };
}

function createPaginationSession(blocks: AgentBlockData[]): SessionEntry {
  return {
    ...createSessionEntry(),
    blocks,
    hasMore: true,
    oldestMessageId: 200,
    featureId: 1077,
    sessionDbId: 2586,
    historyPrependDisplayOffset: 5,
  };
}

describe("ws session history pagination", () => {
  beforeEach(() => {
    apiMocks.getFeatureAgentState.mockReset();
  });

  it("increments historyPrependDisplayOffset by rendered display rows, not raw blocks", async () => {
    const currentBlocks = [
      makeBlock("msg-300", "Current", "text", {
        createdAt: "2026-05-05T10:00:00Z",
        model: "claude-sonnet-4-6",
      }),
    ];
    const olderBlocks = [
      makeBlock("msg-100", "hidden tool output", "tool_result", { sourceToolName: "Read" }),
      makeBlock("msg-101", "Older ", "text", {
        createdAt: "2026-05-05T09:00:00Z",
        model: "gpt-5.5",
      }),
      makeBlock("msg-102", "chunk", "text", {
        createdAt: "2026-05-05T09:00:00Z",
        model: "gpt-5.5",
      }),
    ];
    const ctx = createCtx(createPaginationSession(currentBlocks));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: olderBlocks,
          hasMore: false,
          oldestMessageId: 100,
        },
      ],
    });

    await loadOlderSessionMessages(ctx, "s1");

    const session = ctx.get().sessions.s1;
    expect(session.historyPrependDisplayOffset).toBe(7);
    expect(session.blocks.map((block) => block.id)).toEqual([
      "msg-100",
      "msg-101",
      "msg-102",
      "msg-300",
    ]);
  });

  it("sizes the prepend offset to the collapsed row count in summary mode", async () => {
    const currentBlocks = [
      makeBlock("msg-200", "next", "user_message"),
      makeBlock("msg-201", "Current", "text"),
    ];
    const olderBlocks = [
      makeBlock("msg-100", "prompt", "user_message"),
      makeBlock("msg-101", "read", "tool_call", { toolName: "Read" }),
      makeBlock("msg-102", "bash", "tool_call", { toolName: "Bash" }),
      makeBlock("msg-103", "older answer", "text"),
    ];
    const ctx = createCtx(createPaginationSession(currentBlocks));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [{ sessionDbId: 2586, blocks: olderBlocks, hasMore: false, oldestMessageId: 100 }],
    });

    await loadOlderSessionMessages(ctx, "s1", { summaryMode: true });

    // Older chunk renders as [u1, tool_summary, m1] = 3 collapsed rows (vs 4 raw
    // rows), so the offset grows by 3 from its base of 5.
    const session = ctx.get().sessions.s1;
    expect(session.historyPrependDisplayOffset).toBe(8);
    // The store still holds raw blocks; the collapse is display-only.
    expect(session.blocks.map((block) => block.id)).toEqual([
      "msg-100",
      "msg-101",
      "msg-102",
      "msg-103",
      "msg-200",
      "msg-201",
    ]);
  });

  it("resets historyPrependDisplayOffset when persisted state replaces a session", () => {
    const ctx = createCtx(createPaginationSession([makeBlock("current", "Current")]));

    applyPersistedState(
      ctx,
      "s1",
      {
        blocks: [],
        lifecycle: { phase: "idle" },
      },
      "plan-restore:",
    );

    expect(ctx.get().sessions.s1.historyPrependDisplayOffset).toBe(0);
  });

  it("hydrates a persisted provider and model as one ready selection", () => {
    const ctx = createCtx(createSessionEntry());

    applyPersistedState(
      ctx,
      "s1",
      {
        blocks: [],
        lifecycle: { phase: "idle" },
        currentProviderId: "opencode",
        runtimeProvider: "opencode",
        currentModelId: "lmstudio/qwen-3.6:35b-a3b",
      },
      "plan-restore:",
    );

    const session = ctx.get().sessions.s1;
    expect(session.currentSelection).toEqual({
      providerId: "opencode",
      modelId: "lmstudio/qwen-3.6:35b-a3b",
    });
  });

  it("keeps an initialized live selection when a stale snapshot arrives later", () => {
    const session = createSessionEntry();
    session.serverSessionId = "42";
    session.currentSelection = { providerId: "claude_code", modelId: "opus" };
    const ctx = createCtx(session);

    applyPersistedState(
      ctx,
      "s1",
      {
        blocks: [],
        lifecycle: { phase: "idle" },
        currentProviderId: "opencode",
        runtimeProvider: "opencode",
        currentModelId: "lmstudio/qwen-3.6:35b-a3b",
      },
      "plan-restore:",
    );

    const updated = ctx.get().sessions.s1;
    expect(updated.currentSelection).toEqual({ providerId: "claude_code", modelId: "opus" });
  });
});
