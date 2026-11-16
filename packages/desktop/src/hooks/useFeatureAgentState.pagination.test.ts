// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFeatureAgentState } from "./useFeatureAgentState";

const mockRefetch = vi.fn();
const mockUseQuery = vi.fn();
const mockGetFeatureAgentState = vi.fn();

vi.mock("../api/generated", () => ({
  useGetFeatureAgentState: (...args: unknown[]) => mockUseQuery(...args),
  getFeatureAgentState: (...args: unknown[]) => mockGetFeatureAgentState(...args),
  getGetFeatureAgentStateQueryKey: (featureId: number, params?: unknown) =>
    [`/api/features/${featureId}/agent-state`, ...(params ? [params] : [])] as const,
}));

vi.mock("@/lib/agentStateCache", () => ({
  readAgentStateCache: vi.fn(() => Promise.resolve(null)),
  writeAgentStateCache: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({
      getQueryData: vi.fn(() => undefined),
      setQueryData: vi.fn(),
    }),
  };
});

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionDbId: 1,
    agentType: "session",
    status: "completed",
    subprocessId: null,
    model: "claude-opus-4-5",
    blocks: [],
    maxMessageId: 0,
    isIncremental: false,
    pendingQuestions: null,
    hasFileChanges: false,
    resumable: false,
    runtimeSessionId: null,
    todos: null,
    permissionMode: "acceptEdits",
    pendingPermission: null,
    inputTokens: 0,
    outputTokens: 0,
    contextWindow: 200000,
    wasCompacted: false,
    ...overrides,
  };
}

describe("useFeatureAgentState pagination", () => {
  beforeEach(() => {
    mockRefetch.mockClear();
    mockGetFeatureAgentState.mockReset();
    mockUseQuery.mockReturnValue({
      data: { sessions: [] },
      isLoading: false,
      refetch: mockRefetch,
    });
  });

  it("rerenders when older history is prepended", async () => {
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 100,
            isIncremental: false,
            hasMore: true,
            oldestMessageId: 50,
            blocks: [{ id: "msg-100", type: "text", content: "latest" }],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    mockGetFeatureAgentState.mockResolvedValue({
      sessions: [
        makeSession({
          sessionDbId: 1,
          hasMore: false,
          oldestMessageId: 1,
          blocks: [{ id: "msg-25", type: "text", content: "older" }],
        }),
      ],
    });

    const { result } = renderHook(() => useFeatureAgentState(1));

    await act(async () => {
      await result.current.loadOlderMessages(1);
    });

    expect(result.current.sessions[0].blocks.map((block) => block.content)).toEqual([
      "older",
      "latest",
    ]);
    expect(result.current.sessions[0].hasMore).toBe(false);
    expect(result.current.sessions[0].oldestMessageId).toBe(1);
  });
});
