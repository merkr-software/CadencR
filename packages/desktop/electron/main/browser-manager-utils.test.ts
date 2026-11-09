import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  assertBrowserMutationAllowed,
  consoleLevelName,
  externalAutomationMatches,
  isElementPayload,
  metadataFor,
  profileFromSelection,
  pushBounded,
  reclaimFocusForShortcut,
  reclaimRendererFocus,
} from "./browser-manager-utils";
import type { BrowserShortcut } from "./browser-types";

describe("browser-manager-utils", () => {
  it("keeps bounded diagnostic buffers at their limit", () => {
    const values = [1, 2, 3];
    pushBounded(values, 4, 3);
    expect(values).toEqual([2, 3, 4]);
  });

  it("maps Electron console levels to stable names", () => {
    expect(consoleLevelName(0)).toBe("verbose");
    expect(consoleLevelName(3)).toBe("error");
    expect(consoleLevelName(99)).toBe("info");
    // Electron 42 reports levels as strings.
    expect(consoleLevelName("warning")).toBe("warning");
    expect(consoleLevelName("error")).toBe("error");
    expect(consoleLevelName("debug")).toBe("verbose");
  });

  it("validates element-context payload shape", () => {
    expect(
      isElementPayload({
        selectorCandidates: ["#a"],
        tagName: "BUTTON",
        attributes: {},
        boundingBox: {},
        computedStyles: {},
      }),
    ).toBe(true);
    expect(
      isElementPayload({
        selectorCandidates: [],
        attributes: {},
        boundingBox: {},
        computedStyles: {},
      }),
    ).toBe(false);
  });

  it("requires live localhost URLs before browser mutation", () => {
    expect(() => assertBrowserMutationAllowed("http://localhost:5173/signup")).not.toThrow();
    expect(() => assertBrowserMutationAllowed("https://example.com/")).toThrow("localhost");
  });

  it("scopes external automation unlock to the approved origin", () => {
    const origin = "https://example.com";
    // Same origin (any path) stays unlocked.
    expect(externalAutomationMatches("https://example.com/dashboard", origin)).toBe(true);
    // Navigating to a different origin re-locks.
    expect(externalAutomationMatches("https://evil.test/", origin)).toBe(false);
    expect(externalAutomationMatches("http://example.com/", origin)).toBe(false);
    // Never unlocked when no origin was approved, or for unparseable URLs.
    expect(externalAutomationMatches("https://example.com/", null)).toBe(false);
    expect(externalAutomationMatches("about:blank", origin)).toBe(false);
  });

  it("builds default metadata for new tabs", () => {
    expect(metadataFor("tab-1", "fresh", 7)).toMatchObject({
      id: "tab-1",
      url: "about:blank",
      devToolsOpen: false,
      pinned: false,
      suspended: false,
      zoomPercent: 100,
      scopeId: 7,
    });
  });

  it("resolves profile selections without changing the persistent default partition", () => {
    const normal = profileFromSelection("default");
    const prefixedNormal = profileFromSelection("persistent:default");
    const firstPrivate = profileFromSelection("fresh");
    const secondPrivate = profileFromSelection("fresh");

    expect(normal).toEqual({ id: "default", label: "default", mode: "persistent" });
    expect(prefixedNormal).toEqual(normal);
    expect(firstPrivate.mode).toBe("fresh");
    expect(secondPrivate.mode).toBe("fresh");
    expect(firstPrivate.id).not.toBe(secondPrivate.id);
  });

  function fakeWindow(state: { destroyed?: boolean; focused?: boolean } = {}): {
    win: BrowserWindow;
    focus: ReturnType<typeof vi.fn>;
  } {
    const focus = vi.fn();
    const win = {
      isDestroyed: () => state.destroyed ?? false,
      webContents: { focus, isFocused: () => state.focused ?? false },
    };
    return { win: win as unknown as BrowserWindow, focus };
  }

  describe("reclaimRendererFocus", () => {
    it("hands keyboard focus back to the renderer from a guest view", () => {
      const { win, focus } = fakeWindow();
      reclaimRendererFocus(win);
      expect(focus).toHaveBeenCalledOnce();
    });

    it("leaves an already focused or destroyed window alone", () => {
      for (const state of [{ focused: true }, { destroyed: true }]) {
        const { win, focus } = fakeWindow(state);
        reclaimRendererFocus(win);
        expect(focus).not.toHaveBeenCalled();
      }
      expect(() => reclaimRendererFocus(null)).not.toThrow();
    });
  });

  describe("reclaimFocusForShortcut", () => {
    it("reclaims renderer focus for pane switches that leave the browser", () => {
      for (const shortcut of [
        "pane-agent",
        "pane-terminal",
        "pane-git",
        "pane-editor",
      ] as BrowserShortcut[]) {
        const { win, focus } = fakeWindow();
        reclaimFocusForShortcut(win, shortcut);
        expect(focus).toHaveBeenCalledOnce();
      }
    });

    it("reclaims renderer focus for browser chrome controls", () => {
      for (const shortcut of ["find", "focus-url"] as BrowserShortcut[]) {
        const { win, focus } = fakeWindow();
        reclaimFocusForShortcut(win, shortcut);
        expect(focus).toHaveBeenCalledOnce();
      }
    });

    it("leaves focus alone for shortcuts handled by the guest page", () => {
      for (const shortcut of [
        "pane-browser",
        "reload",
        "zoom-in",
        "zoom-out",
        "new-tab",
      ] as BrowserShortcut[]) {
        const { win, focus } = fakeWindow();
        reclaimFocusForShortcut(win, shortcut);
        expect(focus).not.toHaveBeenCalled();
      }
    });

    it("is a no-op when there is no window", () => {
      expect(() => reclaimFocusForShortcut(null, "pane-agent")).not.toThrow();
    });
  });
});
