import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAutomationAuthority } from "./browser-automation-authority";
import { invalidateBrowserDocument } from "./browser-document-security";
import { metadataFor } from "./browser-manager-utils";
import { dispatchBrowserMcpTool, type BrowserMcpTarget } from "./browser-mcp-dispatch";
import { assertBrowserAgentUrl } from "./browser-policy";
import * as runtime from "./runtime-config";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserAgentAccess } from "./browser-types";

function target(url: string, access: BrowserAgentAccess = "shared") {
  const metadata = { ...metadataFor("tab", "fresh", 7), url, title: "Private title" };
  const webContents = {
    mainFrame: { detached: false, framesInSubtree: [] },
    getURL: () => url,
    isDestroyed: () => false,
  };
  const tab = {
    metadata,
    webContents,
    automationAccess: access,
    externalAutomationOrigin: new URL(url).origin,
  } as unknown as ManagedTab;
  const state = () => ({
    tabs: [tab.metadata],
    activeTabId: "tab",
    error: null,
    consoleEntries: [
      {
        id: "console",
        tabId: "tab",
        level: "error",
        message: "private console",
        sourceUrl: url,
        lineNumber: 1,
        timestamp: "",
      },
    ],
    networkEntries: [
      {
        id: "network",
        tabId: "tab",
        method: "GET",
        url,
        timestamp: "",
        requestHeaders: {},
        responseHeaders: {},
      },
    ],
  });
  const read = vi.fn(async () => ({ private: "must not escape" }));
  const action = vi.fn(async () => undefined);
  const fake: BrowserMcpTarget = {
    state,
    automation: new BrowserAutomationAuthority(new Map([["tab", tab]]), state),
    openUrl: vi.fn(async () => metadata),
    openExternalUrl: vi.fn(async () => metadata),
    restoreScopeMetadata: vi.fn(async () => state()),
    closeTabsForScope: vi.fn(async () => state()),
    inspection: {
      snapshot: read,
      screenshot: vi.fn(async () => "private-png"),
      screenshotTarget: vi.fn(async () => "private-png"),
      evaluate: read,
      click: action,
      clickTarget: read,
      fill: action,
      hover: read,
      waitFor: read,
      typeText: action,
      keypress: action,
      selectElementContext: read,
    },
  };
  return { fake, tab, read, action };
}

const tools: Array<[string, Record<string, unknown>]> = [
  ["browser_get_snapshot", {}],
  ["browser_screenshot", {}],
  ["browser_screenshot", { ref: "e1" }],
  ["browser_evaluate", { script: "document.body.innerText" }],
  ["browser_click", { ref: "e1" }],
  ["browser_click", { x: 1, y: 1 }],
  ["browser_fill", { ref: "e1", value: "secret" }],
  ["browser_hover", { ref: "e1" }],
  ["browser_wait_for", { selector: "body" }],
  ["browser_type", { text: "secret" }],
  ["browser_keypress", { key: "Enter" }],
  ["browser_select_element_context", {}],
];

beforeEach(() => {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:1420");
  runtime.setBrowserRemoteOrigins(["https://tunnel.example.test", "https://127.0.0.1:9123"]);
  vi.spyOn(runtime, "refreshBrowserOriginPolicy").mockResolvedValue(undefined);
});

describe.each([
  "file:///private/secret.html",
  "about:blank",
  "http://127.0.0.1:5005/api/remote/pairing-code#secret",
  "http://localhost.:1420/#private",
  "https://[::1]:9123/#private",
  "https://100.100.1.2:9123/#private",
  "https://tunnel.example.test/#private",
])("MCP denied page %s", (url) => {
  it.each(tools)("rejects %s before inspection or input", async (name, args) => {
    const { fake } = target(url);
    await expect(dispatchBrowserMcpTool(fake, name, { ...args, tab_id: "tab" }, 7)).rejects.toThrow(
      "cannot inspect",
    );
    for (const operation of Object.values(fake.inspection))
      expect(operation).not.toHaveBeenCalled();
  });

  it("omits metadata, console and network from every aggregate read", async () => {
    const { fake } = target(url, "agent");
    for (const name of ["browser_list_tabs", "browser_get_console", "browser_get_network"]) {
      const result = await dispatchBrowserMcpTool(fake, name, {}, 7);
      expect(result.text).not.toContain("private");
      expect(result.text).not.toContain("Private title");
      expect(result.text).not.toContain(url);
    }
  });
});

it("keeps normal localhost development automation available", async () => {
  const { fake } = target("http://localhost:3000/");
  await expect(
    dispatchBrowserMcpTool(fake, "browser_get_snapshot", { tab_id: "tab" }, 7),
  ).resolves.toEqual({ text: JSON.stringify({ private: "must not escape" }) });
  expect(() => assertBrowserAgentUrl("http://localhost:3000/")).not.toThrow();
});

it.each(["file:///private/secret.html", "http://localhost:5005/", "https://tunnel.example.test/"])(
  "rejects %s at both opener policies",
  (url) => {
    expect(() => assertBrowserAgentUrl(url)).toThrow();
    expect(() => assertBrowserAgentUrl(url, true)).toThrow();
  },
);

it("discards a same-URL document replacement while a read is pending", async () => {
  const { fake, tab } = target("http://localhost:3000/");
  let finish: (value: unknown) => void = () => {
    throw new Error("read not started");
  };
  fake.inspection.snapshot = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = dispatchBrowserMcpTool(fake, "browser_get_snapshot", { tab_id: "tab" }, 7);
  await vi.waitFor(() => expect(fake.inspection.snapshot).toHaveBeenCalledOnce());
  invalidateBrowserDocument(tab.webContents);
  finish({ secret: "must not escape" });
  await expect(result).rejects.toThrow("page changed");
});

it("fails closed without a verified listener policy", () => {
  const { fake } = target("http://localhost:3000/");
  runtime.setBrowserOriginPolicyReady(false);
  expect(fake.automation.state(7).tabs).toEqual([]);
  expect(() => fake.automation.assert("tab", 7)).toThrow("cannot inspect");
  expect(() => assertBrowserAgentUrl("http://localhost:3000/")).toThrow("unavailable");
});

it("rejects a safe parent with a privileged frame loaded before the tab was shared", async () => {
  const { fake, tab } = target("http://localhost:3000/");
  Object.assign(tab.webContents, {
    mainFrame: { framesInSubtree: [{ url: "http://localhost:1420/#private-pairing-code" }] },
  });
  await expect(
    dispatchBrowserMcpTool(fake, "browser_screenshot", { tab_id: "tab" }, 7),
  ).rejects.toThrow("cannot inspect");
  expect(fake.inspection.screenshot).not.toHaveBeenCalled();
  expect(fake.automation.state(7).tabs).toEqual([]);
});

it.each(["about:blank", "file:///private/secret.html", "detached"])(
  "handles cached child frame %s safely",
  (url) => {
    const { fake, tab } = target("http://localhost:3000/");
    Object.assign(tab.webContents, {
      mainFrame: { detached: false, framesInSubtree: [{ url, detached: url === "detached" }] },
    });
    if (url === "about:blank") expect(() => fake.automation.assert("tab", 7)).not.toThrow();
    else expect(() => fake.automation.assert("tab", 7)).toThrow("cannot inspect");
  },
);

it("fails closed when Electron invalidates the frame handle while reading it", () => {
  const { fake, tab } = target("http://localhost:3000/");
  Object.defineProperty(tab.webContents, "mainFrame", {
    get: () => {
      throw new Error("Render frame was disposed");
    },
  });
  expect(() => fake.automation.assert("tab", 7)).toThrow("cannot inspect");
  expect(fake.automation.state(7).tabs).toEqual([]);
});
