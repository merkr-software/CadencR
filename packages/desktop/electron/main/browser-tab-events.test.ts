import type { Input } from "electron";
import { describe, expect, it } from "vitest";
import { guestChrome } from "./browser-tab-events";

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
      setLastError: noop,
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
