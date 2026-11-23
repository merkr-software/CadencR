import type { Input } from "electron";
import { describe, expect, it, vi } from "vitest";
import { guestChrome } from "./browser-tab-events";
import type { BrowserTabError } from "./browser-types";

// Build a guest-page keydown. `mod` maps to the platform's primary modifier
// (Meta on macOS, Control elsewhere) so the assertions hold on any host.
function keyDown(overrides: Partial<Input> & { key: string }): Input {
  return {
    type: "keyDown",
    code: "",
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...overrides,
  } as Input;
}

function withMod(overrides: Partial<Input> & { key: string }): Input {
  const modKey = process.platform === "darwin" ? { meta: true } : { control: true };
  return keyDown({ ...overrides, ...modKey });
}

describe("guestChrome", () => {
  it("maps the plain modifier chords", () => {
    expect(guestChrome(withMod({ key: "t" }))).toBe("new-tab");
    expect(guestChrome(withMod({ key: "w" }))).toBe("close-tab");
    expect(guestChrome(withMod({ key: "l" }))).toBe("focus-url");
    expect(guestChrome(withMod({ key: "s" }))).toBe("add-comment");
    expect(guestChrome(withMod({ key: "r" }))).toBe("reload");
  });

  it("maps the zoom chords, including the shifted ⌘+ form", () => {
    expect(guestChrome(withMod({ key: "=" }))).toBe("zoom-in");
    expect(guestChrome(withMod({ key: "+", shift: true }))).toBe("zoom-in");
    expect(guestChrome(withMod({ key: "-" }))).toBe("zoom-out");
  });

  it("maps the feature-pane chords (layout-aware via key, not code)", () => {
    expect(guestChrome(withMod({ key: "a", code: "KeyA", shift: true }))).toBe("pane-agent");
    expect(guestChrome(withMod({ key: "t", code: "KeyT", shift: true }))).toBe("pane-terminal");
    expect(guestChrome(withMod({ key: "g", code: "KeyG", shift: true }))).toBe("pane-git");
    expect(guestChrome(withMod({ key: "e", code: "KeyE", shift: true }))).toBe("pane-editor");
    expect(guestChrome(withMod({ key: "b", code: "KeyB", shift: true }))).toBe("pane-browser");
    expect(guestChrome(withMod({ key: "m", code: "Semicolon", shift: true }))).toBeNull();
  });

  it("leaves Alt-modified DevTools chords to the registry matcher", () => {
    expect(guestChrome(withMod({ key: "i", alt: true }))).toBeNull();
    expect(guestChrome(withMod({ key: "j", alt: true }), "devtools")).toBe("devtools");
    expect(guestChrome(withMod({ key: "j", alt: true }))).toBeNull();
  });

  it("switches tabs via the physical bracket code, since Shift mangles the key", () => {
    // Shift turns "[" into "{" / "]" into "}", so the relay must match `code`.
    expect(guestChrome(withMod({ key: "{", code: "BracketLeft", shift: true }))).toBe("prev-tab");
    expect(guestChrome(withMod({ key: "}", code: "BracketRight", shift: true }))).toBe("next-tab");
  });

  it("ignores a Shift chord on an unmapped key", () => {
    expect(guestChrome(withMod({ key: "j", code: "KeyJ", shift: true }))).toBeNull();
    expect(guestChrome(withMod({ key: "k", code: "KeyK", shift: true }))).toBeNull();
  });

  it("ignores keys without the platform modifier", () => {
    expect(guestChrome(keyDown({ key: "t" }))).toBeNull();
    expect(guestChrome(keyDown({ key: "l" }))).toBeNull();
  });

  it("ignores key-up events", () => {
    expect(guestChrome(withMod({ key: "t", type: "keyUp" }))).toBeNull();
  });

  it("returns null for an unmapped modifier chord", () => {
    expect(guestChrome(withMod({ key: "k" }))).toBeNull();
  });
});

describe("document authorization events", () => {
  it("invalidates delayed automation and clears retained diagnostics using Electron event details", async () => {
    const { EventEmitter } = await import("node:events");
    const { installTabEvents } = await import("./browser-tab-events");
    const { browserDocumentRevision } = await import("./browser-document-security");
    const contents = Object.assign(new EventEmitter(), { getURL: () => "http://localhost:3000/" });
    const tab = {
      metadata: { id: "tab", url: "http://localhost:3000/", scopeId: 7 },
      webContents: contents,
      automationAccess: "shared",
      externalAutomationOrigin: "https://approved.test",
      consoleEntries: [{ message: "private" }],
      networkEntries: [{ url: "https://private.test" }],
    } as unknown as import("./browser-tab-events").ManagedTab;
    const noop = (): void => undefined;
    const host = {
      emitState: noop,
      setTabError: () => false,
      isTabAlive: () => true,
      tabDestroyed: noop,
      recordHistoryNavigation: noop,
      updateHistoryTitle: noop,
      forgetHistory: noop,
      emitShortcut: noop,
      matchGuestShortcut: () => null,
      emitFindResult: noop,
      invalidateFind: noop,
      syncZoom: noop,
      persistTab: noop,
      emitCommentBadgeClick: noop,
    };
    installTabEvents(tab, host);
    contents.emit("did-start-navigation", {
      url: "http://localhost:3000/next",
      isMainFrame: false,
      isSameDocument: false,
    });
    expect(browserDocumentRevision(tab.webContents)).toBe(0);
    contents.emit("did-start-navigation", {
      url: "http://localhost:3000/",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(browserDocumentRevision(tab.webContents)).toBe(1);
    expect(tab.consoleEntries).toEqual([]);
    expect(tab.networkEntries).toEqual([]);
    expect(tab.externalAutomationOrigin).toBeNull();
  });
});

describe("tab error and navigation lifecycle events", () => {
  async function setupEvents(automationAccess: "user" | "shared" | "agent" = "shared") {
    const { EventEmitter } = await import("node:events");
    const { installTabEvents } = await import("./browser-tab-events");
    const contents = Object.assign(new EventEmitter(), {
      getURL: vi.fn(() => "http://localhost:3000/"),
      getTitle: vi.fn(() => "App"),
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      isDestroyed: vi.fn(() => false),
    });
    const tab = {
      metadata: {
        id: "tab-1",
        title: "App",
        url: "http://localhost:3000/",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        sessionProfileId: "default",
        isActive: true,
        devToolsOpen: false,
        pinned: false,
        suspended: false,
        zoomPercent: 100,
        scopeId: 7,
      },
      webContents: contents,
      automationAccess,
      externalAutomationOrigin: null,
      consoleEntries: [],
      networkEntries: [],
      pendingSessionTasks: new Set<Promise<void>>(),
    } as unknown as import("./browser-tab-events").ManagedTab;
    let currentError: BrowserTabError | null = null;
    const emitState = vi.fn();
    const setTabError = vi.fn((next: BrowserTabError | null) => {
      const changed = currentError !== next;
      currentError = next;
      return changed;
    });
    const noop = (): void => undefined;
    const host = {
      emitState,
      setTabError,
      isTabAlive: () => true,
      tabDestroyed: noop,
      recordHistoryNavigation: noop,
      updateHistoryTitle: noop,
      forgetHistory: noop,
      emitShortcut: noop,
      matchGuestShortcut: () => null,
      emitFindResult: noop,
      invalidateFind: noop,
      syncZoom: noop,
      persistTab: noop,
      emitCommentBadgeClick: noop,
    };
    installTabEvents(tab, host);
    return { contents, tab, host, emitState, setTabError, getError: () => currentError };
  }

  it("ignores subframe and ERR_ABORTED load failures and formats main-frame load errors", async () => {
    const { contents, emitState, setTabError, getError } = await setupEvents();

    contents.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "https://subframe.example/",
      false,
    );
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://localhost:3000/", true);
    expect(setTabError).not.toHaveBeenCalled();
    expect(emitState).not.toHaveBeenCalled();

    contents.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "http://localhost:3000/",
      true,
    );
    expect(setTabError).toHaveBeenCalledOnce();
    expect(emitState).toHaveBeenCalledOnce();
    expect(getError()).toMatchObject({
      kind: "load",
      title: "Can't connect to localhost:3000",
      code: "ERR_CONNECTION_REFUSED",
      url: "http://localhost:3000/",
      retryable: true,
    });
  });

  it("surfaces renderer crashes as structured errors, clears loading, and ignores clean exits", async () => {
    const { contents, tab, emitState, setTabError, getError } = await setupEvents();
    tab.metadata = { ...tab.metadata, loading: true };

    contents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
    expect(setTabError).not.toHaveBeenCalled();
    expect(tab.metadata.loading).toBe(true);

    contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 1 });
    expect(tab.metadata.loading).toBe(false);
    expect(getError()).toMatchObject({
      kind: "crash",
      title: "This page ran out of memory",
      code: "oom",
      url: "http://localhost:3000/",
      retryable: true,
    });
    expect(emitState).toHaveBeenCalledOnce();
  });

  it("revokes shared access on cross-origin navigation or redirect while preserving agent tabs", async () => {
    const shared = await setupEvents("shared");
    shared.tab.externalAutomationOrigin = "http://localhost:3000";

    // Same-origin navigation keeps sharing intact.
    shared.contents.emit("did-start-navigation", {
      url: "http://localhost:3000/dashboard",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(shared.tab.automationAccess).toBe("shared");
    expect(shared.tab.externalAutomationOrigin).toBe("http://localhost:3000");

    // Cross-origin navigation revokes sharing back to user and emits state.
    shared.emitState.mockClear();
    shared.contents.emit("did-start-navigation", {
      url: "https://other.example.com/",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(shared.tab.automationAccess).toBe("user");
    expect(shared.tab.metadata.agentAccess).toBe("user");
    expect(shared.tab.externalAutomationOrigin).toBeNull();
    expect(shared.emitState).toHaveBeenCalledOnce();

    // Cross-origin redirect also revokes sharing.
    shared.tab.automationAccess = "shared";
    shared.tab.metadata = { ...shared.tab.metadata, agentAccess: "shared" };
    shared.tab.externalAutomationOrigin = "http://localhost:3000";
    shared.emitState.mockClear();
    shared.contents.emit("will-redirect", {
      url: "https://redirected.example.com/",
      isMainFrame: true,
      preventDefault: vi.fn(),
    });
    expect(shared.tab.automationAccess).toBe("user");
    expect(shared.tab.metadata.agentAccess).toBe("user");
    expect(shared.tab.externalAutomationOrigin).toBeNull();
    expect(shared.emitState).toHaveBeenCalledOnce();

    // Cross-origin did-navigate also revokes sharing.
    shared.tab.automationAccess = "shared";
    shared.tab.metadata = { ...shared.tab.metadata, agentAccess: "shared" };
    shared.tab.externalAutomationOrigin = "http://localhost:3000";
    shared.contents.getURL.mockReturnValue("https://final.example.com/");
    shared.emitState.mockClear();
    shared.contents.emit("did-navigate");
    expect(shared.tab.automationAccess).toBe("user");
    expect(shared.tab.metadata.agentAccess).toBe("user");
    expect(shared.tab.externalAutomationOrigin).toBeNull();
    expect(shared.emitState).toHaveBeenCalledOnce();

    // Agent tabs clear externalAutomationOrigin on cross-origin nav but remain "agent".
    const agent = await setupEvents("agent");
    agent.tab.externalAutomationOrigin = "https://approved.example.com";
    agent.contents.emit("will-redirect", {
      url: "https://other.example.com/",
      isMainFrame: true,
      preventDefault: vi.fn(),
    });
    expect(agent.tab.automationAccess).toBe("agent");
    expect(agent.tab.externalAutomationOrigin).toBeNull();
  });

  it("prevents non-navigable page schemes on will-navigate without showing a tab error", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const { contents, emitState, setTabError } = await setupEvents();
      for (const url of [
        "javascript:void(0)",
        "mailto:test@example.com",
        "tel:+1234567890",
        "data:text/html,hi",
        "blob:https://example.com/123",
        "vscode://file/tmp/a",
      ]) {
        const preventDefault = vi.fn();
        contents.emit("will-navigate", { url, preventDefault });
        expect(preventDefault).toHaveBeenCalledOnce();
      }
      expect(setTabError).not.toHaveBeenCalled();
      expect(emitState).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(6);
    } finally {
      debug.mockRestore();
    }
  });

  it("reports a structured blocked error when a shared tab redirects to Cadencr", async () => {
    const { contents, emitState, getError } = await setupEvents("shared");
    const preventDefault = vi.fn();
    contents.emit("will-redirect", { url: "http://127.0.0.1:5005/api/health", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(emitState).toHaveBeenCalledOnce();
    expect(getError()).toMatchObject({
      kind: "blocked",
      title: "Navigation blocked",
      description: "Shared browser tabs cannot redirect to Cadencr's own interface.",
      url: "http://127.0.0.1:5005/api/health",
      retryable: false,
    });
  });

  it("clears previous tab errors on main-frame navigation start and navigation completion", async () => {
    const { contents, emitState, setTabError, getError } = await setupEvents();
    contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://bad.invalid/", true);
    expect(getError()).not.toBeNull();
    emitState.mockClear();
    setTabError.mockClear();

    contents.emit("did-start-navigation", {
      url: "https://example.com/",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(setTabError).toHaveBeenCalledWith(null);
    expect(emitState).toHaveBeenCalledOnce();
    expect(getError()).toBeNull();

    contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://bad.invalid/", true);
    emitState.mockClear();
    contents.emit("did-navigate");
    expect(getError()).toBeNull();
    expect(emitState).toHaveBeenCalledOnce();

    contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://bad.invalid/", true);
    emitState.mockClear();
    contents.emit("did-navigate-in-page", {}, "https://example.com/#section", true);
    expect(getError()).toBeNull();
    expect(emitState).toHaveBeenCalledOnce();
  });
});
