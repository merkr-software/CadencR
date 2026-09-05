import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { TerminalTransport } from "celeritty";
import type { UseTerminalWebSocketOptions } from "@/hooks/useTerminalWebSocket";

const mocks = vi.hoisted(() => ({
  socket: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    forgetPty: vi.fn(),
    isConnected: true,
  },
  terminal: { write: vi.fn(), on: vi.fn(() => vi.fn()) },
  callbacks: null as UseTerminalWebSocketOptions | null,
  transport: undefined as TerminalTransport | undefined,
  engineReady: false,
  optionsError: null as string | null,
}));

vi.mock("./useTerminalOptions", () => ({
  useTerminalOptions: () => ({
    options: mocks.optionsError ? undefined : {},
    isLoading: false,
    error: mocks.optionsError,
  }),
}));
vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: (callbacks: UseTerminalWebSocketOptions) => {
    mocks.callbacks = callbacks;
    return { ...mocks.socket };
  },
}));
vi.mock("./useCelerittyTerminal", () => ({
  useCelerittyTerminal: ({ transport }: { transport?: TerminalTransport }) => {
    mocks.transport = transport;
    return {
      terminal: mocks.engineReady ? mocks.terminal : undefined,
      status: mocks.engineReady ? "ready" : "loading",
      errorMessage: null,
    };
  },
}));
vi.mock("@/components/links/LinkRoutingContext", () => ({ useLinkRouting: () => null }));

import { useTerminalCoreInstanceController } from "./useTerminalCoreInstanceController";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.socket.write.mockReturnValue(true);
  mocks.socket.isConnected = true;
  mocks.engineReady = false;
  mocks.optionsError = null;
  mocks.transport = undefined;
});
afterEach(() => vi.useRealTimers());

describe("shell terminal startup and reconnect", () => {
  it("delivers startup output and replays reconnects without rebuilding the transport", async () => {
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: 1, projectId: 2 }, null),
    );
    act(() => {
      mocks.callbacks?.onReady("pty", "/work");
      mocks.callbacks?.onData("startup prompt");
    });
    const transport = mocks.transport;
    const output: string[] = [];
    mocks.engineReady = true;
    rerender();
    transport?.onData((bytes) => output.push(new TextDecoder().decode(bytes)));
    await act(async () => {});
    expect(output.join("")).toBe("startup prompt");
    const close = vi.fn();
    transport?.onClose(close);
    act(() => mocks.callbacks?.onError("Reconnecting", "transport"));
    expect(close).not.toHaveBeenCalled();
    act(() => mocks.callbacks?.onReconnected("startup prompt plus offline output", true, "/work"));
    expect(mocks.transport).toBe(transport);
    expect(output.join("")).toBe("startup prompt\x1bcstartup prompt plus offline output");
  });

  it("does not consume an initial command when its timer is cancelled by a disconnect", () => {
    vi.useFakeTimers();
    mocks.engineReady = true;
    const consumed = vi.fn();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController(
        {
          featureId: 1,
          projectId: 2,
          initialCommand: "npm run dev\n",
          onInitialCommandConsumed: consumed,
        },
        null,
      ),
    );
    act(() => mocks.callbacks?.onReady("pty", "/work"));
    act(() => vi.advanceTimersByTime(100));
    mocks.socket.isConnected = false;
    rerender();
    act(() => vi.advanceTimersByTime(500));
    expect(consumed).not.toHaveBeenCalled();
    expect(mocks.socket.write).not.toHaveBeenCalled();
    mocks.socket.isConnected = true;
    rerender();
    act(() => vi.advanceTimersByTime(150));
    expect(mocks.socket.write).toHaveBeenCalledExactlyOnceWith("npm run dev\n");
    expect(consumed).toHaveBeenCalledOnce();
    rerender();
    act(() => vi.advanceTimersByTime(500));
    expect(mocks.socket.write).toHaveBeenCalledOnce();
  });

  it("does not consume the startup command when the socket refuses the write", () => {
    vi.useFakeTimers();
    mocks.engineReady = true;
    mocks.socket.write.mockReturnValueOnce(false);
    const consumed = vi.fn();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController(
        {
          featureId: 1,
          projectId: 2,
          initialCommand: "start\n",
          onInitialCommandConsumed: consumed,
        },
        null,
      ),
    );
    act(() => mocks.callbacks?.onReady("pty", "/work"));
    act(() => vi.advanceTimersByTime(150));
    expect(consumed).not.toHaveBeenCalled();
    rerender();
    act(() => vi.advanceTimersByTime(150));
    expect(consumed).toHaveBeenCalledOnce();
  });

  it("reports focus from an inner terminal input", () => {
    mocks.engineReady = true;
    const onTerminalFocus = vi.fn();
    function Fixture() {
      const { hostRef } = useTerminalCoreInstanceController(
        {
          featureId: 1,
          projectId: 2,
          onTerminalFocus,
        },
        null,
      );
      return createElement("div", { ref: hostRef }, createElement("textarea"));
    }
    render(createElement(Fixture));
    act(() => screen.getByRole("textbox").focus());
    expect(onTerminalFocus).toHaveBeenCalledOnce();
  });

  it.each(["Config request failed", "Invalid Alacritty TOML"])(
    "surfaces options errors without spawning a PTY: %s",
    (message) => {
      mocks.optionsError = message;
      const { result } = renderHook(() =>
        useTerminalCoreInstanceController({ featureId: 1, projectId: 2 }, null),
      );
      expect(result.current.status).toBe("error");
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBe(message);
      expect(mocks.socket.connect).not.toHaveBeenCalled();
    },
  );
});
