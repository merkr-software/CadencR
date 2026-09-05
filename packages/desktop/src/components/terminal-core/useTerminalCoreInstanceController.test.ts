import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { renderHook, act } from "@testing-library/react";

// -- celeritty --------------------------------------------------------------
// The controller constructs a `Terminal` only once its host element is
// mounted; in a bare `renderHook` (no real DOM host attached) that never
// happens, so this stub only needs to satisfy the type import.
vi.mock("celeritty", () => ({
  Terminal: class {
    ready = Promise.resolve();
  },
}));

// -- terminal options (alacritty config) -------------------------------------
// Resolved synchronously so the controller isn't stuck in a loading state.
vi.mock("@/api/generated", () => ({
  useAlacrittyConfigRoute: () => ({
    data: {
      config: {},
      found: false,
      parse_error: null,
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/ws-url", () => ({
  getTerminalWsUrl: () => "ws://localhost:5005/api/terminal/ws",
  getWsUrl: () => "ws://localhost:5005/ws",
  getWsProtocols: () => [],
}));

import { useTerminalCoreInstanceController } from "./useTerminalCoreInstanceController";
import type { TerminalCoreInstanceProps } from "./TerminalCoreInstance.types";

// ---------------------------------------------------------------------------
// Mock WebSocket — same shape as useTerminalWebSocket.test.ts's, since the
// controller's `mountedRef` bug lives downstream of the real socket hook.
// ---------------------------------------------------------------------------

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];

  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  private emit(type: string, event: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: code ?? 1000 });
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  simulateMessage(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) });
  }
}

const origWebSocket = globalThis.WebSocket;

function lastWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

function defaultProps(overrides?: Partial<TerminalCoreInstanceProps>): TerminalCoreInstanceProps {
  return {
    featureId: 1,
    projectId: 2,
    ...overrides,
  };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = origWebSocket;
});

describe("useTerminalCoreInstanceController — mountedRef across a remount", () => {
  it("does not kill the PTY when `ready` arrives after StrictMode's mount-cleanup-remount", () => {
    const props = defaultProps();

    // React.StrictMode makes React itself run: mount -> run all effect
    // cleanups -> mount again, on the *same* component instance (same
    // `useRef`s). That's exactly the condition the bug depended on:
    // `refs` (from `useCoreRefs`) survives the cycle, and `mountedRef` used
    // to be cleared by the simulated cleanup and never re-armed.
    const { unmount } = renderHook(() => useTerminalCoreInstanceController(props, null), {
      wrapper: StrictMode,
    });

    // Two WebSockets open: the simulated first pass, then the kept remount.
    expect(MockWebSocket.instances.length).toBe(2);
    const ws = lastWs();

    act(() => ws.simulateOpen());
    act(() => ws.simulateMessage({ type: "ready", pty_id: "pty-b", cwd: "/work/project" }));

    // Before the fix, `mountedRef.current` was still `false` here, so `onReady`
    // called `connection.kill()` and never marked the pane ready.
    const sent = ws.sent.map((s) => JSON.parse(s));
    expect(sent).not.toContainEqual({ type: "kill" });

    unmount();
  });
});
