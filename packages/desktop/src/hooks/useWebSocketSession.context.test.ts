// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@/api/generated", () => ({
  useGetFeatureAgentState: vi.fn(() => ({ data: undefined, isLoading: false })),
  getGetFeatureQueryKey: (id: number) => ["features", "detail", id],
  getGetFeatureSettingsQueryKey: (id: number) => ["features", "settings", id],
}));

import { useWebSocketSession } from "./useWebSocketSession";
import { useWsSessionStore } from "@/stores/ws-session-store";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    Promise.resolve().then(() => this.fireEvent("open"));
  }

  addEventListener(event: string, cb: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }

  removeEventListener(): void {}

  send(_data: string): void {}

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  private fireEvent(event: string, data?: unknown): void {
    for (const cb of this.listeners[event] ?? []) {
      cb(data ?? {});
    }
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }
}

beforeEach(() => {
  MockWebSocket.reset();
  useWsSessionStore.setState({ sessions: {} });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("window", { ...globalThis.window });
});

afterEach(() => {
  const store = useWsSessionStore.getState();
  for (const sessionId of Object.keys(store.sessions)) {
    store.disconnect(sessionId);
  }
  vi.restoreAllMocks();
});

describe("useWebSocketSession context usage hydration", () => {
  it("hydrates persisted context usage when tokens are zero but the window is known", async () => {
    const { useGetFeatureAgentState } = await import("@/api/generated");
    (useGetFeatureAgentState as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        sessions: [
          {
            status: "idle",
            blocks: [],
            inputTokens: 0,
            outputTokens: 0,
            contextWindow: 1_000_000,
            wasCompacted: false,
          },
        ],
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useWebSocketSession("hydrate-zero-window", 55));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.contextUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      contextWindow: 1_000_000,
      wasCompacted: false,
    });
  });
});
