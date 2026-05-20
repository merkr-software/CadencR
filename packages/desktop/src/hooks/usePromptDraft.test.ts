import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetPromptDraftMemoryForTest, usePromptDraft } from "./usePromptDraft";

const mockSaveDraftMutate = vi.fn();
const mockSendRaw = vi.fn();
const mockSendRequest = vi.fn(
  (_sessionId?: string, _envelope?: unknown): Promise<{ draft: string | null }> =>
    Promise.resolve({ draft: null }),
);
const mockDraftQueryData = vi.fn((): { draftPrompt: string | null } | undefined => undefined);

vi.mock("../api/generated", () => ({
  useSaveSessionDraft: vi.fn(() => ({ mutate: mockSaveDraftMutate })),
  useGetSessionDraft: vi.fn(() => ({ data: mockDraftQueryData() })),
}));

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      send: mockSendRaw,
      sendRequest: mockSendRequest,
      sessions: {
        "ws-test-1": { isConnected: true, sessionDbId: 42 },
        "ws-test-2": { isConnected: true, sessionDbId: 43 },
        "ws-test-pending": { isConnected: true, sessionDbId: null },
      },
    }),
}));

describe("usePromptDraft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPromptDraftMemoryForTest();
    mockSaveDraftMutate.mockClear();
    mockSendRaw.mockClear();
    mockSendRequest.mockClear();
    mockSendRequest.mockResolvedValue({ draft: null });
    mockDraftQueryData.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the initialDraft unchanged", () => {
    const { result } = renderHook(() =>
      usePromptDraft({ sessionId: 1, initialDraft: "hello world" }),
    );
    expect(result.current.initialDraft).toBe("hello world");
  });

  it("returns null initialDraft when not provided", () => {
    const { result } = renderHook(() => usePromptDraft({ sessionId: 1, initialDraft: null }));
    expect(result.current.initialDraft).toBeNull();
  });

  it("saves via HTTP when no wsSessionId", () => {
    const { result } = renderHook(() => usePromptDraft({ sessionId: 1, initialDraft: null }));
    act(() => {
      result.current.saveDraft("final text");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockSaveDraftMutate).toHaveBeenCalledWith({
      sessionId: 1,
      data: { draft: "final text" },
    });
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it("saves via WS when wsSessionId is provided", () => {
    const { result } = renderHook(() =>
      usePromptDraft({ sessionId: undefined, wsSessionId: "ws-test-1", initialDraft: null }),
    );
    act(() => {
      result.current.saveDraft("ws draft");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockSendRaw).toHaveBeenCalledTimes(1);
    expect(mockSaveDraftMutate).not.toHaveBeenCalled();
  });

  it("fetches draft from DB via WS when no initialDraft", async () => {
    mockSendRequest.mockResolvedValue({ draft: "restored text" });
    const { result } = renderHook(() =>
      usePromptDraft({ sessionId: undefined, wsSessionId: "ws-test-1", initialDraft: null }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.initialDraft).toBe("restored text");
  });

  it("restores draft from HTTP query when a DB session ID is known", () => {
    mockDraftQueryData.mockReturnValue({ draftPrompt: "saved draft" });
    const { result } = renderHook(() => usePromptDraft({ sessionId: 1, initialDraft: null }));
    expect(result.current.initialDraft).toBe("saved draft");
  });

  it("debounces multiple saves — only persists the last one", () => {
    const { result } = renderHook(() => usePromptDraft({ sessionId: 1, initialDraft: null }));
    act(() => {
      result.current.saveDraft("a");
      result.current.saveDraft("ab");
      result.current.saveDraft("abc");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockSaveDraftMutate).toHaveBeenCalledTimes(1);
    expect(mockSaveDraftMutate).toHaveBeenCalledWith({ sessionId: 1, data: { draft: "abc" } });
  });

  it("does not save when no sessionId and no wsSessionId", () => {
    const { result } = renderHook(() =>
      usePromptDraft({ sessionId: undefined, initialDraft: null }),
    );
    act(() => {
      result.current.saveDraft("some text");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockSaveDraftMutate).not.toHaveBeenCalled();
  });

  it("flushes pending draft on unmount", () => {
    const { result, unmount } = renderHook(() =>
      usePromptDraft({ sessionId: 1, initialDraft: null }),
    );
    act(() => {
      result.current.saveDraft("pending on unmount");
    });
    unmount();
    expect(mockSaveDraftMutate).toHaveBeenCalledWith({
      sessionId: 1,
      data: { draft: "pending on unmount" },
    });
  });

  it("saves null draft (clearing draft)", () => {
    const { result } = renderHook(() => usePromptDraft({ sessionId: 1, initialDraft: "old" }));
    act(() => {
      result.current.saveDraft(null);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockSaveDraftMutate).toHaveBeenCalledWith({ sessionId: 1, data: { draft: null } });
  });

  it("resets restored draft while switching to another WS session", async () => {
    mockSendRequest.mockResolvedValue({ draft: "first draft" });
    const { result, rerender } = renderHook(
      ({ wsSessionId }: { wsSessionId: string }) =>
        usePromptDraft({ sessionId: undefined, wsSessionId, initialDraft: null }),
      { initialProps: { wsSessionId: "ws-test-1" } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.initialDraft).toBe("first draft");

    rerender({ wsSessionId: "ws-test-2" });

    expect(result.current.initialDraft).toBeNull();
  });

  it("ignores late WS draft responses from a previous session", async () => {
    let resolveFirst: (value: { draft: string | null }) => void = () => undefined;
    mockSendRequest.mockImplementation((_: string | undefined, envelope: unknown) => {
      const payload = (envelope as { payload?: { session_id?: number } }).payload;
      if (payload?.session_id === 42) {
        return new Promise<{ draft: string | null }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ draft: null });
    });

    const { result, rerender } = renderHook(
      ({ wsSessionId }: { wsSessionId: string }) =>
        usePromptDraft({ sessionId: undefined, wsSessionId, initialDraft: null }),
      { initialProps: { wsSessionId: "ws-test-1" } },
    );

    rerender({ wsSessionId: "ws-test-2" });

    await act(async () => {
      resolveFirst({ draft: "stale first draft" });
      await Promise.resolve();
    });

    expect(result.current.initialDraft).toBeNull();
  });

  it("ignores late WS draft responses after switching to an uninitialized session", async () => {
    let resolveFirst: (value: { draft: string | null }) => void = () => undefined;
    mockSendRequest.mockImplementation((_: string | undefined, envelope: unknown) => {
      const payload = (envelope as { payload?: { session_id?: number } }).payload;
      if (payload?.session_id === 42) {
        return new Promise<{ draft: string | null }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ draft: null });
    });

    const { result, rerender } = renderHook(
      ({ wsSessionId }: { wsSessionId: string }) =>
        usePromptDraft({ sessionId: undefined, wsSessionId, initialDraft: null }),
      { initialProps: { wsSessionId: "ws-test-1" } },
    );

    rerender({ wsSessionId: "ws-test-pending" });

    await act(async () => {
      resolveFirst({ draft: "stale first draft" });
      await Promise.resolve();
    });

    expect(result.current.initialDraft).toBeNull();
  });

  it("flushes a pending WS draft once the DB session ID becomes available", () => {
    const { result, rerender } = renderHook(
      ({ wsSessionId }: { wsSessionId: string | undefined }) =>
        usePromptDraft({ sessionId: undefined, wsSessionId, initialDraft: null }),
      { initialProps: { wsSessionId: undefined as string | undefined } },
    );
    act(() => {
      result.current.saveDraft("typed before init");
    });

    rerender({ wsSessionId: "ws-test-1" });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(mockSendRaw).toHaveBeenCalledTimes(1);
  });

  it("restores unsaved WS draft locally after unmount before DB session ID is available", () => {
    const first = renderHook(() =>
      usePromptDraft({ sessionId: undefined, wsSessionId: "ws-test-pending", initialDraft: null }),
    );
    act(() => {
      first.result.current.saveDraft("local draft before init");
    });
    first.unmount();

    const second = renderHook(() =>
      usePromptDraft({ sessionId: undefined, wsSessionId: "ws-test-pending", initialDraft: null }),
    );

    expect(second.result.current.initialDraft).toBe("local draft before init");
  });

  it("keeps unsent drafts isolated while switching between existing WS sessions", () => {
    const first = renderHook(() =>
      usePromptDraft({ sessionId: undefined, wsSessionId: "ws-test-1", initialDraft: null }),
    );
    act(() => {
      first.result.current.saveDraft("Hello");
    });
    first.unmount();

    const second = renderHook(() =>
      usePromptDraft({ sessionId: undefined, wsSessionId: "ws-test-2", initialDraft: null }),
    );
    act(() => {
      second.result.current.saveDraft("World");
    });
    second.unmount();

    const firstAgain = renderHook(() =>
      usePromptDraft({ sessionId: undefined, wsSessionId: "ws-test-1", initialDraft: null }),
    );
    const secondAgain = renderHook(() =>
      usePromptDraft({ sessionId: undefined, wsSessionId: "ws-test-2", initialDraft: null }),
    );

    expect(firstAgain.result.current.initialDraft).toBe("Hello");
    expect(secondAgain.result.current.initialDraft).toBe("World");
  });
});
