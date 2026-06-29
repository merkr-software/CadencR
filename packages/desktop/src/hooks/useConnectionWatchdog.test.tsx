import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge, DesktopTheme } from "@/lib/desktop-bridge";
import { useConnectionWatchdog } from "./useConnectionWatchdog";

const mocks = vi.hoisted(() => ({
  forceReconnectAll: vi.fn(),
  startHealthPolling: vi.fn(),
  stopHealthPolling: vi.fn(),
}));

vi.mock("@/stores/connection-status-store", () => ({
  useConnectionStatusStore: {
    getState: () => ({ forceReconnectAll: mocks.forceReconnectAll }),
  },
  startHealthPolling: mocks.startHealthPolling,
  stopHealthPolling: mocks.stopHealthPolling,
}));

function bridge(isElectron: boolean): CadencrDesktopBridge {
  return {
    isElectron,
    runtimeConfig: vi.fn(() => Promise.resolve({ baseUrl: "", authToken: null })),
    readFileBase64: vi.fn(() => Promise.resolve("")),
    onFileDrop: vi.fn(() => () => undefined),
    revealInFinder: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve()),
    openExternalLink: vi.fn(),
    setLinkHoverContext: vi.fn(),
    onOpenLinkFromMenu: vi.fn(),
    pickDirectory: vi.fn(() => Promise.resolve(null)),
    showSaveDialog: vi.fn(() => Promise.resolve(null)),
    notifyPermission: vi.fn(() => Promise.resolve(false)),
    notify: vi.fn(() => Promise.resolve()),
    notifyTest: vi.fn(() => Promise.resolve()),
    onNotificationClicked: vi.fn(() => () => undefined),
    onNotificationFailed: vi.fn(() => () => undefined),
    onNotificationFallback: vi.fn(() => () => undefined),
    onCloseRequested: vi.fn(() => () => undefined),
    confirmClose: vi.fn(() => Promise.resolve()),
    requestQuit: vi.fn(() => Promise.resolve()),
    setZoom: vi.fn(() => Promise.resolve()),
    currentTheme: vi.fn<() => Promise<DesktopTheme>>(() => Promise.resolve("light")),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(() => Promise.resolve()),
    setRemoteHostAwake: vi.fn(() => Promise.resolve()),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    installUpdate: vi.fn(() => Promise.resolve()),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

function dispatchVisibilityChange(state: DocumentVisibilityState): void {
  setVisibilityState(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useConnectionWatchdog", () => {
  beforeEach(() => {
    clearDesktopBridgeOverrideForTests();
    setVisibilityState("visible");
    mocks.forceReconnectAll.mockClear();
    mocks.startHealthPolling.mockClear();
    mocks.stopHealthPolling.mockClear();
  });

  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
    vi.useRealTimers();
  });

  it("does not force-reconnect Electron sockets after an app visibility restore", () => {
    setDesktopBridgeOverrideForTests(bridge(true));
    const { unmount } = renderHook(() => useConnectionWatchdog());

    dispatchVisibilityChange("hidden");
    dispatchVisibilityChange("visible");

    expect(mocks.forceReconnectAll).not.toHaveBeenCalled();
    unmount();
  });

  it("still force-reconnects browser sockets after a tab visibility restore", () => {
    setDesktopBridgeOverrideForTests(bridge(false));
    const { unmount } = renderHook(() => useConnectionWatchdog());

    dispatchVisibilityChange("hidden");
    dispatchVisibilityChange("visible");

    expect(mocks.forceReconnectAll).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not force-reconnect Electron sockets after a clock-jump wake", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setDesktopBridgeOverrideForTests(bridge(true));
    const { unmount } = renderHook(() => useConnectionWatchdog());

    vi.setSystemTime(31_000);
    act(() => vi.advanceTimersByTime(1_000));

    expect(mocks.forceReconnectAll).not.toHaveBeenCalled();
    unmount();
  });

  it("still force-reconnects browser sockets after a clock-jump wake", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setDesktopBridgeOverrideForTests(bridge(false));
    const { unmount } = renderHook(() => useConnectionWatchdog());

    vi.setSystemTime(31_000);
    act(() => vi.advanceTimersByTime(1_000));

    expect(mocks.forceReconnectAll).toHaveBeenCalledTimes(1);
    unmount();
  });
});
