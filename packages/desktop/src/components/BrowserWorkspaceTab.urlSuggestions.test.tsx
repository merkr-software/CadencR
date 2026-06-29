import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
  type BrowserStateSnapshot,
  type CadencrBrowserBridge,
} from "@/lib/desktop-bridge";
import { BrowserWorkspaceTab } from "./BrowserWorkspaceTab";

const SNAPSHOT: BrowserStateSnapshot = {
  tabs: [
    {
      id: "tab-1",
      title: "Local app",
      url: "http://localhost:1420/",
      loading: false,
      canGoBack: false,
      canGoForward: true,
      sessionProfileId: "ephemeral",
      isActive: true,
      devToolsOpen: false,
      scopeId: 1,
    },
  ],
  activeTabId: "tab-1",
  scopeId: 1,
  consoleEntries: [],
  networkEntries: [],
  knownOrigins: ["https://www.google.com", "http://localhost:5173"],
  error: null,
};

function bridge(): CadencrBrowserBridge {
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
    reportRendererError: vi.fn(() => Promise.resolve()),
    setZoom: vi.fn(),
    currentTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(),
    setRemoteHostAwake: vi.fn(),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    createBrowserTab: vi.fn(),
    listBrowserTabs: vi.fn(() => Promise.resolve(SNAPSHOT)),
    listBrowserTabCountsByScope: vi.fn(() => Promise.resolve({ 1: SNAPSHOT.tabs.length })),
    navigateBrowserTab: vi.fn(),
    activateBrowserTab: vi.fn(),
    closeBrowserTab: vi.fn(),
    closeBrowserTabsForScope: vi.fn(),
    setBrowserBounds: vi.fn(() => Promise.resolve(SNAPSHOT)),
    setBrowserSuppressed: vi.fn(() => Promise.resolve()),
    listBrowserProfiles: vi.fn(() => Promise.resolve([])),
    clearBrowserStorage: vi.fn(),
    createBrowserProfile: vi.fn(),
    duplicateBrowserProfile: vi.fn(),
    deleteBrowserProfile: vi.fn(),
    browserBack: vi.fn(),
    browserForward: vi.fn(),
    browserReload: vi.fn(),
    browserStop: vi.fn(),
    browserZoomIn: vi.fn(),
    browserZoomOut: vi.fn(),
    toggleBrowserDevTools: vi.fn(),
    getBrowserConsole: vi.fn(),
    getBrowserNetwork: vi.fn(),
    getBrowserSnapshot: vi.fn(),
    getBrowserScreenshot: vi.fn(() => Promise.resolve("browser-png")),
    browserClick: vi.fn(),
    browserType: vi.fn(),
    browserKeypress: vi.fn(),
    selectBrowserElementContext: vi.fn(),
    removeBrowserCommentBadge: vi.fn(() => Promise.resolve()),
    clearBrowserCommentBadges: vi.fn(() => Promise.resolve()),
    onBrowserState: vi.fn(() => () => undefined),
    onBrowserTabCounts: vi.fn(() => () => undefined),
    onBrowserShortcut: vi.fn(() => () => undefined),
    onBrowserCommentBadgeClick: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    fetchChangelog: vi.fn(),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

describe("BrowserWorkspaceTab URL suggestions", () => {
  afterEach(() => clearDesktopBridgeOverrideForTests());

  it("captures a preview before suppressing the native browser view", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    const { container } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
    const urlInput = await screen.findByLabelText("Browser URL");

    await userEvent.clear(urlInput);
    await userEvent.type(urlInput, "loc");

    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(screen.queryByTestId("browser-suggestion-overlay-reserve")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockBridge.setBrowserSuppressed).toHaveBeenCalledWith(true);
      expect(mockBridge.getBrowserScreenshot).toHaveBeenCalledWith("tab-1");
      expect(
        container.querySelector('img[src="data:image/png;base64,browser-png"]'),
      ).not.toBeNull();
    });
    const getScreenshot = vi.mocked(mockBridge.getBrowserScreenshot);
    const setSuppressed = vi.mocked(mockBridge.setBrowserSuppressed);
    const screenshotOrder = getScreenshot.mock.invocationCallOrder[0];
    const suppressOrder = setSuppressed.mock.invocationCallOrder.find(
      (_, index: number) => setSuppressed.mock.calls[index]?.[0] === true,
    );
    expect(screenshotOrder).toBeLessThan(suppressOrder ?? 0);
  });

  it("does not restore the active tab URL while the URL bar is being edited", async () => {
    let onBrowserState: ((snapshot: BrowserStateSnapshot) => void) | null = null;
    const mockBridge = bridge();
    mockBridge.onBrowserState = vi.fn((callback) => {
      onBrowserState = callback;
      return () => undefined;
    });
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
    const input = await screen.findByLabelText("Browser URL");

    await userEvent.clear(input);
    await userEvent.type(input, "loc");
    act(() => onBrowserState?.({ ...SNAPSHOT, knownOrigins: [] }));

    expect(input).toHaveValue("loc");
  });
});
