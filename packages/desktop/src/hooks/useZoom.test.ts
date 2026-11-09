// @vitest-environment happy-dom
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { subscribeZoomApplied } from "@/lib/zoom-coordinator";
import type { CadencrDesktopBridge } from "@/lib/desktop-bridge";
import { useZoom } from "./useZoom";

const mockSetZoom = vi.fn(() => Promise.resolve());

function bridge(): CadencrDesktopBridge {
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
    pickImageFile: vi.fn(),
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
    acknowledgeCloseRequest: vi.fn(() => Promise.resolve()),
    cancelClose: vi.fn(() => Promise.resolve()),
    serviceStatus: vi.fn(() => Promise.resolve({ state: "running" as const })),
    restartService: vi.fn(() => Promise.resolve()),
    onServiceStatus: vi.fn(() => () => undefined),
    setZoom: mockSetZoom,
    setTrafficLightsCenter: vi.fn(),
    currentTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(() => Promise.resolve()),
    setRemoteHostAwake: vi.fn(() => Promise.resolve()),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    fetchChangelogImage: vi.fn(),
    installUpdate: vi.fn(() => Promise.resolve()),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

const mockSetValue = vi.fn();
const mockSettingValue = { current: null as string | null };
const mockSettingLoading = { current: false };
const mockSettingKey = { current: "" };
vi.mock("./useSetting", () => ({
  useSetting: (key: string) => {
    mockSettingKey.current = key;
    return {
      value: mockSettingValue.current,
      setValue: mockSetValue,
      isLoading: mockSettingLoading.current,
    };
  },
}));

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn(),
}));

const mockIsMobile = { current: false };
vi.mock("./useIsMobile", () => ({
  useIsMobile: () => mockIsMobile.current,
}));

describe("useZoom", () => {
  beforeEach(() => {
    mockSetZoom.mockClear();
    mockSetValue.mockClear();
    mockSettingValue.current = null;
    mockSettingLoading.current = false;
    mockIsMobile.current = false;
    setDesktopBridgeOverrideForTests(bridge());
  });

  afterEach(() => clearDesktopBridgeOverrideForTests());

  it("defaults to 100% when no setting is stored", () => {
    const { result } = renderHook(() => useZoom());
    expect(result.current.zoomLevel).toBe(100);
  });

  it("reads persisted zoom level from setting", () => {
    mockSettingValue.current = "130";
    const { result } = renderHook(() => useZoom());
    expect(result.current.zoomLevel).toBe(130);
  });

  it("applies webview zoom on mount", () => {
    mockSettingValue.current = "120";
    renderHook(() => useZoom());
    expect(mockSetZoom).toHaveBeenCalledWith(1.2);
  });

  it("notifies native browser bounds trackers after desktop zoom is applied", async () => {
    const onZoomApplied = vi.fn();
    const unsubscribe = subscribeZoomApplied(onZoomApplied);
    let resolveZoom!: () => void;
    mockSetZoom.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveZoom = resolve;
        }),
    );
    mockSettingValue.current = "120";

    try {
      renderHook(() => useZoom());
      expect(onZoomApplied).not.toHaveBeenCalled();

      resolveZoom();

      await waitFor(() => {
        expect(onZoomApplied).toHaveBeenCalledTimes(1);
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not apply the default zoom while the persisted setting is still loading", () => {
    mockSettingValue.current = null;
    mockSettingLoading.current = true;

    renderHook(() => useZoom());

    expect(mockSetZoom).not.toHaveBeenCalled();
  });

  it("zoomIn increases by 10%", () => {
    mockSettingValue.current = "100";
    const { result, rerender } = renderHook(() => useZoom());
    act(() => result.current.zoomIn());
    expect(mockSetValue).toHaveBeenCalledWith("110");
    // The page zooms once the backend confirms the level.
    expect(mockSetZoom).not.toHaveBeenCalledWith(1.1);
    mockSettingValue.current = "110";
    rerender();
    expect(mockSetZoom).toHaveBeenCalledWith(1.1);
  });

  it("zoomOut decreases by 10%", () => {
    mockSettingValue.current = "100";
    const { result, rerender } = renderHook(() => useZoom());
    act(() => result.current.zoomOut());
    expect(mockSetValue).toHaveBeenCalledWith("90");
    // The page zooms once the backend confirms the level.
    expect(mockSetZoom).not.toHaveBeenCalledWith(0.9);
    mockSettingValue.current = "90";
    rerender();
    expect(mockSetZoom).toHaveBeenCalledWith(0.9);
  });

  it("resetZoom sets to 100%", () => {
    mockSettingValue.current = "150";
    const { result, rerender } = renderHook(() => useZoom());
    act(() => result.current.resetZoom());
    expect(mockSetValue).toHaveBeenCalledWith("100");
    // The page zooms once the backend confirms the level.
    expect(mockSetZoom).not.toHaveBeenCalledWith(1.0);
    mockSettingValue.current = "100";
    rerender();
    expect(mockSetZoom).toHaveBeenCalledWith(1.0);
  });

  it("adds up steps pressed before the previous one is confirmed", () => {
    mockSettingValue.current = "100";
    const { result } = renderHook(() => useZoom());
    act(() => {
      result.current.zoomIn();
      result.current.zoomIn();
    });
    expect(mockSetValue.mock.calls.map(([value]) => value)).toEqual(["110", "120"]);
  });

  it("clamps zoom to minimum 50%", () => {
    mockSettingValue.current = "50";
    const { result } = renderHook(() => useZoom());
    act(() => result.current.zoomOut());
    expect(mockSetValue).toHaveBeenCalledWith("50");
  });

  it("clamps zoom to maximum 200%", () => {
    mockSettingValue.current = "200";
    const { result } = renderHook(() => useZoom());
    act(() => result.current.zoomIn());
    expect(mockSetValue).toHaveBeenCalledWith("200");
  });

  it("setZoom applies arbitrary clamped value", () => {
    const { result, rerender } = renderHook(() => useZoom());
    act(() => result.current.setZoom(75));
    expect(mockSetValue).toHaveBeenCalledWith("75");
    // The page zooms once the backend confirms the level.
    expect(mockSetZoom).not.toHaveBeenCalledWith(0.75);
    mockSettingValue.current = "75";
    rerender();
    expect(mockSetZoom).toHaveBeenCalledWith(0.75);
  });

  it("scales the root font-size in a browser (no Electron shell)", () => {
    setDesktopBridgeOverrideForTests({ ...bridge(), isElectron: false });
    document.documentElement.style.removeProperty("font-size");
    mockSettingValue.current = "150";

    renderHook(() => useZoom());

    expect(mockSetZoom).not.toHaveBeenCalled();
    // 16px root × 1.5
    expect(document.documentElement.style.fontSize).toBe("24px");
  });

  it("clears the root font-size override at 100% in a browser", () => {
    setDesktopBridgeOverrideForTests({ ...bridge(), isElectron: false });
    document.documentElement.style.fontSize = "24px";
    mockSettingValue.current = "100";

    renderHook(() => useZoom());

    expect(document.documentElement.style.fontSize).toBe("");
  });

  it("persists desktop zoom under a different key than mobile zoom (per device type)", () => {
    mockIsMobile.current = false;
    renderHook(() => useZoom());
    expect(mockSettingKey.current).toBe("zoom_global");

    mockIsMobile.current = true;
    renderHook(() => useZoom());
    expect(mockSettingKey.current).toBe("zoom_mobile");
  });
});
