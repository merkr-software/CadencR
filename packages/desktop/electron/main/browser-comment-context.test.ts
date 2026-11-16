import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserElementContext, BrowserTabMetadata } from "./browser-types";

const captureElementContext = vi.hoisted(() => vi.fn());

vi.mock("./browser-dom", () => ({ captureElementContext }));

const { isPinnedCommentBadge, removeCommentBadge, selectElementContext } =
  await import("./browser-comment-context");

function context(tabId: string): BrowserElementContext {
  return {
    tabId,
    url: "https://example.test/refreshed",
    title: "Refreshed",
    capturedAt: "2026-08-10T00:00:00.000Z",
    screenshotPngBase64: "image",
    element: {
      selectorCandidates: ["button"],
      tagName: "button",
      attributes: {},
      boundingBox: { x: 1, y: 2, width: 3, height: 4 },
      computedStyles: {},
    },
    diagnostics: { consoleErrors: [], failedNetworkRequests: [] },
  };
}

function metadata(): BrowserTabMetadata {
  return {
    id: "tab-1",
    title: "Original",
    url: "https://example.test/original",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sessionProfileId: "fresh",
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
  };
}

describe("selectElementContext", () => {
  beforeEach(() => captureElementContext.mockReset());

  it("re-arms the picker in the replacement document after a page refresh", async () => {
    const contents = Object.assign(new EventEmitter(), {
      executeJavaScript: vi.fn(async () => undefined),
      getURL: () => "https://example.test/refreshed",
      getZoomFactor: vi.fn(() => 1.2),
      isDestroyed: vi.fn(() => false),
      isLoading: vi.fn(() => true),
    });
    const tab = {
      metadata: metadata(),
      view: { webContents: contents },
      webContents: contents,
      devtoolsView: null,
      consoleEntries: [],
      networkEntries: [],
      externalAutomationOrigin: null,
    };
    captureElementContext
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(context("tab-1"));

    const selection = selectElementContext(tab as unknown as ManagedTab, "anchor-1");
    contents.emit("did-start-navigation", {
      url: tab.metadata.url,
      isSameDocument: false,
      isMainFrame: true,
    });
    tab.metadata = { ...tab.metadata, url: "https://example.test/refreshed", title: "Refreshed" };
    await vi.waitFor(() => expect(contents.listenerCount("did-stop-loading")).toBe(1));
    expect(captureElementContext).toHaveBeenCalledOnce();
    contents.isLoading.mockReturnValue(false);
    contents.emit("did-stop-loading");

    await expect(selection).resolves.toEqual(context("tab-1"));
    expect(captureElementContext).toHaveBeenCalledTimes(2);
    expect(captureElementContext.mock.calls[1][1]).toMatchObject({
      url: "https://example.test/refreshed",
      title: "Refreshed",
    });
    expect(captureElementContext.mock.calls[1][3]).toBe("anchor-1");
    const screenshotScale = captureElementContext.mock.calls[1][4];
    expect(screenshotScale).toBeTypeOf("function");
    expect(screenshotScale()).toBe(1.2);
    contents.getZoomFactor.mockReturnValue(1.4);
    expect(screenshotScale()).toBe(1.4);
    expect(contents.executeJavaScript).toHaveBeenCalledOnce();
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    expect(contents.listenerCount("destroyed")).toBe(0);
  });

  it("trusts badge clicks only for anchors it pinned, until the badge is removed", async () => {
    const contents = Object.assign(new EventEmitter(), {
      executeJavaScript: vi.fn(async () => undefined),
      getURL: () => "https://example.test/original",
      getZoomFactor: vi.fn(() => 1),
      isDestroyed: vi.fn(() => false),
    });
    const tab = {
      metadata: metadata(),
      webContents: contents,
      consoleEntries: [],
      networkEntries: [],
    } as unknown as ManagedTab;
    captureElementContext.mockResolvedValueOnce(context("tab-1"));

    await selectElementContext(tab, "anchor-1");
    expect(isPinnedCommentBadge(tab, "anchor-1")).toBe(true);
    expect(isPinnedCommentBadge(tab, "forged-anchor")).toBe(false);

    await removeCommentBadge(tab, "anchor-1");
    expect(isPinnedCommentBadge(tab, "anchor-1")).toBe(false);
  });
});
