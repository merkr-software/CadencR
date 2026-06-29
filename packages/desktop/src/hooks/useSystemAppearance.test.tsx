import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge, DesktopTheme } from "@/lib/desktop-bridge";
import { useSystemAppearance } from "./useSystemAppearance";

function bridge(overrides: Partial<CadencrDesktopBridge>): CadencrDesktopBridge {
  return {
    isElectron: true,
    runtimeConfig: vi.fn(),
    readFileBase64: vi.fn(),
    onFileDrop: vi.fn(() => () => undefined),
    revealInFinder: vi.fn(),
    openExternal: vi.fn(),
    openExternalLink: vi.fn(),
    setLinkHoverContext: vi.fn(),
    onOpenLinkFromMenu: vi.fn(),
    pickDirectory: vi.fn(),
    showSaveDialog: vi.fn(),
    notifyPermission: vi.fn(),
    notify: vi.fn(),
    notifyTest: vi.fn(),
    onNotificationClicked: vi.fn(() => () => undefined),
    onNotificationFailed: vi.fn(() => () => undefined),
    onNotificationFallback: vi.fn(() => () => undefined),
    onCloseRequested: vi.fn(() => () => undefined),
    confirmClose: vi.fn(),
    requestQuit: vi.fn(),
    setZoom: vi.fn(),
    currentTheme: vi.fn<() => Promise<DesktopTheme>>(() => Promise.resolve("dark")),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(() => Promise.resolve()),
    setRemoteHostAwake: vi.fn(() => Promise.resolve()),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    installUpdate: vi.fn(() => Promise.resolve()),
    onUpdateEvent: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("useSystemAppearance", () => {
  beforeEach(() => clearDesktopBridgeOverrideForTests());
  afterEach(() => clearDesktopBridgeOverrideForTests());

  it("reads the initial desktop theme and updates when the system theme changes", async () => {
    let handler: ((theme: DesktopTheme) => void) | null = null;
    const unlisten = vi.fn();
    setDesktopBridgeOverrideForTests(
      bridge({
        currentTheme: vi.fn<() => Promise<DesktopTheme>>(() => Promise.resolve("dark")),
        onThemeChange: vi.fn((nextHandler: (theme: DesktopTheme) => void) => {
          handler = nextHandler;
          return unlisten;
        }),
      }),
    );

    const { result, unmount } = renderHook(() => useSystemAppearance());

    await waitFor(() => expect(result.current.appearance).toBe("dark"));

    act(() => handler?.("light"));

    expect(result.current.appearance).toBe("light");
    expect(result.current.error).toBeNull();

    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("falls back to matchMedia updates when desktop theme APIs are unavailable", () => {
    setDesktopBridgeOverrideForTests(
      bridge({
        currentTheme: vi.fn(() => Promise.reject(new Error("desktop unavailable"))),
        onThemeChange: vi.fn(() => {
          throw new Error("desktop unavailable");
        }),
      }),
    );
    let matches = false;
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_event: string, listener: EventListenerOrEventListenerObject) => {
        listeners.push(listener as (event: MediaQueryListEvent) => void);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useSystemAppearance());

    expect(result.current.appearance).toBe("light");

    act(() => {
      matches = true;
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });

    expect(result.current.appearance).toBe("dark");
  });
});
