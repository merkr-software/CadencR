import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFeatureAgentState } from "./useFeatureAgentState";

const mockRefetch = vi.fn();
const mockUseQuery = vi.fn();

vi.mock("../api/generated", () => ({
  useGetFeatureAgentState: (...args: unknown[]) => mockUseQuery(...args),
  getFeatureAgentState: vi.fn(),
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

function makeSession(overrides: Record<string, unknown> = {}) {
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

describe("useFeatureAgentState incremental merge", () => {
  beforeEach(() => {
    mockRefetch.mockClear();
    mockUseQuery.mockReturnValue({
      data: { sessions: [] },
      isLoading: false,
      refetch: mockRefetch,
    });
  });

  it("passes afterMessageIds to query after processing data", () => {
    // Initial full fetch
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 100,
            isIncremental: false,
            blocks: [{ id: "msg-1", type: "text", content: "hello" }],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { rerender } = renderHook(() => useFeatureAgentState(1));

    // After first render + useEffect (dataVersion bump), the query should
    // be called with afterMessageIds derived from accumulated state
    act(() => {
      rerender();
    });

    // The second call to useQuery should include featureId and after param (JSON-encoded afterMessageIds)
    const lastCall = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1];
    expect(lastCall[0]).toBe(1); // featureId
    expect(lastCall[1]).toEqual({ after: JSON.stringify({ "1": 100 }), limit: undefined }); // params
  });

  it("appends incremental blocks without boundary merge", () => {
    // Start with full data
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 100,
            isIncremental: false,
            blocks: [{ id: "msg-1", type: "text", content: "hello " }],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result, rerender } = renderHook(() => useFeatureAgentState(1));
    expect(result.current.sessions[0].blocks).toHaveLength(1);
    expect(result.current.sessions[0].blocks[0].content).toBe("hello ");

    // Now simulate incremental response with a tool_call (no merge needed)
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 105,
            isIncremental: true,
            blocks: [
              {
                id: "msg-101",
                type: "tool_call",
                content: "{}",
                toolName: "Read",
                toolUseId: "tu-1",
              },
            ],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    rerender();

    expect(result.current.sessions[0].blocks).toHaveLength(2);
    expect(result.current.sessions[0].blocks[0].content).toBe("hello ");
    expect(result.current.sessions[0].blocks[1].type).toBe("tool_call");
  });

  it("merges text blocks at boundary during incremental update", () => {
    // Start with full data ending in a text block
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 100,
            isIncremental: false,
            blocks: [{ id: "msg-1", type: "text", content: "hello " }],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result, rerender } = renderHook(() => useFeatureAgentState(1));

    // Incremental response with a text block that should merge
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 105,
            isIncremental: true,
            blocks: [{ id: "msg-101", type: "text", content: "world" }],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    rerender();

    expect(result.current.sessions[0].blocks).toHaveLength(1);
    expect(result.current.sessions[0].blocks[0].content).toBe("hello world");
  });

  it("preserves existing blocks when incremental response has 0 new blocks", () => {
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 100,
            isIncremental: false,
            blocks: [
              { id: "msg-1", type: "text", content: "existing text" },
              { id: "msg-50", type: "tool_call", content: "{}", toolName: "Write" },
            ],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result, rerender } = renderHook(() => useFeatureAgentState(1));
    expect(result.current.sessions[0].blocks).toHaveLength(2);

    // Empty incremental response
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 100,
            isIncremental: true,
            blocks: [],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    rerender();

    expect(result.current.sessions[0].blocks).toHaveLength(2);
    expect(result.current.sessions[0].blocks[0].content).toBe("existing text");
  });

  it("updates existing nested tool_call blocks instead of appending them after child text", () => {
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 100,
            isIncremental: false,
            blocks: [
              {
                id: "task-1",
                type: "tool_call",
                content: '{"description":"Find OpenCode UI rendering","status":"pending"}',
                toolName: "Task",
                toolUseId: "task-tu-1",
                childBlocks: [
                  {
                    id: "msg-10",
                    type: "tool_call",
                    content: '{"status":"pending"}',
                    toolName: "Read",
                    toolUseId: "read-tu-1",
                    parentToolUseId: "task-tu-1",
                  },
                  {
                    id: "msg-11",
                    type: "text",
                    content: "Final answer",
                    parentToolUseId: "task-tu-1",
                  },
                ],
              },
            ],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result, rerender } = renderHook(() => useFeatureAgentState(1));

    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 101,
            isIncremental: true,
            blocks: [
              {
                id: "msg-12",
                type: "tool_call",
                content: '{"file_path":"/tmp/example.ts"}',
                toolName: "Read",
                toolUseId: "read-tu-1",
                parentToolUseId: "task-tu-1",
              },
            ],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    rerender();

    const childBlocks = result.current.sessions[0].blocks[0].childBlocks;
    expect(childBlocks).toHaveLength(2);
    expect(childBlocks?.[0].type).toBe("tool_call");
    expect(childBlocks?.[0].content).toBe('{"file_path":"/tmp/example.ts"}');
    expect(childBlocks?.[1].type).toBe("text");
    expect(childBlocks?.[1].content).toBe("Final answer");
  });

  it("clears accumulated state on feature ID change", () => {
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            maxMessageId: 100,
            isIncremental: false,
            blocks: [{ id: "msg-1", type: "text", content: "feature 1 text" }],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result, rerender } = renderHook(({ featureId }) => useFeatureAgentState(featureId), {
      initialProps: { featureId: 1 },
    });
    expect(result.current.sessions[0].blocks[0].content).toBe("feature 1 text");

    // Switch feature — accumulated state should be cleared, so the first query
    // call for the new featureId should use afterMessageIds=undefined (full fetch)
    const callCountBefore = mockUseQuery.mock.calls.length;

    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            sessionDbId: 2,
            maxMessageId: 50,
            isIncremental: false,
            blocks: [{ id: "msg-20", type: "text", content: "feature 2 text" }],
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    rerender({ featureId: 2 });

    // The first query call after the feature change should be a full fetch
    const callAfterChange = mockUseQuery.mock.calls[callCountBefore];
    expect(callAfterChange[0]).toBe(2); // featureId
    expect(callAfterChange[1]).toEqual({ after: undefined, limit: 100 }); // full fetch params
    expect(result.current.sessions[0].blocks[0].content).toBe("feature 2 text");
  });
});
