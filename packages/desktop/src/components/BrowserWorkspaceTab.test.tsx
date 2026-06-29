import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { server } from "@/test/msw-server";
import { BrowserWorkspaceTab } from "./BrowserWorkspaceTab";
import { BROWSER_DEFAULT_MODE_SETTING_KEY } from "@/lib/browser-settings";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
  type CadencrBrowserBridge,
} from "@/lib/desktop-bridge";

function bridge(): CadencrBrowserBridge {
  const state = {
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
    navigateBrowserTab: vi.fn(() => Promise.resolve(state.tabs[0])),
    activateBrowserTab: vi.fn(() => Promise.resolve(state.tabs[0])),
    closeBrowserTab: vi.fn(() => Promise.resolve(state)),
    closeBrowserTabsForScope: vi.fn(() => Promise.resolve(state)),
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
    browserBack: vi.fn(),
    browserForward: vi.fn(),
    browserReload: vi.fn(),
    browserStop: vi.fn(),
    browserZoomIn: vi.fn(),
    browserZoomOut: vi.fn(),
    toggleBrowserDevTools: vi.fn(() => Promise.resolve(state.tabs[0])),
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
    onBrowserShortcut: vi.fn(() => () => undefined),
    onBrowserCommentBadgeClick: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    fetchChangelog: vi.fn(),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

describe("BrowserWorkspaceTab", () => {
  beforeEach(() => {
    clearDesktopBridgeOverrideForTests();
  });

  it("creates a normal tab that reuses cookies by default", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "New browser tab" }));

    expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith(undefined, "default", 1);
  });

  it("opens a private tab with no cookies when Private mode is selected", async () => {
    const mockBridge = bridge();
    setDesktopBridgeOverrideForTests(mockBridge);
    render(<BrowserWorkspaceTab scopeId={1} onSendContext={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Private" }));
    await userEvent.click(screen.getByRole("button", { name: "New browser tab" }));

    expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith(undefined, "fresh", 1);
  });

  it("opens the first tab in the saved default mode", async () => {
    // Default mode persisted as "private" should seed the very first tab the
    // bootstrap creates with the ephemeral "fresh" profile.
    server.use(
      http.get(
        `http://127.0.0.1:5005/api/workspace/settings/${BROWSER_DEFAULT_MODE_SETTING_KEY}`,
        () => HttpResponse.json({ value: "private" }),
      ),
    );
    const mockBridge = bridge();
    mockBridge.listBrowserTabs = vi.fn(() =>
      Promise.resolve({
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

  it("does not render console or network diagnostics in the Browser footer", async () => {
    const mockBridge = bridge();
    mockBridge.listBrowserTabs = vi.fn(() =>
      Promise.resolve({
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
    await userEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() => {
      expect(mockBridge.navigateBrowserTab).toHaveBeenCalledWith("tab-1", "localhost:3000");
    });
  });

  it("opens a new tab from the URL bar when every tab is closed", async () => {
    const mockBridge = bridge();
    mockBridge.listBrowserTabs = vi.fn(() =>
      Promise.resolve({
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
    await userEvent.click(screen.getByRole("button", { name: "Go" }));

    // Navigation with no active tab opens a fresh tab pointed at the URL
    // instead of calling navigate on a non-existent tab.
    await waitFor(() => {
      expect(mockBridge.createBrowserTab).toHaveBeenLastCalledWith("localhost:4000", "default", 1);
    });
    expect(mockBridge.navigateBrowserTab).not.toHaveBeenCalled();
  });

  it("lets the user dismiss persistent browser navigation errors", async () => {
    const mockBridge = bridge();
    mockBridge.listBrowserTabs = vi.fn(() =>
      Promise.resolve({
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
