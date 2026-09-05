import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/ws-url", () => ({
  getWsUrl: () => "ws://localhost:5005/ws",
  getTerminalWsUrl: () => "ws://localhost:5005/api/terminal/ws",
  getWsProtocols: () => [],
}));

import { useTerminalWebSocket } from "./useTerminalWebSocket";
import type { UseTerminalWebSocketOptions } from "./useTerminalWebSocket";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Mock WebSocket — supports onXxx property-style handlers used by the hook
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

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  simulateMessage(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) });
  }

  simulateRawMessage(raw: string) {
    this.emit("message", { data: raw });
  }

  simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code });
  }

  simulateError() {
    this.emit("error", {});
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const origWebSocket = globalThis.WebSocket;

function lastWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

function defaultOptions(
  overrides?: Partial<UseTerminalWebSocketOptions>,
): UseTerminalWebSocketOptions {
  return {
    featureId: 1,
    projectId: 2,
    onData: vi.fn(),
    onExit: vi.fn(),
    onReady: vi.fn(),
    onReconnected: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

/** Render hook and connect with default dimensions */
function renderAndConnect(opts?: Partial<UseTerminalWebSocketOptions>, cols = 80, rows = 24) {
  const hook = renderHook(() => useTerminalWebSocket(defaultOptions(opts)));
  act(() => hook.result.current.connect(cols, rows));
  return hook;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.WebSocket = origWebSocket;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTerminalWebSocket", () => {
  it("builds WS URL with featureId, projectId, and dimensions", () => {
    renderAndConnect({}, 120, 40);
    expect(lastWs().url).toContain("feature_id=1");
    expect(lastWs().url).toContain("project_id=2");
    expect(lastWs().url).toContain("cols=120");
    expect(lastWs().url).toContain("rows=40");
  });

  it("builds WS URL with ptyId for reconnection (no cols/rows)", () => {
    renderAndConnect({ ptyId: "abc-123", featureId: 1, projectId: undefined });
    expect(lastWs().url).toContain("pty_id=abc-123");
    expect(lastWs().url).toContain("feature_id=1");
    expect(lastWs().url).not.toContain("cols=");
  });

  it("does not create WS until connect() is called", () => {
    renderHook(() => useTerminalWebSocket(defaultOptions()));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("sets isConnected to true on open", () => {
    const { result } = renderAndConnect();
    expect(result.current.isConnected).toBe(false);
    act(() => lastWs().simulateOpen());
    expect(result.current.isConnected).toBe(true);
  });

  it("dispatches data messages to onData callback", () => {
    const onData = vi.fn();
    renderAndConnect({ onData });
    act(() => lastWs().simulateOpen());
    act(() => lastWs().simulateMessage({ type: "data", data: "hello" }));
    expect(onData).toHaveBeenCalledWith("hello");
  });

  it("dispatches ready messages to onReady callback with cwd", () => {
    const onReady = vi.fn();
    renderAndConnect({ onReady });
    act(() => lastWs().simulateOpen());
    act(() => lastWs().simulateMessage({ type: "ready", pty_id: "pty-1", cwd: "/work/project" }));
    expect(onReady).toHaveBeenCalledWith("pty-1", "/work/project");
  });

  it("dispatches exit messages to onExit callback", () => {
    const onExit = vi.fn();
    renderAndConnect({ onExit });
    act(() => lastWs().simulateOpen());
    act(() => lastWs().simulateMessage({ type: "exit", code: 0 }));
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("dispatches reconnected messages to onReconnected callback with cwd", () => {
    const onReconnected = vi.fn();
    renderAndConnect({ onReconnected });
    act(() => lastWs().simulateOpen());
    act(() =>
      lastWs().simulateMessage({
        type: "reconnected",
        scrollback: "old data",
        alive: true,
        cwd: "/work/project",
      }),
    );
    expect(onReconnected).toHaveBeenCalledWith("old data", true, "/work/project");
  });

  it("propagates a null cwd from reconnected when the backend handle is gone", () => {
    const onReconnected = vi.fn();
    renderAndConnect({ onReconnected });
    act(() => lastWs().simulateOpen());
    act(() =>
      lastWs().simulateMessage({
        type: "reconnected",
        scrollback: "",
        alive: false,
        cwd: null,
      }),
    );
    expect(onReconnected).toHaveBeenCalledWith("", false, null);
  });

  it("dispatches error messages to onError callback", () => {
    const onError = vi.fn();
    renderAndConnect({ onError });
    act(() => lastWs().simulateOpen());
    act(() => lastWs().simulateMessage({ type: "error", message: "bad" }));
    expect(onError).toHaveBeenCalledWith("bad", "protocol");
  });

  it("sends write/resize/kill JSON when WS is open", () => {
    const { result } = renderAndConnect();
    act(() => lastWs().simulateOpen());

    act(() => result.current.write("ls\n"));
    act(() => result.current.resize(80, 24));
    act(() => result.current.kill());

    const sent = lastWs().sent.map((s) => JSON.parse(s));
    expect(sent).toEqual([
      { type: "write", data: "ls\n" },
      { type: "resize", cols: 80, rows: 24 },
      { type: "kill" },
    ]);
  });

  it("does not send when WS is not open", () => {
    // This path intentionally emits `console.warn("[terminal] dropped write")` —
    // suppress it locally so the assertion-passing test doesn't pollute output.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderAndConnect();
    // WS is still CONNECTING, not OPEN
    act(() => result.current.write("hello"));
    expect(lastWs().sent).toHaveLength(0);
    warnSpy.mockRestore();
  });

  describe("intentional close suppression", () => {
    it("does not fire onError when WS closes due to unmount", () => {
      const onError = vi.fn();
      const { unmount } = renderAndConnect({ onError });
      act(() => lastWs().simulateOpen());

      unmount();

      expect(onError).not.toHaveBeenCalled();
    });

    it("does not fire toast on unmount-driven WS error", () => {
      const { unmount } = renderAndConnect();
      const ws = lastWs();
      unmount();
      act(() => ws.simulateError());

      expect(toast.error).not.toHaveBeenCalled();
    });

    it("writes a 'Reconnecting…' message on unexpected close (server disconnect)", () => {
      const onError = vi.fn();
      renderAndConnect({ onError });
      act(() => lastWs().simulateOpen());
      act(() => lastWs().simulateClose(1006));
      expect(onError).toHaveBeenCalledWith("Connection lost. Reconnecting…", "transport");
    });
  });

  describe("connection stability", () => {
    it("does not reconnect when options change after mount", () => {
      const opts = defaultOptions();
      const { result, rerender } = renderHook((props) => useTerminalWebSocket(props), {
        initialProps: opts,
      });

      act(() => result.current.connect(80, 24));
      expect(MockWebSocket.instances).toHaveLength(1);

      rerender({ ...opts, ptyId: "new-pty", featureId: undefined, projectId: undefined });

      // Should still be only 1 WebSocket — no reconnection
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  it("uses latest callbacks via optionsRef (no stale closures)", () => {
    const onData1 = vi.fn();
    const onData2 = vi.fn();
    const opts = defaultOptions({ onData: onData1 });
    const { result, rerender } = renderHook((props) => useTerminalWebSocket(props), {
      initialProps: opts,
    });
    act(() => result.current.connect(80, 24));
    act(() => lastWs().simulateOpen());

    // Update callback
    rerender({ ...opts, onData: onData2 });

    act(() => lastWs().simulateMessage({ type: "data", data: "hello" }));
    expect(onData1).not.toHaveBeenCalled();
    expect(onData2).toHaveBeenCalledWith("hello");
  });

  it("calls onError for unparseable messages", () => {
    const onError = vi.fn();
    renderAndConnect({ onError });
    act(() => lastWs().simulateOpen());
    act(() => lastWs().simulateRawMessage("not json"));
    expect(onError).toHaveBeenCalledWith("Failed to parse terminal message", "protocol");
  });

  it("closes WS on unmount", () => {
    const { unmount } = renderAndConnect();
    const ws = lastWs();
    act(() => ws.simulateOpen());
    unmount();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("exposes disconnect() that closes the WS without sending kill", () => {
    const { result } = renderAndConnect();
    const ws = lastWs();
    act(() => ws.simulateOpen());
    act(() => result.current.disconnect());
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    const sent = ws.sent.map((s) => JSON.parse(s));
    expect(sent).not.toEqual(expect.arrayContaining([{ type: "kill" }]));
  });
});
