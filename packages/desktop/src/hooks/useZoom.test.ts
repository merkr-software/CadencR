// @vitest-environment happy-dom
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { subscribeZoomApplied } from "@/lib/zoom-coordinator";
import { toast } from "sonner";
import type { CadencrDesktopBridge } from "@/lib/desktop-bridge";
import { useAppZoom, useZoom, zoomDevice } from "./useZoom";

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

type Update = string | ((confirmed: string | null | undefined) => string | null);
const mockSettingValue = { current: null as string | null };
const mockSettingLoading = { current: false };
const mockSettingFetched = { current: true };
const mockSettingError = { current: null as unknown };
const mockSettingKey = { current: "" };
// The confirmed value each queued write reads, as `writeSetting` does.
const mockConfirmed = { current: null as string | null | undefined };
const mockSetValue = vi.fn((next: Update) => {
  const value = typeof next === "string" ? next : next(mockConfirmed.current);
  if (value !== null) mockConfirmed.current = value;
  return Promise.resolve(true);
});
vi.mock("./useSetting", () => ({
  useSetting: (key: string) => {
    mockSettingKey.current = key;
    return {
      value: mockSettingValue.current,
      setValue: mockSetValue,
      isLoading: mockSettingLoading.current,
      isFetched: mockSettingFetched.current,
      isSaving: false,
    };
  },
}));

vi.mock("@/api/generated", () => ({
  useGetWorkspaceSetting: () => ({ error: mockSettingError.current }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn(),
}));

const mockIsMobile = { current: false };
vi.mock("./useIsMobile", () => ({
  useIsMobile: () => mockIsMobile.current,
}));

beforeEach(() => {
  mockSetZoom.mockClear();
  mockSetValue.mockClear();
  vi.mocked(toast.error).mockClear();
  mockSettingValue.current = null;
  mockSettingLoading.current = false;
  mockSettingFetched.current = true;
  mockSettingError.current = null;
  mockConfirmed.current = null;
  mockIsMobile.current = false;
  setDesktopBridgeOverrideForTests(bridge());
});

afterEach(() => clearDesktopBridgeOverrideForTests());

/** Persisted level after the writes so far, as the backend would confirm it. */
function confirmedLevel(): string | null | undefined {
  return mockConfirmed.current;
}

describe("useAppZoom", () => {
  it("applies the persisted level on mount", () => {
    mockSettingValue.current = "120";
    renderHook(() => useAppZoom());
    expect(mockSetZoom).toHaveBeenCalledWith(1.2);
  });

  it("applies the default when the backend has no level", () => {
    renderHook(() => useAppZoom());
    expect(mockSetZoom).toHaveBeenCalledWith(1);
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
      renderHook(() => useAppZoom());
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
    mockSettingLoading.current = true;
    mockSettingFetched.current = false;

    renderHook(() => useAppZoom());

    expect(mockSetZoom).not.toHaveBeenCalled();
  });

  it("keeps the current zoom and reports the error when the level cannot be loaded", () => {
    mockSettingError.current = new Error("service unreachable");

    const { rerender } = renderHook(() => useAppZoom());

    expect(mockSetZoom).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Could not load the zoom level: service unreachable", {
      id: "zoom-load-error",
    });

    // A later fetch succeeds: the level is applied.
    mockSettingError.current = null;
    mockSettingValue.current = "140";
    rerender();
    expect(mockSetZoom).toHaveBeenCalledWith(1.4);
  });

  it("keeps applying a known level when a refetch fails, without an error toast", () => {
    mockSettingValue.current = "130";
    mockSettingError.current = new Error("service unreachable");

    renderHook(() => useAppZoom());

    expect(mockSetZoom).toHaveBeenCalledWith(1.3);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("zooms once the backend confirms a step, not before", () => {
    mockSettingValue.current = "100";
    mockConfirmed.current = "100";
    const { result, rerender } = renderHook(() => ({ app: useAppZoom(), zoom: useZoom() }));
    mockSetZoom.mockClear();

    act(() => result.current.zoom.step("in"));
    expect(confirmedLevel()).toBe("110");
    expect(mockSetZoom).not.toHaveBeenCalled();

    mockSettingValue.current = "110";
    rerender();
    expect(mockSetZoom).toHaveBeenCalledWith(1.1);
  });

  it("clamps an out-of-range stored level instead of failing to apply it", () => {
    mockSettingValue.current = "300";
    renderHook(() => useAppZoom());
    expect(mockSetZoom).toHaveBeenCalledWith(2);
  });

  it("scales the root font-size in a browser (no Electron shell)", () => {
    setDesktopBridgeOverrideForTests({ ...bridge(), isElectron: false });
    document.documentElement.style.removeProperty("font-size");
    mockSettingValue.current = "150";

    renderHook(() => useAppZoom());

    expect(mockSetZoom).not.toHaveBeenCalled();
    // 16px root × 1.5
    expect(document.documentElement.style.fontSize).toBe("24px");
  });

  it("clears the root font-size override at 100% in a browser", () => {
    setDesktopBridgeOverrideForTests({ ...bridge(), isElectron: false });
    document.documentElement.style.fontSize = "24px";
    mockSettingValue.current = "100";

    renderHook(() => useAppZoom());

    expect(document.documentElement.style.fontSize).toBe("");
  });
});

describe("useZoom", () => {
  it("reads the persisted level, defaulting to 100%", () => {
    const { result, rerender } = renderHook(() => useZoom());
    expect(result.current.zoomLevel).toBe(100);
    mockSettingValue.current = "130";
    rerender();
    expect(result.current.zoomLevel).toBe(130);
  });

  it("never applies the zoom itself, so opening the settings cannot change it", () => {
    mockSettingValue.current = "130";
    renderHook(() => useZoom());
    expect(mockSetZoom).not.toHaveBeenCalled();
  });

  it("steps from the confirmed level and resets to 100%", () => {
    mockConfirmed.current = "150";
    const { result } = renderHook(() => useZoom());
    act(() => result.current.step("out"));
    expect(confirmedLevel()).toBe("140");
    act(() => result.current.step("reset"));
    expect(confirmedLevel()).toBe("100");
  });

  it("adds up steps from different callers before the first is confirmed", () => {
    mockConfirmed.current = "100";
    const hotkeys = renderHook(() => useZoom());
    const settingsRow = renderHook(() => useZoom());
    act(() => {
      hotkeys.result.current.step("in");
      settingsRow.result.current.step("in");
    });
    expect(confirmedLevel()).toBe("120");
  });

  it("treats an unset level as 100% and clamps steps to 50%–200%", () => {
    const { result } = renderHook(() => useZoom());
    act(() => result.current.step("in"));
    expect(confirmedLevel()).toBe("110");
    mockConfirmed.current = "200";
    act(() => result.current.step("in"));
    expect(confirmedLevel()).toBe("200");
    mockConfirmed.current = "50";
    act(() => result.current.step("out"));
    expect(confirmedLevel()).toBe("50");
  });

  it("does not overwrite a level that never loaded", () => {
    mockConfirmed.current = undefined;
    const { result } = renderHook(() => useZoom());
    act(() => result.current.step("in"));
    expect(mockSetValue).toHaveBeenCalledTimes(1);
    expect(confirmedLevel()).toBeUndefined();
  });

  it("keeps the desktop level in the Electron shell even under the phone breakpoint", () => {
    mockIsMobile.current = true;
    const { result } = renderHook(() => useZoom());
    expect(mockSettingKey.current).toBe("zoom_global");
    expect(result.current.device).toBe("desktop");
  });

  it("persists remote phone zoom under a different key than desktop zoom", () => {
    setDesktopBridgeOverrideForTests({ ...bridge(), isElectron: false });
    renderHook(() => useZoom());
    expect(mockSettingKey.current).toBe("zoom_global");

    mockIsMobile.current = true;
    const { result } = renderHook(() => useZoom());
    expect(mockSettingKey.current).toBe("zoom_mobile");
    expect(result.current.device).toBe("mobile");
  });
});

describe("zoomDevice", () => {
  it("follows the viewport only outside the desktop shell", () => {
    expect(zoomDevice(true, true)).toBe("desktop");
    expect(zoomDevice(false, true)).toBe("mobile");
    expect(zoomDevice(false, false)).toBe("desktop");
  });
});
