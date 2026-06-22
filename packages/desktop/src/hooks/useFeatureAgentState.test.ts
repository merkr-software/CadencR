import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFeatureAgentState, serverBlocksToAgentBlocks } from "./useFeatureAgentState";

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

/** Helper to build a minimal session payload for tests. */
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

describe("serverBlocksToAgentBlocks", () => {
  it("sets taskComplete on Agent/Task tool_call blocks", () => {
    const blocks = serverBlocksToAgentBlocks([
      { id: "1", type: "tool_call", content: "{}", toolName: "Agent", toolUseId: "tu-1" },
      { id: "2", type: "text", content: "hello" },
      { id: "3", type: "tool_call", content: "{}", toolName: "Bash", toolUseId: "tu-2" },
    ] as never[]);
    expect(blocks[0].taskComplete).toBe(true);
    expect(blocks[1].taskComplete).toBeUndefined();
    expect(blocks[2].taskComplete).toBeUndefined();
  });

  it("preserves generated user-message origins from the server", () => {
    const blocks = serverBlocksToAgentBlocks([
      {
        id: "1",
        type: "user_message",
        content: "delegated",
        origin: {
          originKind: "session_generated",
          sourceSessionId: 123,
          sourceFeatureId: null,
          sourceProjectId: null,
          sourceMessageId: null,
          note: "helper",
          createdAt: null,
        },
      },
    ] as never[]);

    expect(blocks[0].origin?.originKind).toBe("session_generated");
    expect(blocks[0].origin?.sourceSessionId).toBe(123);
  });
});

describe("useFeatureAgentState", () => {
  beforeEach(() => {
    mockRefetch.mockClear();
    mockUseQuery.mockReturnValue({
      data: { sessions: [] },
      isLoading: false,
      refetch: mockRefetch,
    });
  });

  it("returns empty sessions when query data is empty", () => {
    const { result } = renderHook(() => useFeatureAgentState(1));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("maps session data correctly", () => {
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [makeSession({ inputTokens: 100, outputTokens: 50 })],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result } = renderHook(() => useFeatureAgentState(1));
    expect(result.current.sessions).toHaveLength(1);
    const session = result.current.sessions[0];
    expect(session.sessionDbId).toBe(1);
    expect(session.agentType).toBe("session");
    expect(session.status).toBe("completed");
    expect(session.model).toBe("claude-opus-4-5");
    expect(session.inputTokens).toBe(100);
  });

  it("reads optional runtime fields without unsafe casting", () => {
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [
          makeSession({
            runtimeProvider: "claude_code",
            runtimeSessionId: "runtime-123",
            draftPrompt: "draft",
          }),
        ],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result } = renderHook(() => useFeatureAgentState(1));
    const session = result.current.sessions[0];
    expect(session.runtimeProvider).toBe("claude_code");
    expect(session.runtimeSessionId).toBe("runtime-123");
    expect(session.draftPrompt).toBe("draft");
  });

  it("maps status=waiting to paused", () => {
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [makeSession({ agentType: "session", status: "waiting" })],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result } = renderHook(() => useFeatureAgentState(1));
    expect(result.current.sessions[0].status).toBe("paused");
  });

  it("isLoading is true when query is loading", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: true, refetch: mockRefetch });
    const { result } = renderHook(() => useFeatureAgentState(1));
    expect(result.current.isLoading).toBe(true);
  });

  it("parses multi-question format from pendingQuestions", () => {
    const pendingQuestions = {
      questions: [
        { question: "What is your name?", options: ["Alice", "Bob"] },
        { question: "Pick a color?", options: [{ label: "Red" }, { label: "Blue" }] },
      ],
    };
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [makeSession({ status: "paused", subprocessId: "sub-1", pendingQuestions })],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result } = renderHook(() => useFeatureAgentState(1));
    const session = result.current.sessions[0];
    expect(session.pendingQuestions).toHaveLength(2);
    expect(session.pendingQuestions![0].question).toBe("What is your name?");
    expect(session.pendingQuestions![0].options).toHaveLength(2);
  });

  it("parses single-question format from pendingQuestions", () => {
    const pendingQuestions = {
      question: "Are you sure?",
      options: ["Yes", "No"],
    };
    mockUseQuery.mockReturnValue({
      data: {
        sessions: [makeSession({ status: "paused", subprocessId: "sub-1", pendingQuestions })],
      },
      isLoading: false,
      refetch: mockRefetch,
    });

    const { result } = renderHook(() => useFeatureAgentState(1));
    const session = result.current.sessions[0];
    expect(session.pendingQuestions).toHaveLength(1);
    expect(session.pendingQuestions![0].question).toBe("Are you sure?");
  });
});
