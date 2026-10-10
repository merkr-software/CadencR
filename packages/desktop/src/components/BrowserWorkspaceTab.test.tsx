// @vitest-environment jsdom
// Pinned to jsdom: relies on jsdom's focus handling for menu keyboard navigation.
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createTestQueryClient, render, screen, waitFor } from "@/test-utils";
import { API_BASE_URL, server } from "@/test/msw-server";
import { BrowserWorkspaceTab } from "./BrowserWorkspaceTab";
import { BROWSER_DEFAULT_MODE_SETTING_KEY } from "@/lib/browser-settings";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { MAX_BROWSER_FAVICON_DATA_URL_LENGTH } from "@/shared/browser-types";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
  type BrowserShortcut,
  type BrowserStateSnapshot,
  type CadencrBrowserBridge,
} from "@/lib/desktop-bridge";

function bridge(): CadencrBrowserBridge {
  const state: BrowserStateSnapshot = {
    tabs: [
      {
        id: "tab-1",
        title: "Local app",
        url: "http://localhost:1420/",
        loading: false,
        canGoBack: false,
        canGoForward: true,
        sessionProfileId: "default",
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
    knownOrigins: [],
    error: null,
  };
  return {
    isElectron: true,
    runtimeConfig: vi.fn(() =>
      Promise.resolve({ baseUrl: "http://localhost:5005", authToken: null }),
    ),
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
    currentTheme: vi.fn<() => Promise<"dark">>(() => Promise.resolve("dark")),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(),
    setRemoteHostAwake: vi.fn(),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    createBrowserTab: vi.fn(() => Promise.resolve(state.tabs[0])),
    listBrowserTabs: vi.fn(() => Promise.resolve(state)),
    listBrowserTabCountsByScope: vi.fn(() => Promise.resolve({ 1: state.tabs.length })),
    listBrowserDownloads: vi.fn(() =>
      Promise.resolve({ scopeId: 1, downloads: [], activeCount: 0, aggregatePercent: null }),
    ),
    listBrowserDownloadCountsByScope: vi.fn(() => Promise.resolve({})),
    pauseBrowserDownload: vi.fn(),
    resumeBrowserDownload: vi.fn(),
    cancelBrowserDownload: vi.fn(),
    revealBrowserDownload: vi.fn(),
    clearBrowserDownloads: vi.fn(),
    navigateBrowserTab: vi.fn(() => Promise.resolve(state.tabs[0])),
    activateBrowserTab: vi.fn(() => Promise.resolve(state.tabs[0])),
    closeBrowserTab: vi.fn(() => Promise.resolve(state)),
    closeBrowserTabsForScope: vi.fn(() => Promise.resolve(state)),
    duplicateBrowserTab: vi.fn(() => Promise.resolve(state.tabs[0])),
    setBrowserTabPinned: vi.fn(() => Promise.resolve(state)),
    reorderBrowserTab: vi.fn(() => Promise.resolve(state)),
    closeOtherBrowserTabs: vi.fn(() => Promise.resolve(state)),
    reopenLastClosedBrowserTab: vi.fn(() => Promise.resolve(state.tabs[0])),
    listBlockedBrowserPopups: vi.fn(() => Promise.resolve([])),
    allowBrowserPopupOnce: vi.fn(() => Promise.resolve()),
    openBrowserPopupExternally: vi.fn(() => Promise.resolve()),
    dismissBrowserPopup: vi.fn(() => Promise.resolve()),
    setBrowserBounds: vi.fn(() => Promise.resolve(state)),
    setBrowserSuppressed: vi.fn(() => Promise.resolve()),
    listBrowserProfiles: vi.fn(() =>
      Promise.resolve([
        { id: "default", label: "default", mode: "persistent" as const },
        { id: "dev", label: "dev", mode: "persistent" as const },
      ]),
    ),
    clearBrowserStorage: vi.fn(() => Promise.resolve()),
    createBrowserProfile: vi.fn(() =>
      Promise.resolve({ id: "created", label: "created", mode: "persistent" as const }),
    ),
    duplicateBrowserProfile: vi.fn(() =>
      Promise.resolve({ id: "copy", label: "copy", mode: "persistent" as const }),
    ),
    deleteBrowserProfile: vi.fn(() => Promise.resolve()),
    getBrowserSiteInfo: vi.fn(() =>
      Promise.resolve({
        tabId: "tab-1",
        origin: "http://localhost:1420",
        secure: false,
        profile: { id: "default", label: "default", mode: "persistent" as const },
        privacy: "normal" as const,
        permissions: {
          camera: "ask" as const,
          microphone: "ask" as const,
          location: "ask" as const,
          clipboard: "ask" as const,
        },
        agentAccess: "user" as const,
      }),
    ),
    setBrowserSitePermission: vi.fn(),
    clearBrowserSiteData: vi.fn(),
    setBrowserAgentSharing: vi.fn(),
    resolveBrowserPermissionRequest: vi.fn(() => Promise.resolve()),
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
    toggleBrowserDevTools: vi.fn(() => Promise.resolve(state.tabs[0])),
    setBrowserResponsive: vi.fn(() => Promise.resolve(state.tabs[0])),
    getBrowserConsole: vi.fn(() => Promise.resolve([])),
    getBrowserNetwork: vi.fn(() => Promise.resolve([])),
    getBrowserSnapshot: vi.fn(),
    getBrowserScreenshot: vi.fn(() => Promise.resolve("png-base64")),
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

describe("BrowserWorkspaceTab", () => {
  it("renders the expected remote state without any native browser operations", async () => {
    const native = bridge();
    setDesktopBridgeOverrideForTests({ ...native, isElectron: false });
    const { unmount } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
    expect(
      screen.getByText("The embedded browser is only available in the desktop app."),
    ).toBeInTheDocument();
    await act(async () => undefined);
    unmount();
    for (const [name, call] of Object.entries(native)) {
      if (/browser/i.test(name) && vi.isMockFunction(call)) expect(call).not.toHaveBeenCalled();
    }
  });

  beforeEach(() => {
    clearDesktopBridgeOverrideForTests();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it("creates a normal tab that reuses cookies by default", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "New browser tab (default: Normal)" }),
    );

    expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith(undefined, "default", 1);
  });

  it("offers explicit normal and private tab actions without a global mode toggle", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Private" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Choose browser tab type" }));
    expect(screen.getByRole("menuitem", { name: "New tab (normal)" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "New private tab" }));

    expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith(undefined, "fresh", 1);
  });

  it("toggles responsive mode with the exact strict IPC request", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Open responsive mode" }));

    await waitFor(() =>
      expect(mockBridge.setBrowserResponsive).toHaveBeenCalledWith("tab-1", {
        enabled: true,
        preset: "mobile",
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        colorScheme: "system",
      }),
    );
    expect(vi.mocked(mockBridge.setBrowserResponsive).mock.calls[0]?.[1]).not.toHaveProperty(
      "status",
    );
  });

  it("toggles responsive mode while the guest page owns keyboard focus", async () => {
    let shortcutRelay: ((shortcut: BrowserShortcut) => void) | null = null;
    const mockBridge = bridge();
    mockBridge.onBrowserShortcut = vi.fn((callback) => {
      shortcutRelay = callback;
      return () => undefined;
    });
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
    await screen.findByRole("button", { name: "Open responsive mode" });

    act(() => shortcutRelay?.("responsive"));

    await waitFor(() =>
      expect(mockBridge.setBrowserResponsive).toHaveBeenCalledWith(
        "tab-1",
        expect.objectContaining({ enabled: true }),
      ),
    );
  });

  it("keeps responsive recovery controls visible after cleanup fails", async () => {
    const mockBridge = bridge();
    const snapshot = await mockBridge.listBrowserTabs(1);
    snapshot.tabs[0].responsive = {
      ...snapshot.tabs[0].responsive,
      enabled: false,
      status: "error",
    };
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    expect(await screen.findByText(/could not be fully cleared/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exit responsive mode" })).toBeEnabled();
  });

  it("suppresses the native view while a responsive select is open", async () => {
    const mockBridge = bridge();
    const snapshot = await mockBridge.listBrowserTabs(1);
    snapshot.tabs[0].responsive = { ...snapshot.tabs[0].responsive, enabled: true };
    setDesktopBridgeOverrideForTests(mockBridge);
    const { user } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await user.click(await screen.findByRole("combobox", { name: "Responsive device preset" }));
    await waitFor(() => expect(mockBridge.getBrowserScreenshot).toHaveBeenCalledWith("tab-1"));
    await waitFor(() => expect(mockBridge.setBrowserSuppressed).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("option", { name: "Tablet" }));
    await waitFor(() => expect(mockBridge.setBrowserSuppressed).toHaveBeenLastCalledWith(false));
  });

  it("supports opening a private tab from the split-button menu with the keyboard", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    const { user } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    const chooser = await screen.findByRole("button", { name: "Choose browser tab type" });
    chooser.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "New tab (normal)" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(chooser).toHaveFocus();
    expect(mockBridge.createBrowserTab).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith(undefined, "fresh", 1);
    await waitFor(() => expect(screen.getByLabelText("Browser URL")).toHaveFocus());
  });

  it("suppresses the native view while the new-tab menu is open", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    const { user } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Choose browser tab type" }));
    await waitFor(() => expect(mockBridge.getBrowserScreenshot).toHaveBeenCalledWith("tab-1"));
    await waitFor(() => expect(mockBridge.setBrowserSuppressed).toHaveBeenLastCalledWith(true));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(mockBridge.setBrowserSuppressed).toHaveBeenLastCalledWith(false));
  });

  it("uses the latest configured default for the split button", async () => {
    const queryClient = createTestQueryClient();
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />, { queryClient });
    await screen.findByRole("button", { name: "New browser tab (default: Normal)" });

    act(() => {
      queryClient.setQueryData(getGetWorkspaceSettingQueryKey(BROWSER_DEFAULT_MODE_SETTING_KEY), {
        value: "private",
      });
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "New browser tab (default: Private)" }),
    );

    expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith(undefined, "fresh", 1);

    await userEvent.click(screen.getByRole("button", { name: "Choose browser tab type" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New tab (normal)" }));
    expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith(undefined, "default", 1);
  });

  it("shows a busy creation state and prevents duplicate tab requests", async () => {
    let finishCreation: (() => void) | undefined;
    const mockBridge = bridge();
    const createdTab = (await mockBridge.listBrowserTabs(1)).tabs[0];
    mockBridge.createBrowserTab = vi.fn(
      () =>
        new Promise<typeof createdTab>((resolve) => {
          finishCreation = () => resolve(createdTab);
        }),
    );
    setDesktopBridgeOverrideForTests(mockBridge);
    const { user } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
    const button = await screen.findByRole("button", {
      name: "New browser tab (default: Normal)",
    });

    await user.click(button);
    expect(screen.getByRole("button", { name: "Opening browser tab" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Opening browser tab" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Opening browser tab" }));
    expect(mockBridge.createBrowserTab).toHaveBeenCalledTimes(1);

    finishCreation?.();
    await screen.findByRole("button", { name: "New browser tab (default: Normal)" });
  });

  it("restores tab creation controls after a failed request", async () => {
    const mockBridge = bridge();
    mockBridge.createBrowserTab = vi.fn(() => Promise.reject(new Error("profile unavailable")));
    setDesktopBridgeOverrideForTests(mockBridge);
    const { user } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", { name: "New browser tab (default: Normal)" }),
    );

    expect(
      await screen.findByRole("button", { name: "New browser tab (default: Normal)" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose browser tab type" })).toBeEnabled();
    expect(screen.getByLabelText("Browser URL")).toHaveValue("http://localhost:1420/");
  });

  it("opens the first tab in the saved default mode", async () => {
    // Default mode persisted as "private" should seed the very first tab the
    // bootstrap creates with the ephemeral "fresh" profile.
    server.use(
      http.get(`${API_BASE_URL}/api/workspace/settings/${BROWSER_DEFAULT_MODE_SETTING_KEY}`, () =>
        HttpResponse.json({ value: "private" }),
      ),
    );
    const mockBridge = bridge();
    mockBridge.listBrowserTabs = vi.fn(() =>
      Promise.resolve<BrowserStateSnapshot>({
        tabs: [],
        activeTabId: null,
        consoleEntries: [],
        networkEntries: [],
        knownOrigins: [],
        error: null,
      }),
    );
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await waitFor(() => {
      expect(mockBridge.createBrowserTab).toHaveBeenCalledWith(undefined, "fresh", 1);
    });
  });

  it("keeps per-tab privacy visible alongside favicons and loading state", async () => {
    const mockBridge = bridge();
    const snapshot = await mockBridge.listBrowserTabs(1);
    const baseTab = snapshot.tabs[0];
    snapshot.tabs = [
      {
        ...baseTab,
        id: "private-ready",
        title: "Private ready",
        faviconUrl: "data:image/png;base64,iVBORw0KGgo=",
        sessionProfileId: "fresh",
        isActive: true,
      },
      {
        ...baseTab,
        id: "private-remote-favicon",
        title: "Private unsafe favicon",
        faviconUrl: "https://example.com/favicon.ico",
        sessionProfileId: "fresh",
        isActive: false,
      },
      {
        ...baseTab,
        id: "private-loading",
        title: "Private loading",
        loading: true,
        sessionProfileId: "fresh",
        isActive: false,
      },
      {
        ...baseTab,
        id: "private-oversized-favicon",
        title: "Private oversized favicon",
        faviconUrl: `data:image/png;base64,${"A".repeat(MAX_BROWSER_FAVICON_DATA_URL_LENGTH)}`,
        sessionProfileId: "fresh",
        isActive: false,
      },
    ];
    snapshot.activeTabId = "private-ready";
    mockBridge.listBrowserTabs = vi.fn(() => Promise.resolve(snapshot));
    setDesktopBridgeOverrideForTests(mockBridge);
    const { container } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await screen.findByText("Private ready");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(container.querySelector('img[src="https://example.com/favicon.ico"]')).toBeNull();
    expect(screen.getAllByRole("img", { name: "Private tab" })).toHaveLength(4);
    expect(screen.getByRole("status", { name: "Tab loading" })).toBeInTheDocument();
  });

  it("does not render console or network diagnostics in the Browser footer", async () => {
    const mockBridge = bridge();
    mockBridge.listBrowserTabs = vi.fn(() =>
      Promise.resolve<BrowserStateSnapshot>({
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
        knownOrigins: [],
        consoleEntries: [
          {
            id: "console-1",
            tabId: "tab-1",
            level: "error",
            message: "Hydration failed",
            sourceUrl: "http://localhost:1420/main.tsx",
            lineNumber: 42,
            timestamp: "2026-06-09T00:00:00.000Z",
          },
        ],
        networkEntries: [
          {
            id: "network-1",
            tabId: "tab-1",
            method: "GET",
            url: "http://localhost:1420/api/items",
            status: 500,
            requestHeaders: {},
            responseHeaders: {},
            resourceType: "xhr",
            timestamp: "2026-06-09T00:00:00.000Z",
          },
        ],
        error: null,
      }),
    );
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    expect(await screen.findByDisplayValue("http://localhost:1420/")).toBeInTheDocument();
    expect(screen.queryByText("Hydration failed")).not.toBeInTheDocument();
    expect(screen.queryByText("GET 500")).not.toBeInTheDocument();
    expect(screen.queryByText("http://localhost:1420/api/items")).not.toBeInTheDocument();
  });

  it("loads Browser state and navigates from the URL bar", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    expect(await screen.findByDisplayValue("http://localhost:1420/")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Browser URL"));
    await userEvent.type(screen.getByLabelText("Browser URL"), "localhost:3000");
    await userEvent.type(screen.getByLabelText("Browser URL"), "{Enter}");

    await waitFor(() => {
      expect(mockBridge.navigateBrowserTab).toHaveBeenCalledWith("tab-1", "http://localhost:3000/");
    });
  });

  it("relays guest find, reports native matches, advances, reverses, and closes", async () => {
    let shortcutRelay: ((shortcut: "find") => void) | null = null;
    let findResultRelay:
      | ((result: {
          tabId: string;
          requestToken: string;
          activeMatchOrdinal: number;
          matches: number;
          finalUpdate: boolean;
        }) => void)
      | null = null;
    const mockBridge = bridge();
    mockBridge.onBrowserShortcut = vi.fn((callback) => {
      shortcutRelay = callback;
      return () => undefined;
    });
    mockBridge.onBrowserFindResult = vi.fn((callback) => {
      findResultRelay = callback;
      return () => undefined;
    });
    setDesktopBridgeOverrideForTests(mockBridge);
    const { user } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
    await screen.findByDisplayValue("http://localhost:1420/");

    expect(mockBridge.setBrowserGuestShortcuts).toHaveBeenCalledWith({
      find: { keys: ["mod", "f"], altKeys: undefined },
      downloads: { keys: ["mod", "shift", "j"], altKeys: undefined },
      responsive: { keys: ["mod", "shift", "m"], altKeys: undefined },
      devtools: { keys: ["f12"], altKeys: undefined },
      zoomReset: { keys: ["mod", "0"], altKeys: undefined },
    });
    act(() => shortcutRelay?.("find"));
    const input = await screen.findByRole("textbox", { name: "Find in page" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "cadencrneedle");
    const initialRequest = vi.mocked(mockBridge.findInBrowserTab).mock.calls.at(-1);
    if (!initialRequest) throw new Error("Expected find request");
    expect(initialRequest).toEqual([
      "tab-1",
      expect.objectContaining({ query: "cadencrneedle", forward: true, findNext: true }),
    ]);

    act(() =>
      findResultRelay?.({
        tabId: "tab-1",
        requestToken: initialRequest[1].requestToken,
        activeMatchOrdinal: 1,
        matches: 3,
        finalUpdate: true,
      }),
    );
    expect(screen.getByRole("status", { name: "Find results" })).toHaveTextContent("1 of 3");

    await user.keyboard("{Enter}");
    expect(mockBridge.findInBrowserTab).toHaveBeenLastCalledWith(
      "tab-1",
      expect.objectContaining({ forward: true, findNext: false }),
    );
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(mockBridge.findInBrowserTab).toHaveBeenLastCalledWith(
      "tab-1",
      expect.objectContaining({ forward: false, findNext: false }),
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Find in page" })).not.toBeInTheDocument();
    expect(mockBridge.stopFindingInBrowserTab).toHaveBeenLastCalledWith("tab-1", true);
  });

  it("restarts find after a same-URL reload and ignores the invalidated result", async () => {
    let shortcutRelay: ((shortcut: "find") => void) | null = null;
    let stateRelay:
      | ((state: Awaited<ReturnType<CadencrBrowserBridge["listBrowserTabs"]>>) => void)
      | null = null;
    let findResultRelay:
      | ((result: {
          tabId: string;
          requestToken: string;
          activeMatchOrdinal: number;
          matches: number;
          finalUpdate: boolean;
        }) => void)
      | null = null;
    const mockBridge = bridge();
    const snapshot = await mockBridge.listBrowserTabs(1);
    mockBridge.onBrowserShortcut = vi.fn((callback) => {
      shortcutRelay = callback;
      return () => undefined;
    });
    mockBridge.onBrowserState = vi.fn((callback) => {
      stateRelay = callback;
      return () => undefined;
    });
    mockBridge.onBrowserFindResult = vi.fn((callback) => {
      findResultRelay = callback;
      return () => undefined;
    });
    setDesktopBridgeOverrideForTests(mockBridge);
    const { user } = render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
    await screen.findByDisplayValue("http://localhost:1420/");
    act(() => shortcutRelay?.("find"));
    const input = await screen.findByRole("textbox", { name: "Find in page" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "needle");
    const staleRequest = vi.mocked(mockBridge.findInBrowserTab).mock.calls.at(-1)?.[1];
    if (!staleRequest) throw new Error("Expected initial find request");
    const requestCount = vi.mocked(mockBridge.findInBrowserTab).mock.calls.length;

    act(() => stateRelay?.({ ...snapshot, tabs: [{ ...snapshot.tabs[0], loading: true }] }));
    expect(screen.getByRole("status", { name: "Find results" })).toHaveTextContent("Searching");
    act(() =>
      findResultRelay?.({
        tabId: "tab-1",
        requestToken: staleRequest.requestToken,
        activeMatchOrdinal: 1,
        matches: 99,
        finalUpdate: true,
      }),
    );
    expect(screen.getByRole("status", { name: "Find results" })).not.toHaveTextContent("99");

    act(() => stateRelay?.({ ...snapshot, tabs: [{ ...snapshot.tabs[0], loading: false }] }));
    await waitFor(() =>
      expect(vi.mocked(mockBridge.findInBrowserTab).mock.calls.length).toBe(requestCount + 1),
    );
    expect(mockBridge.findInBrowserTab).toHaveBeenLastCalledWith(
      "tab-1",
      expect.objectContaining({ query: "needle", findNext: true }),
    );
  });

  it("opens a new tab from the URL bar when every tab is closed", async () => {
    const mockBridge = bridge();
    mockBridge.listBrowserTabs = vi.fn(() =>
      Promise.resolve<BrowserStateSnapshot>({
        tabs: [],
        activeTabId: null,
        consoleEntries: [],
        networkEntries: [],
        knownOrigins: [],
        error: null,
      }),
    );
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    // With no live tab the page-scoped actions are unavailable.
    expect(await screen.findByRole("button", { name: "Add comment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "DevTools" })).toBeDisabled();

    const urlInput = screen.getByLabelText("Browser URL");
    await userEvent.clear(urlInput);
    await userEvent.type(urlInput, "localhost:4000");
    await userEvent.type(urlInput, "{Enter}");

    // Navigation with no active tab opens a fresh tab pointed at the URL
    // instead of calling navigate on a non-existent tab.
    await waitFor(() => {
      expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith(
        "http://localhost:4000/",
        "default",
        1,
      );
    });
    expect(mockBridge.navigateBrowserTab).not.toHaveBeenCalled();
  });

  it("lets the user dismiss persistent browser navigation errors", async () => {
    const mockBridge = bridge();
    mockBridge.listBrowserTabs = vi.fn(() =>
      Promise.resolve<BrowserStateSnapshot>({
        tabs: [
          {
            id: "tab-1",
            title: "Failed page",
            url: "http://localhost:5175/signup",
            loading: false,
            canGoBack: false,
            canGoForward: false,
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
        knownOrigins: [],
        error: "ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:5175/signup'",
      }),
    );
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    expect(await screen.findByText(/ERR_CONNECTION_REFUSED/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss browser error" }));

    expect(screen.queryByText(/ERR_CONNECTION_REFUSED/)).not.toBeInTheDocument();
  });

  it("batches element comments and sends them as one message with screenshots", async () => {
    const mockBridge = bridge();
    mockBridge.selectBrowserElementContext = vi.fn(() =>
      Promise.resolve({
        tabId: "tab-1",
        url: "http://localhost:1420/signup",
        title: "Signup",
        capturedAt: "2026-06-11T00:00:00.000Z",
        screenshotPngBase64: "png-base64",
        element: {
          selectorCandidates: ["#email"],
          tagName: "INPUT",
          id: "email",
          attributes: { type: "email" },
          boundingBox: { x: 10, y: 20, width: 200, height: 40 },
          computedStyles: { display: "block" },
          accessibility: { role: "textbox", name: "Email" },
        },
        diagnostics: { consoleErrors: [], failedNetworkRequests: [] },
      }),
    );
    const onSendContext = vi.fn();
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={onSendContext} />);

    // Pick an element to start a comment; the picker resolves with its context
    // and anchors an on-page badge keyed by a generated id.
    await userEvent.click(await screen.findByRole("button", { name: "Add comment" }));
    await waitFor(() => {
      expect(mockBridge.selectBrowserElementContext).toHaveBeenCalledWith(
        "tab-1",
        expect.any(String),
      );
    });

    // Write the note in the reused git CommentForm and commit it with Enter.
    expect(onSendContext).not.toHaveBeenCalled();
    const textarea = await screen.findByPlaceholderText("Add a comment...");
    await userEvent.type(textarea, "Make this required{Enter}");

    // Nothing is sent until the user presses the now-active Send button.
    expect(onSendContext).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Send/ }));

    expect(onSendContext).toHaveBeenCalledTimes(1);
    const [message, images] = onSendContext.mock.calls[0];
    expect(message).toContain("Make this required");
    expect(message).toContain("#email");
    expect(images).toEqual([{ base64: "png-base64", mimeType: "image/png" }]);
    // Sending clears the on-page badges for that tab.
    expect(mockBridge.clearBrowserCommentBadges).toHaveBeenCalledWith("tab-1");
  });

  it("keeps native Browser bounds aligned when the viewport position shifts", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    let x = 140;
    let y = 260;
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      x,
      y,
      width: 800,
      height: 500,
      top: y,
      left: x,
      right: x + 800,
      bottom: y + 500,
      toJSON: () => ({}),
    }));

    try {
      render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);
      await screen.findByDisplayValue("http://localhost:1420/");
      await waitFor(() => {
        expect(mockBridge.setBrowserBounds).toHaveBeenCalledWith(
          {
            x: 140,
            y: 260,
            width: 800,
            height: 500,
          },
          1,
        );
      });

      x = 176;
      y = 312;
      window.dispatchEvent(new Event("resize"));

      await waitFor(() => {
        expect(mockBridge.setBrowserBounds).toHaveBeenCalledWith(
          {
            x: 176,
            y: 312,
            width: 800,
            height: 500,
          },
          1,
        );
      });
    } finally {
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });
});
