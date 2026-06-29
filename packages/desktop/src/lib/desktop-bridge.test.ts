import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  desktopBridge,
  setDesktopBridgeOverrideForTests,
  type CadencrDesktopBridge,
} from "./desktop-bridge";

function makeElectronBridge(): CadencrDesktopBridge {
  return {
    isElectron: true,
    runtimeConfig: vi.fn(() =>
      Promise.resolve({ baseUrl: "http://127.0.0.1:5004", authToken: "electron-token" }),
    ),
    readFileBase64: vi.fn(() => Promise.resolve("Zm9v")),
    onFileDrop: vi.fn(() => () => undefined),
    revealInFinder: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve()),
    openExternalLink: vi.fn(),
    setLinkHoverContext: vi.fn(),
    onOpenLinkFromMenu: vi.fn(),
    pickDirectory: vi.fn(() => Promise.resolve("/picked")),
    showSaveDialog: vi.fn(() => Promise.resolve("/picked/file.md")),
    notifyPermission: vi.fn(() => Promise.resolve(true)),
    notify: vi.fn(() => Promise.resolve()),
    notifyTest: vi.fn(() => Promise.resolve()),
    onNotificationClicked: vi.fn(() => () => undefined),
    onNotificationFailed: vi.fn(() => () => undefined),
    onNotificationFallback: vi.fn(() => () => undefined),
    onCloseRequested: vi.fn(() => () => undefined),
    confirmClose: vi.fn(() => Promise.resolve()),
    requestQuit: vi.fn(() => Promise.resolve()),
    setZoom: vi.fn(() => Promise.resolve()),
    currentTheme: vi.fn<() => Promise<"dark">>(() => Promise.resolve("dark")),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(() => Promise.resolve()),
    setRemoteHostAwake: vi.fn(() => Promise.resolve()),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    installUpdate: vi.fn(() => Promise.resolve()),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

describe("desktopBridge", () => {
  beforeEach(() => {
    clearDesktopBridgeOverrideForTests();
    Reflect.deleteProperty(window, "cadencr");
  });

  it("prefers the Electron preload bridge when present", async () => {
    const electronBridge = makeElectronBridge();
    window.cadencr = electronBridge;

    await expect(desktopBridge.runtimeConfig()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:5004",
      authToken: "electron-token",
    });

    expect(electronBridge.runtimeConfig).toHaveBeenCalledTimes(1);
  });

  it("allows tests to inject a bridge without touching window globals", async () => {
    const electronBridge = makeElectronBridge();
    setDesktopBridgeOverrideForTests(electronBridge);

    await desktopBridge.setZoom(1.25);

    expect(electronBridge.setZoom).toHaveBeenCalledWith(1.25);
  });

  it("uses browser-safe fallbacks outside the desktop shell", async () => {
    await expect(desktopBridge.notifyPermission()).resolves.toBe(false);
    await expect(desktopBridge.currentTheme()).resolves.toBe("light");
    expect(desktopBridge.onFileDrop(() => undefined)()).toBeUndefined();
    await expect(desktopBridge.runtimeConfig()).rejects.toThrow("desktop shell");
  });
});
