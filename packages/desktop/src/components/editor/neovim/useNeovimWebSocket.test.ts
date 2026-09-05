import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendJsonMock = vi.fn(() => true);
const closeMock = vi.fn();
let capturedHandlers: {
  onOpen?: () => void;
  onMessage?: (data: string) => void;
  onClose?: (intentional: boolean, event: CloseEvent) => void;
  onError?: (intentional: boolean) => void;
} = {};

vi.mock("@/lib/ws-connection", () => ({
  createWsConnection: (options: typeof capturedHandlers) => {
    capturedHandlers = options;
    return {
      send: vi.fn(() => true),
      sendJson: sendJsonMock,
      close: closeMock,
      isOpen: () => true,
      isConnecting: () => false,
    };
  },
}));

vi.mock("@/lib/ws-url", () => ({
  getNeovimWsUrl: () => "ws://127.0.0.1:5005/api/neovim/ws",
  getWsProtocols: () => ["cadencr-token.test"],
}));

vi.mock("@/lib/ws-reconnect", () => ({
  scheduleReconnect: vi.fn(),
  registerReconnector: vi.fn(),
  unregisterReconnector: vi.fn(),
  resetReconnectState: vi.fn(),
}));

vi.mock("@/stores/connection-status-store", () => ({
  useConnectionStatusStore: { getState: () => ({ reportSource: vi.fn(), clearSource: vi.fn() }) },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

const { useNeovimWebSocket } = await import("./useNeovimWebSocket");

describe("useNeovimWebSocket", () => {
  beforeEach(() => {
    sendJsonMock.mockClear();
    closeMock.mockClear();
    capturedHandlers = {};
  });
  afterEach(() => vi.clearAllMocks());

  it("is disconnected until connect() is called", () => {
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData: vi.fn(), onAttached: vi.fn(), onError: vi.fn() }),
    );
    expect(result.current.isConnected).toBe(false);
  });

  it("reports connected once the socket opens", () => {
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData: vi.fn(), onAttached: vi.fn(), onError: vi.fn() }),
    );
    act(() => result.current.connect());
    act(() => capturedHandlers.onOpen?.());
    expect(result.current.isConnected).toBe(true);
  });

  it("decodes an incoming data message into bytes and forwards it", () => {
    const onData = vi.fn();
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData, onAttached: vi.fn(), onError: vi.fn() }),
    );
    act(() => result.current.connect());
    act(() => capturedHandlers.onMessage?.(JSON.stringify({ type: "data", data: "hello" })));
    expect(onData).toHaveBeenCalledWith(new TextEncoder().encode("hello"));
  });

  it("decodes the attached scrollback into bytes", () => {
    const onAttached = vi.fn();
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData: vi.fn(), onAttached, onError: vi.fn() }),
    );
    act(() => result.current.connect());
    act(() =>
      capturedHandlers.onMessage?.(
        JSON.stringify({ type: "attached", scrollback: "prior output" }),
      ),
    );
    expect(onAttached).toHaveBeenCalledWith(new TextEncoder().encode("prior output"));
  });

  it("forwards a server error message", () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData: vi.fn(), onAttached: vi.fn(), onError }),
    );
    act(() => result.current.connect());
    act(() => capturedHandlers.onMessage?.(JSON.stringify({ type: "error", message: "boom" })));
    expect(onError).toHaveBeenCalledWith("boom");
  });

  it("encodes outgoing bytes as a JSON string before sending", () => {
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData: vi.fn(), onAttached: vi.fn(), onError: vi.fn() }),
    );
    act(() => result.current.connect());
    act(() => result.current.write(new TextEncoder().encode("abc")));
    expect(sendJsonMock).toHaveBeenCalledWith({ type: "write", data: "abc" });
  });

  it("sends a resize message", () => {
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData: vi.fn(), onAttached: vi.fn(), onError: vi.fn() }),
    );
    act(() => result.current.connect());
    act(() => result.current.resize(80, 24));
    expect(sendJsonMock).toHaveBeenCalledWith({ type: "resize", cols: 80, rows: 24 });
  });

  it("reports a write dropped when the socket refuses to send", () => {
    sendJsonMock.mockReturnValueOnce(false);
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData: vi.fn(), onAttached: onError, onError }),
    );
    act(() => result.current.connect());
    act(() => result.current.write(new TextEncoder().encode("x")));
    expect(onError).toHaveBeenCalled();
  });

  it("closes the connection on detach", () => {
    const { result } = renderHook(() =>
      useNeovimWebSocket({ featureId: 1, onData: vi.fn(), onAttached: vi.fn(), onError: vi.fn() }),
    );
    act(() => result.current.connect());
    act(() => result.current.detach());
    expect(closeMock).toHaveBeenCalled();
  });
});
