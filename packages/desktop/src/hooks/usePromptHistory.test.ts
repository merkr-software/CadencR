import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { usePromptHistory } from "./usePromptHistory";

const mockSendRequest = vi.fn(
  (): Promise<{ entries: string[] }> => Promise.resolve({ entries: [] }),
);
const mockIsConnected = vi.fn(() => true);

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      sendRequest: mockSendRequest,
      sessions: {
        "ws-test-1": { isConnected: mockIsConnected() },
      },
    }),
}));

describe("usePromptHistory", () => {
  beforeEach(() => {
    mockSendRequest.mockClear();
    mockSendRequest.mockResolvedValue({ entries: [] });
    mockIsConnected.mockReturnValue(true);
  });

  it("starts with historyIndex -1 (not browsing)", () => {
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    expect(result.current.historyIndex).toBe(-1);
  });

  it("navigateUp returns null when no history", () => {
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    let res: string | null = null;
    act(() => {
      res = result.current.navigateUp("current text");
    });
    expect(res).toBeNull();
    expect(result.current.historyIndex).toBe(-1);
  });

  it("navigateDown returns null when not browsing", () => {
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    let res: string | null = null;
    act(() => {
      res = result.current.navigateDown();
    });
    expect(res).toBeNull();
  });

  it("fetches history on connect and navigates", async () => {
    mockSendRequest.mockResolvedValue({ entries: ["first", "second", "third"] });
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));

    // Wait for the effect to resolve
    await act(async () => {
      await Promise.resolve();
    });

    let res: string | null = null;
    act(() => {
      res = result.current.navigateUp("draft text");
    });
    expect(res).toBe("first");
    expect(result.current.historyIndex).toBe(0);
  });

  it("preserves loaded history when a reconnect fetch times out", async () => {
    mockSendRequest.mockResolvedValueOnce({ entries: ["first"] });
    const { result, rerender } = renderHook(() => usePromptHistory(1, "ws-test-1"));

    await act(async () => {
      await Promise.resolve();
    });

    mockIsConnected.mockReturnValue(false);
    rerender();
    mockSendRequest.mockResolvedValueOnce(null as never);
    mockIsConnected.mockReturnValue(true);
    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.navigateUp("draft")).toBe("first");
  });

  it("navigateUp goes to older entries", async () => {
    mockSendRequest.mockResolvedValue({ entries: ["first", "second", "third"] });
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.navigateUp("draft");
    });
    let res: string | null = null;
    act(() => {
      res = result.current.navigateUp("first");
    });
    expect(res).toBe("second");
    expect(result.current.historyIndex).toBe(1);
  });

  it("navigateDown returns previous entry when browsing", async () => {
    mockSendRequest.mockResolvedValue({ entries: ["first", "second"] });
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.navigateUp("draft");
    });
    act(() => {
      result.current.navigateUp("first");
    });
    let res: string | null = null;
    act(() => {
      res = result.current.navigateDown();
    });
    expect(res).toBe("first");
    expect(result.current.historyIndex).toBe(0);
  });

  it("navigateDown at index 0 returns to draft text", async () => {
    mockSendRequest.mockResolvedValue({ entries: ["first"] });
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.navigateUp("my draft");
    });
    let res: string | null = null;
    act(() => {
      res = result.current.navigateDown();
    });
    expect(res).toBe("my draft");
    expect(result.current.historyIndex).toBe(-1);
  });

  it("navigateUp at oldest entry returns null", async () => {
    mockSendRequest.mockResolvedValue({ entries: ["only"] });
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.navigateUp("draft");
    });
    let res: string | null = null;
    act(() => {
      res = result.current.navigateUp("only");
    });
    expect(res).toBeNull();
    expect(result.current.historyIndex).toBe(0);
  });

  it("addEntry prepends to local history and sends via WS", async () => {
    mockSendRequest.mockResolvedValue({ entries: ["old"] });
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.addEntry("new command");
    });

    // Should have called sendRequest for the add
    expect(mockSendRequest).toHaveBeenCalledTimes(2); // 1 for get, 1 for add
    expect(result.current.historyIndex).toBe(-1);
  });

  it("addEntry ignores empty strings", () => {
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    act(() => {
      result.current.addEntry("   ");
    });
    // Only the initial fetch, no add call
    expect(mockSendRequest).toHaveBeenCalledTimes(1);
  });

  it("resetNavigation resets historyIndex to -1", async () => {
    mockSendRequest.mockResolvedValue({ entries: ["first"] });
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.navigateUp("draft");
    });
    expect(result.current.historyIndex).toBe(0);
    act(() => {
      result.current.resetNavigation();
    });
    expect(result.current.historyIndex).toBe(-1);
  });

  it("resetNavigation is no-op when not browsing", () => {
    const { result } = renderHook(() => usePromptHistory(1, "ws-test-1"));
    act(() => {
      result.current.resetNavigation();
    });
    expect(result.current.historyIndex).toBe(-1);
  });
});
