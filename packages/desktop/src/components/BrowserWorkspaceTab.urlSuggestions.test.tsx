import userEvent from "@testing-library/user-event";
import { act } from "react";
import { toast } from "sonner";
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
      pinned: false,
      suspended: false,
      zoomPercent: 100,
      responsive: {
        enabled: false,
        preset: "mobile",
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        colorScheme: "system",
        status: "ready",
      },
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
    listBrowserDownloads: vi.fn(() =>
      Promise.resolve({ scopeId: 1, downloads: [], activeCount: 0, aggregatePercent: null }),
    ),
    listBrowserDownloadCountsByScope: vi.fn(() => Promise.resolve({})),
    pauseBrowserDownload: vi.fn(),
    resumeBrowserDownload: vi.fn(),
    cancelBrowserDownload: vi.fn(),
    revealBrowserDownload: vi.fn(),
    clearBrowserDownloads: vi.fn(),
    navigateBrowserTab: vi.fn(),
    activateBrowserTab: vi.fn(),
    closeBrowserTab: vi.fn(),
    closeBrowserTabsForScope: vi.fn(),
    duplicateBrowserTab: vi.fn(),
    setBrowserTabPinned: vi.fn(),
    reorderBrowserTab: vi.fn(),
    closeOtherBrowserTabs: vi.fn(),
    reopenLastClosedBrowserTab: vi.fn(),
    listBlockedBrowserPopups: vi.fn(() => Promise.resolve([])),
    allowBrowserPopupOnce: vi.fn(() => Promise.resolve()),
    openBrowserPopupExternally: vi.fn(() => Promise.resolve()),
    dismissBrowserPopup: vi.fn(() => Promise.resolve()),
    setBrowserBounds: vi.fn(() => Promise.resolve(SNAPSHOT)),
    setBrowserSuppressed: vi.fn(() => Promise.resolve()),
    listBrowserProfiles: vi.fn(() => Promise.resolve([])),
    clearBrowserStorage: vi.fn(),
    createBrowserProfile: vi.fn(),
    duplicateBrowserProfile: vi.fn(),
    deleteBrowserProfile: vi.fn(),
    getBrowserSiteInfo: vi.fn(),
    setBrowserSitePermission: vi.fn(),
    clearBrowserSiteData: vi.fn(),
    setBrowserAgentSharing: vi.fn(),
    resolveBrowserPermissionRequest: vi.fn(),
    browserBack: vi.fn(),
    browserForward: vi.fn(),
    browserReload: vi.fn(),
    browserStop: vi.fn(),
    browserZoomIn: vi.fn(),
    browserZoomOut: vi.fn(),
    browserZoomReset: vi.fn(),
    findInBrowserTab: vi.fn(() => Promise.resolve()),
    stopFindingInBrowserTab: vi.fn(() => Promise.resolve()),
    setBrowserGuestShortcuts: vi.fn(() => Promise.resolve()),
    queryBrowserOmnibox: vi.fn(() =>
      Promise.resolve({ history: [], bookmarks: [], historyCount: 0, bookmarkCount: 0 }),
    ),
    onBrowserLibraryChanged: vi.fn(() => () => undefined),
    getBrowserBookmark: vi.fn(() => Promise.resolve(null)),
    removeBrowserHistoryEntry: vi.fn(() => Promise.resolve()),
    clearBrowserHistory: vi.fn(() => Promise.resolve()),
    setBrowserBookmark: vi.fn(() => Promise.resolve(null)),
    toggleBrowserDevTools: vi.fn(),
    setBrowserResponsive: vi.fn(),
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
    onBrowserAgentActivity: vi.fn(() => () => undefined),
    onBrowserDownloadsChanged: vi.fn(() => () => undefined),
    onBrowserDownloadCounts: vi.fn(() => () => undefined),
    onBrowserShortcut: vi.fn(() => () => undefined),
    onBrowserFindResult: vi.fn(() => () => undefined),
    onBrowserCommentBadgeClick: vi.fn(() => () => undefined),
    onBrowserPermissionRequest: vi.fn(() => () => undefined),
    onBrowserPermissionRequestCancelled: vi.fn(() => () => undefined),
    onBrowserPopupRequestsChanged: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    fetchChangelog: vi.fn(),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

describe("BrowserWorkspaceTab URL suggestions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearDesktopBridgeOverrideForTests();
  });

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

  it("does not report a rejected snapshot after its overlay has closed", async () => {
    let rejectCapture: ((error: Error) => void) | null = null;
    const mockBridge = bridge();
    mockBridge.getBrowserScreenshot = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectCapture = reject;
        }),
    );
    const errorToast = vi.spyOn(toast, "error");
    setDesktopBridgeOverrideForTests(mockBridge);
    const { user } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
    const input = await screen.findByLabelText("Browser URL");

    await user.clear(input);
    await user.type(input, "loc");
    await waitFor(() => expect(mockBridge.getBrowserScreenshot).toHaveBeenCalledWith("tab-1"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    await act(async () => {
      rejectCapture?.(new Error("capture became obsolete"));
      await Promise.resolve();
    });

    expect(errorToast).not.toHaveBeenCalled();
  });
});
