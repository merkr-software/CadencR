import { describe, expect, it, vi } from "vitest";
import { dispatchBrowserMcpTool, type BrowserMcpTarget } from "./browser-mcp-dispatch";
import type { BrowserTabMetadata } from "./browser-types";

vi.mock("./runtime-config", () => ({ refreshBrowserOriginPolicy: vi.fn(async () => undefined) }));

function tabMeta(): BrowserTabMetadata {
  return {
    id: "tab-1",
    title: "App",
    url: "http://localhost:3000",
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
    scopeId: null,
  };
}

function target(): BrowserMcpTarget {
  const state = vi.fn(() => ({
    tabs: [],
    activeTabId: "tab-1",
    consoleEntries: [],
    networkEntries: [],
    error: null,
  }));
  return {
    state,
    automation: { state, assert: vi.fn(), guard: vi.fn(() => vi.fn()) },
    openUrl: vi.fn(async () => tabMeta()),
    openExternalUrl: vi.fn(async () => tabMeta()),
    restoreScopeMetadata: vi.fn(async () => state()),
    closeTabsForScope: vi.fn(async () => ({ ...state(), tabs: [] })),
    inspection: {
      snapshot: vi.fn(async () => ({ found: true, outline: "[e1] button" })),
      screenshot: vi.fn(async () => "fullpng"),
      screenshotTarget: vi.fn(async () => "elpng"),
      evaluate: vi.fn(async () => ({ ok: true, result: 42 })),
      click: vi.fn(async () => undefined),
      clickTarget: vi.fn(async () => ({ center: { x: 5, y: 6 } })),
      fill: vi.fn(async () => undefined),
      hover: vi.fn(async () => ({ center: { x: 1, y: 2 } })),
      waitFor: vi.fn(async () => ({ found: true, elapsedMs: 5 })),
      typeText: vi.fn(async () => undefined),
      keypress: vi.fn(async () => undefined),
      selectElementContext: vi.fn(async () => ({ ok: true })),
    },
  };
}

describe("dispatchBrowserMcpTool", () => {
  it("serializes browser_list_tabs state as JSON text", async () => {
    const fake = target();
    await expect(dispatchBrowserMcpTool(fake, "browser_list_tabs", {})).resolves.toEqual({
      text: JSON.stringify(fake.state()),
    });
  });

  it("opens a URL and waits for it to settle", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_open_url", {
      url: "http://localhost:3000",
    });
    expect(fake.openUrl).toHaveBeenCalledWith("http://localhost:3000", {
      tabId: undefined,
      newTab: false,
      scopeId: undefined,
    });
  });

  it("discards an in-flight read result after sharing is revoked", async () => {
    const fake = target();
    let shared = true;
    let finish: (value: unknown) => void = () => {
      throw new Error("Snapshot did not start.");
    };
    fake.automation.assert = vi.fn(() => {
      if (!shared) throw new Error("Browser tab is not shared with the agent.");
    });
    fake.automation.guard = vi.fn(() => () => fake.automation.assert("tab-1", null));
    fake.inspection.snapshot = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const pending = dispatchBrowserMcpTool(fake, "browser_get_snapshot", {});
    await vi.waitFor(() => expect(fake.inspection.snapshot).toHaveBeenCalledOnce());
    shared = false;
    finish({ secret: "must not escape" });

    await expect(pending).rejects.toThrow("not shared");
  });

  it("rechecks sharing after delayed target resolution before clicking", async () => {
    const fake = target();
    let shared = true;
    let finish: () => void = () => {
      throw new Error("Click did not start.");
    };
    let mutated = false;
    const assertShared = (): void => {
      if (!shared) throw new Error("Browser tab is not shared with the agent.");
    };
    fake.automation.assert = vi.fn(assertShared);
    fake.automation.guard = vi.fn(() => assertShared);
    fake.inspection.clickTarget = vi.fn(
      (_tabId, _target, authorize) =>
        new Promise((resolve, reject) => {
          finish = () => {
            try {
              authorize?.();
            } catch (error) {
              reject(error);
              throw error;
            }
            mutated = true;
            resolve({ ok: true });
          };
        }),
    );
    const pending = dispatchBrowserMcpTool(fake, "browser_click", { ref: "e1" });
    await vi.waitFor(() => expect(fake.inspection.clickTarget).toHaveBeenCalledOnce());
    shared = false;
    expect(() => finish()).toThrow("not shared");

    await expect(pending).rejects.toThrow("not shared");
    expect(mutated).toBe(false);
  });

  it("forwards new_tab for browser_open_url", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_open_url", {
      url: "http://localhost:3000",
      new_tab: true,
    });
    expect(fake.openUrl).toHaveBeenCalledWith("http://localhost:3000", {
      tabId: undefined,
      newTab: true,
      scopeId: undefined,
    });
  });

  it("navigates an existing tab when browser_open_url includes tab_id", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_open_url", {
      tab_id: "tab-1",
      url: "http://localhost:3000",
    });
    expect(fake.openUrl).toHaveBeenCalledWith("http://localhost:3000", {
      tabId: "tab-1",
      newTab: false,
      scopeId: undefined,
    });
  });

  it("opens an agent tab in the calling feature's scope", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_open_url", { url: "http://localhost:3000" }, 42);
    expect(fake.openUrl).toHaveBeenCalledWith("http://localhost:3000", {
      tabId: undefined,
      newTab: false,
      scopeId: 42,
    });
  });

  it("closes every tab of the given feature scope for archive cleanup", async () => {
    const fake = target();
    vi.mocked(fake.restoreScopeMetadata).mockResolvedValue({
      ...fake.state(),
      tabs: [tabMeta(), tabMeta()],
    });
    await expect(dispatchBrowserMcpTool(fake, "browser_close_scope_tabs", {}, 42)).resolves.toEqual(
      { text: JSON.stringify({ closed_tabs: 2 }) },
    );
    expect(fake.restoreScopeMetadata).toHaveBeenCalledWith(42);
    expect(fake.closeTabsForScope).toHaveBeenCalledWith(42);
    await expect(dispatchBrowserMcpTool(fake, "browser_close_scope_tabs", {})).rejects.toThrow(
      "needs a feature scope",
    );
  });

  it("routes browser_open_external_url to the external opener", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_open_external_url", {
      url: "https://example.com",
    });
    expect(fake.openExternalUrl).toHaveBeenCalledWith("https://example.com", {
      tabId: undefined,
      newTab: false,
      scopeId: undefined,
    });
  });

  it("forwards new_tab for browser_open_external_url", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_open_external_url", {
      url: "https://example.com",
      new_tab: true,
    });
    expect(fake.openExternalUrl).toHaveBeenCalledWith("https://example.com", {
      tabId: undefined,
      newTab: true,
      scopeId: undefined,
    });
  });

  it("passes selector, max_length and format to browser_get_snapshot", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_get_snapshot", {
      selector: "#root",
      max_length: 1000,
      format: "html",
    });
    expect(fake.inspection.snapshot).toHaveBeenCalledWith("tab-1", "#root", 1000, "html");
  });

  it("returns a full-page screenshot as viewable image content", async () => {
    const fake = target();
    const result = await dispatchBrowserMcpTool(fake, "browser_screenshot", {});
    expect(fake.inspection.screenshot).toHaveBeenCalledWith("tab-1", undefined);
    expect(result.image).toEqual({ mimeType: "image/png", data: "fullpng" });
  });

  it("captures a region screenshot from a selector", async () => {
    const fake = target();
    const result = await dispatchBrowserMcpTool(fake, "browser_screenshot", {
      selector: ".hero",
    });
    expect(fake.inspection.screenshotTarget).toHaveBeenCalledWith(
      "tab-1",
      { selector: ".hero", ref: undefined },
      expect.any(Function),
    );
    expect(fake.inspection.screenshot).not.toHaveBeenCalled();
    expect(result.image).toEqual({ mimeType: "image/png", data: "elpng" });
  });

  it("captures a region screenshot from a ref", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_screenshot", { ref: "e7" });
    expect(fake.inspection.screenshotTarget).toHaveBeenCalledWith(
      "tab-1",
      { selector: undefined, ref: "e7" },
      expect.any(Function),
    );
  });

  it("captures a region screenshot from an explicit clip", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_screenshot", {
      clip: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(fake.inspection.screenshot).toHaveBeenCalledWith("tab-1", {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("requires a script for browser_evaluate", async () => {
    await expect(dispatchBrowserMcpTool(target(), "browser_evaluate", {})).rejects.toThrow(
      "script",
    );
  });

  it("clicks by coordinates when no selector or ref is given", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_click", { x: 12, y: 34 });
    expect(fake.inspection.click).toHaveBeenCalledWith("tab-1", 12, 34);
    expect(fake.inspection.clickTarget).not.toHaveBeenCalled();
  });

  it("clicks by ref when one is supplied", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_click", { ref: "e3" });
    expect(fake.inspection.clickTarget).toHaveBeenCalledWith(
      "tab-1",
      { selector: undefined, ref: "e3" },
      expect.any(Function),
    );
    expect(fake.inspection.click).not.toHaveBeenCalled();
  });

  it("requires coordinates when browser_click has no target", async () => {
    await expect(dispatchBrowserMcpTool(target(), "browser_click", {})).rejects.toThrow("x");
  });

  it("fills a field by selector and reports ok", async () => {
    const fake = target();
    const result = await dispatchBrowserMcpTool(fake, "browser_fill", {
      selector: "#email",
      value: "a@b.c",
    });
    expect(fake.inspection.fill).toHaveBeenCalledWith(
      "tab-1",
      { selector: "#email", ref: undefined },
      "a@b.c",
    );
    expect(result).toEqual({ text: JSON.stringify({ ok: true }) });
  });

  it("requires a value for browser_fill", async () => {
    await expect(
      dispatchBrowserMcpTool(target(), "browser_fill", { selector: "#email" }),
    ).rejects.toThrow("value");
  });

  it("hovers an element by ref", async () => {
    const fake = target();
    await dispatchBrowserMcpTool(fake, "browser_hover", { ref: "e2" });
    expect(fake.inspection.hover).toHaveBeenCalledWith(
      "tab-1",
      { selector: undefined, ref: "e2" },
      expect.any(Function),
    );
  });

  it("waits for a selector and serializes the result", async () => {
    const fake = target();
    const result = await dispatchBrowserMcpTool(fake, "browser_wait_for", {
      selector: "#ready",
      timeout_ms: 2000,
    });
    expect(fake.inspection.waitFor).toHaveBeenCalledWith(
      "tab-1",
      { selector: "#ready", text: undefined },
      2000,
    );
    expect(result).toEqual({
      text: JSON.stringify({ found: true, elapsedMs: 5 }),
    });
  });

  it("requires a selector or text for browser_wait_for", async () => {
    await expect(dispatchBrowserMcpTool(target(), "browser_wait_for", {})).rejects.toThrow(
      "selector or text",
    );
  });

  it("filters console entries by level and limit", async () => {
    const fake = target();
    vi.mocked(fake.automation.state).mockReturnValue({
      tabs: [],
      activeTabId: "tab-1",
      consoleEntries: [
        {
          id: "1",
          tabId: "t",
          level: "info",
          message: "a",
          sourceUrl: "",
          lineNumber: 0,
          timestamp: "",
        },
        {
          id: "2",
          tabId: "t",
          level: "error",
          message: "boom",
          sourceUrl: "",
          lineNumber: 0,
          timestamp: "",
        },
      ],
      networkEntries: [],
      error: null,
    });
    const result = await dispatchBrowserMcpTool(fake, "browser_get_console", {
      level: "error",
    });
    const parsed = JSON.parse(result.text) as Array<{ level: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].level).toBe("error");
  });

  it("filters network entries and omits headers by default", async () => {
    const fake = target();
    vi.mocked(fake.automation.state).mockReturnValue({
      tabs: [],
      activeTabId: "tab-1",
      consoleEntries: [],
      networkEntries: [
        {
          id: "1",
          tabId: "t",
          method: "GET",
          url: "http://localhost/ok",
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          timestamp: "",
        },
        {
          id: "2",
          tabId: "t",
          method: "GET",
          url: "http://localhost/bad",
          status: 500,
          requestHeaders: { a: "b" },
          responseHeaders: {},
          timestamp: "",
        },
      ],
      error: null,
    });
    const result = await dispatchBrowserMcpTool(fake, "browser_get_network", {
      failed_only: true,
    });
    const parsed = JSON.parse(result.text) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe("http://localhost/bad");
    expect(parsed[0]).not.toHaveProperty("requestHeaders");
  });

  it("includes network headers when requested", async () => {
    const fake = target();
    vi.mocked(fake.automation.state).mockReturnValue({
      tabs: [],
      activeTabId: "tab-1",
      consoleEntries: [],
      networkEntries: [
        {
          id: "1",
          tabId: "t",
          method: "GET",
          url: "http://localhost/x",
          status: 200,
          requestHeaders: { a: "b" },
          responseHeaders: {},
          timestamp: "",
        },
      ],
      error: null,
    });
    const result = await dispatchBrowserMcpTool(fake, "browser_get_network", {
      include_headers: true,
    });
    const parsed = JSON.parse(result.text) as Array<Record<string, unknown>>;
    expect(parsed[0]).toHaveProperty("requestHeaders", { a: "b" });
  });

  it("throws when a tab-scoped tool has no active tab", async () => {
    const fake = target();
    vi.mocked(fake.automation.state).mockReturnValue({
      tabs: [],
      activeTabId: null,
      consoleEntries: [],
      networkEntries: [],
      error: null,
    });
    await expect(dispatchBrowserMcpTool(fake, "browser_screenshot", {})).rejects.toThrow(
      "No active browser tab",
    );
  });

  it("throws for unknown tools", async () => {
    await expect(dispatchBrowserMcpTool(target(), "browser_launch_missiles", {})).rejects.toThrow(
      "Unknown Browser MCP tool",
    );
  });
});
