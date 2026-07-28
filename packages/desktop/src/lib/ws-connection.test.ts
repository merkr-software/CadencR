import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWsConnection } from "./ws-connection";

// ---------------------------------------------------------------------------
// Mock WebSocket
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

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  simulateMessage(data: string) {
    this.emit("message", { data });
  }

  simulateError() {
    this.emit("error", {});
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }
}

const origWebSocket = globalThis.WebSocket;

function lastWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = origWebSocket;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWsConnection", () => {
  it("creates a WebSocket with the given URL", () => {
    createWsConnection({ url: "ws://localhost/test", onMessage: vi.fn() });
    expect(lastWs().url).toBe("ws://localhost/test");
  });

  it("calls onOpen when WebSocket opens", () => {
    const onOpen = vi.fn();
    createWsConnection({ url: "ws://x", onOpen, onMessage: vi.fn() });
    lastWs().simulateOpen();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("calls onMessage with raw data string", () => {
    const onMessage = vi.fn();
    createWsConnection({ url: "ws://x", onMessage });
    lastWs().simulateOpen();
    lastWs().simulateMessage('{"type":"hello"}');
    expect(onMessage).toHaveBeenCalledWith('{"type":"hello"}');
  });

  it("calls onClose with intentional=false for unexpected close", () => {
    const onClose = vi.fn();
    createWsConnection({ url: "ws://x", onClose, onMessage: vi.fn() });
    lastWs().simulateClose();
    expect(onClose).toHaveBeenCalledWith(false, expect.anything());
  });

  it("calls onClose with intentional=true after close() is called", () => {
    const onClose = vi.fn();
    const conn = createWsConnection({ url: "ws://x", onClose, onMessage: vi.fn() });
    lastWs().simulateOpen();
    conn.close();
    expect(onClose).toHaveBeenCalledWith(true, expect.anything());
  });

  it("calls onError with intentional flag", () => {
    const onError = vi.fn();
    createWsConnection({ url: "ws://x", onError, onMessage: vi.fn() });
    lastWs().simulateError();
    expect(onError).toHaveBeenCalledWith(false);
  });

  describe("send / sendJson", () => {
    it("sends raw string when WebSocket is open", () => {
      const conn = createWsConnection({ url: "ws://x", onMessage: vi.fn() });
      lastWs().simulateOpen();
      expect(conn.send("hello")).toBe(true);
      expect(lastWs().sent).toEqual(["hello"]);
    });

    it("returns false when WebSocket is not open", () => {
      const conn = createWsConnection({ url: "ws://x", onMessage: vi.fn() });
      expect(conn.send("hello")).toBe(false);
      expect(lastWs().sent).toEqual([]);
    });

    it("sendJson serializes and sends", () => {
      const conn = createWsConnection({ url: "ws://x", onMessage: vi.fn() });
      lastWs().simulateOpen();
      expect(conn.sendJson({ type: "ping" })).toBe(true);
      expect(lastWs().sent).toEqual(['{"type":"ping"}']);
    });
  });

  describe("isOpen / isConnecting", () => {
    it("isConnecting is true initially", () => {
      const conn = createWsConnection({ url: "ws://x", onMessage: vi.fn() });
      expect(conn.isConnecting()).toBe(true);
      expect(conn.isOpen()).toBe(false);
    });

    it("isOpen is true after open", () => {
      const conn = createWsConnection({ url: "ws://x", onMessage: vi.fn() });
      lastWs().simulateOpen();
      expect(conn.isOpen()).toBe(true);
      expect(conn.isConnecting()).toBe(false);
    });
  });

  it("close is safe to call multiple times", () => {
    const conn = createWsConnection({ url: "ws://x", onMessage: vi.fn() });
    lastWs().simulateOpen();
    conn.close();
    conn.close(); // should not throw
  });
});
