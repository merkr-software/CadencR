// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppCloseRequest } from "@/shared/app-close";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
  type CadencrBrowserBridge,
} from "@/lib/desktop-bridge";
import { useSessionStatusStore, type SessionStatusEntry } from "@/stores/session-status-store";

const shortcuts = vi.hoisted(() => new Map<string, (event: KeyboardEvent) => void>());
vi.mock("@/hooks/useShortcut", () => ({
  useGlobalShortcutById: (id: string, callback: (event: KeyboardEvent) => void) => {
    shortcuts.set(id, callback);
  },
}));

const targets = vi.hoisted(() => ({ loaded: [] as string[], unreachable: 0 }));
vi.mock("@/stores/busy-session-targets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/busy-session-targets")>()),
  busySessionTargets: () => targets,
}));

const interrupt = vi.hoisted(() => vi.fn());
vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: { getState: () => ({ interrupt, sessions: {} }) },
}));

const { interruptDevAgents, useAppClose } = await import("@/hooks/useAppClose");

function working(status: SessionStatusEntry["status"]): SessionStatusEntry {
  return { status, kind: null, featureId: 3, seq: 1 };
}

function bridge() {
  let onCloseRequested: (request: AppCloseRequest) => void = () => undefined;
  const mock = {
    isElectron: true,
    onCloseRequested: vi.fn((callback: (request: AppCloseRequest) => void) => {
      onCloseRequested = callback;
      return () => undefined;
    }),
    confirmClose: vi.fn(() => Promise.resolve()),
    acknowledgeCloseRequest: vi.fn(() => Promise.resolve()),
    cancelClose: vi.fn(() => Promise.resolve()),
    requestQuit: vi.fn(() => Promise.resolve()),
    windowClose: vi.fn(() => Promise.resolve()),
  } satisfies Partial<CadencrBrowserBridge>;
  setDesktopBridgeOverrideForTests(mock);
  return { mock, ask: (request: AppCloseRequest) => act(() => onCloseRequested(request)) };
}

function shortcut(id: string): void {
  shortcuts.get(id)?.(new KeyboardEvent("keydown"));
}

beforeEach(() => {
  shortcuts.clear();
  targets.loaded = [];
  targets.unreachable = 0;
  interrupt.mockClear();
  useSessionStatusStore.setState({ bySession: {} });
});

afterEach(() => {
  clearDesktopBridgeOverrideForTests();
  vi.restoreAllMocks();
});

describe("useAppClose", () => {
  it("confirms at once when no agent is working", () => {
    const { mock, ask } = bridge();
    const { result } = renderHook(() => useAppClose(new QueryClient(), null));

    ask({ quitting: true });

    expect(mock.confirmClose).toHaveBeenCalledWith();
    expect(mock.acknowledgeCloseRequest).not.toHaveBeenCalled();
    expect(result.current.request).toBeNull();
  });

  it("tells main the confirmation is shown, then that it was cancelled", () => {
    useSessionStatusStore.setState({ bySession: { 9: working("agent") } });
    const { mock, ask } = bridge();
    const { result } = renderHook(() => useAppClose(new QueryClient(), null));

    ask({ quitting: true });
    expect(result.current.request).toEqual({ quitting: true });
    expect(mock.acknowledgeCloseRequest).toHaveBeenCalledTimes(1);

    act(() => result.current.cancel());

    expect(result.current.request).toBeNull();
    expect(mock.cancelClose).toHaveBeenCalledTimes(1);
    expect(mock.confirmClose).not.toHaveBeenCalled();
  });

  it("closes the window through main on ⌘W instead of deciding what it does", () => {
    const { mock } = bridge();
    renderHook(() => useAppClose(new QueryClient(), null));

    shortcut("app-close");

    expect(mock.windowClose).toHaveBeenCalledTimes(1);
    expect(mock.confirmClose).not.toHaveBeenCalled();
  });

  it("surfaces a confirmation main rejected", async () => {
    const { mock, ask } = bridge();
    mock.confirmClose.mockRejectedValueOnce(new Error("No close is waiting for confirmation."));
    const error = vi.spyOn(toast, "error");
    renderHook(() => useAppClose(new QueryClient(), null));

    ask({ quitting: false });
    await act(() => Promise.resolve());

    expect(error).toHaveBeenCalledWith(
      "Could not close Cadencr",
      expect.objectContaining({ description: "No close is waiting for confirmation." }),
    );
  });
});

describe("interruptDevAgents", () => {
  it("does nothing outside a dev build", () => {
    targets.loaded = ["ws-1"];

    expect(interruptDevAgents(false)).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("interrupts every working agent the backend reports that this window can reach", () => {
    targets.loaded = ["ws-1", "ws-2"];

    expect(interruptDevAgents(true)).toBe(true);
    expect(interrupt.mock.calls).toEqual([["ws-1"], ["ws-2"]]);
  });

  it("says which agents it could not stop", () => {
    targets.unreachable = 2;
    const warning = vi.spyOn(toast, "warning");

    expect(interruptDevAgents(true)).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      "2 agents keep running on the dev service",
      expect.objectContaining({
        description: "Their conversations aren't open in this window, so they weren't stopped.",
      }),
    );
  });
});
