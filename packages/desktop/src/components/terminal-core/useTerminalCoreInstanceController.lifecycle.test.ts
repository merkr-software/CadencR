// @vitest-environment happy-dom
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, createRef } from "react";
import type { TerminalTransport } from "celeritty";
import type { UseTerminalWebSocketOptions } from "@/hooks/useTerminalWebSocket";

const mocks = vi.hoisted(() => ({
  paste: vi.fn(),
  socket: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    forgetPty: vi.fn(),
    isConnected: true,
  },
  terminal: { write: vi.fn(), on: vi.fn(() => vi.fn()), focus: vi.fn(), blur: vi.fn() },
  callbacks: null as UseTerminalWebSocketOptions | null,
  transport: undefined as TerminalTransport | undefined,
  engineReady: false,
  optionsError: null as string | null,
}));

vi.mock("./terminal-paste", () => ({ pasteTerminalText: mocks.paste }));
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
import type { TerminalCoreInstanceHandle } from "./TerminalCoreInstance.types";
import {
  getLeaves,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { flatLayoutState, ROOT_LEAF_ID } from "@/stores/feature-layout-schema";
import { makeLeaf } from "@/stores/feature-layout-tree";

const FEATURE = 1;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.socket.write.mockReturnValue(true);
  mocks.socket.isConnected = true;
  mocks.engineReady = false;
  mocks.optionsError = null;
  mocks.transport = undefined;
  useFeatureLayoutStore.setState({ features: {} });
});
afterEach(() => vi.useRealTimers());

describe("shell terminal startup and reconnect", () => {
  it("routes clipboard actions through native input rather than raw socket writes", () => {
    const ref = createRef<TerminalCoreInstanceHandle>();
    const { result } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: 1, projectId: 2 }, ref),
    );
    const host = document.createElement("div");
    result.current.hostRef.current = host;
    ref.current?.paste("clipboard\ntext");
    expect(mocks.paste).toHaveBeenCalledExactlyOnceWith(host, "clipboard\ntext");
    expect(mocks.socket.write).not.toHaveBeenCalled();
  });
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

describe("focus deferral while the engine loads", () => {
  it("defers a focus requested before the engine instance exists and flushes it on ready", () => {
    const ref = createRef<TerminalCoreInstanceHandle>();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: 1, projectId: 2 }, ref),
    );
    // Engine still loading (fresh pane): the handle exists but `t` is undefined.
    act(() => ref.current?.focus());
    expect(mocks.terminal.focus).not.toHaveBeenCalled();
    mocks.engineReady = true;
    rerender();
    expect(mocks.terminal.focus).toHaveBeenCalledOnce();
  });

  it("focuses immediately once the engine instance exists", () => {
    mocks.engineReady = true;
    const ref = createRef<TerminalCoreInstanceHandle>();
    renderHook(() => useTerminalCoreInstanceController({ featureId: 1, projectId: 2 }, ref));
    act(() => ref.current?.focus());
    expect(mocks.terminal.focus).toHaveBeenCalledOnce();
  });

  it("does not refocus on later renders when no focus was requested", () => {
    const ref = createRef<TerminalCoreInstanceHandle>();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: 1, projectId: 2 }, ref),
    );
    rerender();
    mocks.engineReady = true;
    rerender();
    expect(mocks.terminal.focus).not.toHaveBeenCalled();
  });

  it("cancels a pending focus when the pane is blurred before the engine is ready", () => {
    const ref = createRef<TerminalCoreInstanceHandle>();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: 1, projectId: 2 }, ref),
    );
    act(() => ref.current?.focus());
    act(() => ref.current?.blur());
    mocks.engineReady = true;
    rerender();
    expect(mocks.terminal.focus).not.toHaveBeenCalled();
  });

  it("forwards blur to the engine once it exists", () => {
    mocks.engineReady = true;
    const ref = createRef<TerminalCoreInstanceHandle>();
    renderHook(() => useTerminalCoreInstanceController({ featureId: 1, projectId: 2 }, ref));
    act(() => ref.current?.blur());
    expect(mocks.terminal.blur).toHaveBeenCalledOnce();
  });

  it("cancels a pending focus when the layout moves focus to another pane before the engine is ready", () => {
    // Split the terminal into its own pane so the editor pane is a separate
    // layout leaf — the split-layout case the reviewer flagged.
    useFeatureLayoutStore.getState().splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const ref = createRef<TerminalCoreInstanceHandle>();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: FEATURE, projectId: 2 }, ref),
    );
    // Terminal tab is active and focused: a focus request is deferred.
    act(() => ref.current?.focus());
    expect(mocks.terminal.focus).not.toHaveBeenCalled();
    // User clicks the editor pane while the terminal engine is still loading.
    act(() => {
      useFeatureLayoutStore.getState().setFocusedPane(FEATURE, ROOT_LEAF_ID);
      useFeatureLayoutStore.getState().setPaneActiveTab(FEATURE, ROOT_LEAF_ID, "editor");
    });
    // Engine becomes ready — the pending focus must not fire.
    mocks.engineReady = true;
    rerender();
    expect(mocks.terminal.focus).not.toHaveBeenCalled();
  });

  it("cancels a pending focus when a layout hydrates with the editor focused before the engine is ready", () => {
    // The reviewer's hydration scenario: the controller starts with no layout
    // state for the feature, a focus request is deferred, then the split
    // layout hydrates atomically with the editor pane focused. The
    // transition from no layout has no previous terminal leaf, so the
    // cancel condition must key off the next focused leaf alone.
    const ref = createRef<TerminalCoreInstanceHandle>();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: FEATURE, projectId: 2 }, ref),
    );
    // Engine still loading: the focus request is deferred.
    act(() => ref.current?.focus());
    expect(mocks.terminal.focus).not.toHaveBeenCalled();
    // Hydrate the split layout atomically: terminal in one leaf, editor
    // visible and focused in the other.
    act(() => {
      useFeatureLayoutStore.getState().setState(FEATURE, {
        ...flatLayoutState(),
        splitRoot: {
          type: "split",
          orientation: "horizontal",
          children: [
            {
              type: "leaf",
              id: ROOT_LEAF_ID,
              tabIds: ["agent", "editor"],
              activeTabId: "editor",
            },
            makeLeaf(["terminal"], "terminal"),
          ],
          sizes: [50, 50],
        },
        focusedPaneId: ROOT_LEAF_ID,
      });
    });
    // Engine becomes ready — the pending focus must not fire.
    mocks.engineReady = true;
    rerender();
    expect(mocks.terminal.focus).not.toHaveBeenCalled();
  });

  it("still flushes a pending focus when the layout has no state for the feature", () => {
    // No layout state for FEATURE: `getFocusedLeaf` returns null on the empty
    // fallback, so the subscription must not cancel the pending request.
    const ref = createRef<TerminalCoreInstanceHandle>();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: FEATURE, projectId: 2 }, ref),
    );
    act(() => ref.current?.focus());
    mocks.engineReady = true;
    rerender();
    expect(mocks.terminal.focus).toHaveBeenCalledOnce();
  });

  it("does not cancel a pending focus when layout focus stays on a terminal pane", () => {
    // The subscription only cancels when focus leaves the terminal entirely
    // (`wasTerminal && !isTerminal`). A store change that keeps the terminal
    // pane focused must not cancel the pending request.
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const terminalPane = getLeaves(
      selectFeatureLayout(FEATURE)(useFeatureLayoutStore.getState()).splitRoot,
    ).find((l) => l.id !== ROOT_LEAF_ID)!;
    const ref = createRef<TerminalCoreInstanceHandle>();
    const { rerender } = renderHook(() =>
      useTerminalCoreInstanceController({ featureId: FEATURE, projectId: 2 }, ref),
    );
    act(() => ref.current?.focus());
    // Resize the root split: a real store change, so the subscription fires
    // with wasTerminal && isTerminal. A no-op `setFocusedPane` with the
    // current id would leave the store unchanged and never call it, letting
    // this test pass even if the subscription cancelled unconditionally.
    act(() => {
      useFeatureLayoutStore.getState().setSplitSizes(FEATURE, [], [60, 40]);
    });
    expect(selectFeatureLayout(FEATURE)(useFeatureLayoutStore.getState()).focusedPaneId).toBe(
      terminalPane.id,
    );
    mocks.engineReady = true;
    rerender();
    expect(mocks.terminal.focus).toHaveBeenCalledOnce();
  });
});
