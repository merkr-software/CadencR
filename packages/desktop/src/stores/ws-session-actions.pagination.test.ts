import { SessionTransportRegistry } from "./ws-session-transport";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { buildDisplayItems } from "@/lib/agent-stream-display";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import { applyPersistedState } from "./ws-session-actions";
import { fillSessionHistoryGap } from "./ws-session-history-fill";
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
    transport: new SessionTransportRegistry(),
    getSession: (sessionId: string) => state.sessions[sessionId],
  };
}

function createPaginationSession(blocks: AgentBlockData[]): SessionEntry {
  return {
    ...createSessionEntry(),
    blocks,
    historyGaps: [{ id: "g1", afterId: null, beforeId: 200 }],
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

    await fillSessionHistoryGap(ctx, "s1", "g1", "older");

    const session = ctx.get().sessions.s1;
    // Two rows land above msg-300 and the gap row above it closes: +1.
    expect(session.historyPrependDisplayOffset).toBe(6);
    expect(session.historyGaps).toEqual([]);
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

    await fillSessionHistoryGap(ctx, "s1", "g1", "older", { displayMode: { summaryMode: true } });

    // Older chunk renders as [u1, tool_summary, m1] = 3 collapsed rows (vs 4 raw
    // rows) where the closed gap's row was, so the offset grows by 2 from 5.
    const session = ctx.get().sessions.s1;
    expect(session.historyPrependDisplayOffset).toBe(7);
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

  it("preserves compact runs across consecutive history prepend seams", async () => {
    const currentBlocks = Array.from({ length: 50 }, (_, index) =>
      makeBlock(`msg-${300 + index}`, "read", "tool_call", { toolName: "Read" }),
    );
    const firstPage = Array.from({ length: 30 }, (_, index) =>
      makeBlock(`msg-${170 + index}`, "read", "tool_call", { toolName: "Read" }),
    );
    const secondPage = Array.from({ length: 10 }, (_, index) =>
      makeBlock(`msg-${160 + index}`, "read", "tool_call", { toolName: "Read" }),
    );
    const ctx = createCtx(createPaginationSession(currentBlocks));
    apiMocks.getFeatureAgentState
      .mockResolvedValueOnce({
        sessions: [{ sessionDbId: 2586, blocks: firstPage, hasMore: true, oldestMessageId: 170 }],
      })
      .mockResolvedValueOnce({
        sessions: [{ sessionDbId: 2586, blocks: secondPage, hasMore: false, oldestMessageId: 160 }],
      });

    await fillSessionHistoryGap(ctx, "s1", "g1", "older", { displayMode: { compactMode: true } });
    expect(ctx.get().sessions.s1.historyGaps).toEqual([{ id: "g1", afterId: null, beforeId: 170 }]);
    await fillSessionHistoryGap(ctx, "s1", "g1", "older", { displayMode: { compactMode: true } });

    const session = ctx.get().sessions.s1;
    // The first page adds a row ([170-199]) under the gap's; the second
    // ([160-169]) takes the place of the gap's row as it closes.
    expect(session.historyPrependDisplayOffset).toBe(6);
    expect(session.historyGaps).toEqual([]);
    expect(session.blocks.find((block) => block.id === "msg-170")?.compactFlowBreakBefore).toBe(
      true,
    );
    expect(session.blocks.find((block) => block.id === "msg-300")?.compactFlowBreakBefore).toBe(
      true,
    );
    expect(session.rootBlocks.find((block) => block.id === "msg-300")?.compactFlowBreakBefore).toBe(
      true,
    );
  });

  it("merges older children into a cloned Task boundary, which never folds", async () => {
    const task = makeBlock("msg-300", "{}", "tool_call", {
      toolName: "Task",
      toolUseId: "task-300",
      taskComplete: true,
      childBlocks: [makeBlock("child-current", "current child")],
    });
    const trailing = Array.from({ length: 50 }, (_, index) =>
      makeBlock(`msg-${301 + index}`, "read", "tool_call", { toolName: "Read" }),
    );
    const currentBlocks = [task, ...trailing];
    const before = buildDisplayItems(currentBlocks, { compact: true });
    const duplicateTask = makeBlock("msg-300", "{}", "tool_call", {
      toolName: "Task",
      toolUseId: "task-300",
      childBlocks: [makeBlock("child-older", "older child")],
    });
    const olderRoot = makeBlock("msg-200", "read", "tool_call", { toolName: "Read" });
    const ctx = createCtx(createPaginationSession(currentBlocks));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [olderRoot, duplicateTask],
          hasMore: false,
          oldestMessageId: 200,
        },
      ],
    });

    await fillSessionHistoryGap(ctx, "s1", "g1", "older", { displayMode: { compactMode: true } });

    const session = ctx.get().sessions.s1;
    const mergedTask = session.blocks.find((block) => block.id === task.id);
    // A sub-agent keeps its own row in compact flow, so no fold seam to mark.
    expect(mergedTask?.compactFlowBreakBefore).toBeUndefined();
    expect(mergedTask?.childBlocks?.map((child) => child.id)).toEqual([
      "child-current",
      "child-older",
    ]);
    const after = buildDisplayItems(session.blocks, { compact: true });
    const firstCurrentRow = after.findIndex((item) => item.key === before[0].key);
    expect(firstCurrentRow).toBe(1);
    expect(after.slice(firstCurrentRow).map((item) => item.key)).toEqual(
      before.map((item) => item.key),
    );
  });

  it("resets historyPrependDisplayOffset when persisted state fills an empty session", () => {
    const ctx = createCtx({ ...createPaginationSession([]), historyGaps: [] });

    applyPersistedState(ctx, "s1", {
      blocks: [makeBlock("msg-50", "first", "user_message"), makeBlock("msg-300", "Current")],
      lifecycle: { phase: "idle" },
      hasMore: true,
      oldestMessageId: 300,
    });

    const session = ctx.get().sessions.s1;
    expect(session.historyPrependDisplayOffset).toBe(0);
    // The first prompt shipped ahead of the page is an island between two gaps.
    expect(session.historyGaps.map(({ afterId, beforeId }) => [afterId, beforeId])).toEqual([
      [null, 50],
      [50, 300],
    ]);
  });

  it("drops a page whose gap another load moved while it was in flight", async () => {
    const ctx = createCtx(createPaginationSession([makeBlock("msg-300", "Current")]));
    apiMocks.getFeatureAgentState.mockImplementation(async () => {
      // A prompt's turn lands meanwhile and splits the gap.
      const session = ctx.get().sessions.s1;
      ctx.set({
        sessions: {
          s1: {
            ...session,
            historyGaps: [
              { id: "g1", afterId: null, beforeId: 150 },
              { id: "g9", afterId: 160, beforeId: 200 },
            ],
          },
        },
      } as Partial<WsSessionStore>);
      return {
        sessions: [
          {
            sessionDbId: 2586,
            blocks: [makeBlock("msg-170", "x")],
            hasMore: true,
            oldestMessageId: 101,
          },
        ],
      };
    });

    await fillSessionHistoryGap(ctx, "s1", "g1", "older");

    const session = ctx.get().sessions.s1;
    expect(session.blocks.map((block) => block.id)).toEqual(["msg-300"]);
    expect(session.historyGaps.map((gap) => gap.id)).toEqual(["g1", "g9"]);
  });

  it("stops before a page lands once told to", async () => {
    const ctx = createCtx(createPaginationSession([makeBlock("msg-300", "Current")]));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [{ sessionDbId: 2586, blocks: [makeBlock("msg-150", "x")], hasMore: false }],
    });

    await fillSessionHistoryGap(ctx, "s1", "g1", "older", { shouldContinue: () => false });

    const session = ctx.get().sessions.s1;
    expect(session.blocks.map((block) => block.id)).toEqual(["msg-300"]);
    expect(session.historyGaps).toEqual([{ id: "g1", afterId: null, beforeId: 200 }]);
  });

  it("fills a gap from below without moving the rows above the reader", async () => {
    const island = [makeBlock("msg-100", "far prompt", "user_message")];
    const window = [makeBlock("msg-300", "Current")];
    const ctx = createCtx({
      ...createPaginationSession([...island, ...window]),
      historyGaps: [{ id: "g2", afterId: 100, beforeId: 300 }],
    });
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [makeBlock("msg-101", "answer"), makeBlock("msg-102", "more")],
          hasMoreIncrementalMessages: true,
          maxMessageId: 102,
        },
      ],
    });

    await fillSessionHistoryGap(ctx, "s1", "g2", "newer");

    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077, {
      after: JSON.stringify({ 2586: 100 }),
      after_revisions: JSON.stringify({ 2586: Number.MAX_SAFE_INTEGER }),
      // The page stops at the rows already loaded under the gap.
      until: JSON.stringify({ 2586: 300 }),
    });
    const session = ctx.get().sessions.s1;
    // The page lands below the reader: no row above it moved.
    expect(session.historyPrependDisplayOffset).toBe(5);
    expect(session.historyGaps).toEqual([{ id: "g2", afterId: 102, beforeId: 300 }]);
    expect(session.blocks.map((block) => block.id)).toEqual([
      "msg-100",
      "msg-101",
      "msg-102",
      "msg-300",
    ]);
  });

  it("keeps the gap open above a page while its bounded range holds more rows", async () => {
    const ctx = createCtx({
      ...createPaginationSession([
        makeBlock("msg-100", "far prompt", "user_message"),
        makeBlock("msg-300", "Current"),
      ]),
      historyGaps: [{ id: "g2", afterId: 100, beforeId: 300 }],
    });
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [
        {
          sessionDbId: 2586,
          blocks: [makeBlock("msg-200", "x")],
          hasMore: true,
          oldestMessageId: 200,
        },
      ],
    });

    await fillSessionHistoryGap(ctx, "s1", "g2", "older");

    expect(ctx.get().sessions.s1.historyGaps).toEqual([{ id: "g2", afterId: 100, beforeId: 200 }]);
  });

  it("keeps an older page inside the gap, and closes the gap once the range is exhausted", async () => {
    const ctx = createCtx({
      ...createPaginationSession([
        makeBlock("msg-100", "far prompt", "user_message"),
        makeBlock("msg-300", "Current"),
      ]),
      historyGaps: [{ id: "g2", afterId: 100, beforeId: 300 }],
    });
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [{ sessionDbId: 2586, blocks: [makeBlock("msg-150", "x")], hasMore: false }],
    });

    await fillSessionHistoryGap(ctx, "s1", "g2", "older");

    expect(apiMocks.getFeatureAgentState).toHaveBeenCalledWith(1077, {
      before: JSON.stringify({ 2586: 300 }),
      limit: 100,
      since: JSON.stringify({ 2586: 100 }),
    });
    expect(ctx.get().sessions.s1.historyGaps).toEqual([]);
  });

  it("rejects a page that makes no progress, leaving the gap as it was", async () => {
    const ctx = createCtx(createPaginationSession([makeBlock("msg-300", "Current")]));
    apiMocks.getFeatureAgentState.mockResolvedValue({
      sessions: [{ sessionDbId: 2586, blocks: [], hasMore: true, oldestMessageId: 250 }],
    });

    await expect(fillSessionHistoryGap(ctx, "s1", "g1", "older")).rejects.toThrow("no messages");
    expect(ctx.get().sessions.s1.historyGaps).toEqual([{ id: "g1", afterId: null, beforeId: 200 }]);
  });

  it("hydrates a persisted provider and model as one ready selection", () => {
    const ctx = createCtx(createSessionEntry());

    applyPersistedState(ctx, "s1", {
      blocks: [],
      lifecycle: { phase: "idle" },
      currentProviderId: "opencode",
      runtimeProvider: "opencode",
      currentModelId: "lmstudio/qwen-3.6:35b-a3b",
    });

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

    applyPersistedState(ctx, "s1", {
      blocks: [],
      lifecycle: { phase: "idle" },
      currentProviderId: "opencode",
      runtimeProvider: "opencode",
      currentModelId: "lmstudio/qwen-3.6:35b-a3b",
    });

    const updated = ctx.get().sessions.s1;
    expect(updated.currentSelection).toEqual({ providerId: "claude_code", modelId: "opus" });
  });
});
