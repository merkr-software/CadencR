import type { Input } from "electron";
import { describe, expect, it, vi } from "vitest";

import { BrowserPageController } from "./browser-page-controller";
import { guestChrome, type ManagedTab } from "./browser-tab-events";

const BINDINGS = {
  find: { keys: [] },
  downloads: { keys: [] },
  responsive: { keys: [] },
  devtools: { keys: [] },
  zoomReset: { keys: [] },
  navigateBack: { keys: ["mod", "lbracket"] },
  navigateForward: { keys: ["mod", "rbracket"] },
};

function controller(): BrowserPageController {
  return new BrowserPageController({
    tabs: new Map(),
    requireTab: () => {
      throw new Error("no tab");
    },
    emitState: () => undefined,
    emitFindResult: () => undefined,
  });
}

// A guest keydown with the platform's primary modifier held.
function withMod(key: string, code: string): Input {
  const modKey = process.platform === "darwin" ? { meta: true } : { control: true };
  return {
    type: "keyDown",
    key,
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...modKey,
  } as Input;
}

describe("BrowserPageController guest history shortcuts", () => {
  it("matches the configured history chords by produced key", () => {
    const page = controller();
    page.setGuestShortcutBindings(BINDINGS);

    expect(page.matchGuestShortcut(withMod("[", "BracketLeft"))).toBe("navigate-back");
    expect(page.matchGuestShortcut(withMod("]", "BracketRight"))).toBe("navigate-forward");
    // German layout: the physical bracket key produces "ü" and stays the page's.
    expect(page.matchGuestShortcut(withMod("ü", "BracketLeft"))).toBeNull();
  });

  it("leaves ⌘⇧[ / ⌘⇧] to Browser tab switching", () => {
    const page = controller();
    page.setGuestShortcutBindings(BINDINGS);
    // Under Cmd, macOS reports the base character, so the shifted chord still says "[".
    const prev = { ...withMod("[", "BracketLeft"), shift: true };
    const next = { ...withMod("]", "BracketRight"), shift: true };

    expect(page.matchGuestShortcut(prev)).toBeNull();
    expect(guestChrome(prev, page.matchGuestShortcut(prev))).toBe("prev-tab");
    expect(guestChrome(next, page.matchGuestShortcut(next))).toBe("next-tab");
  });

  it("follows a registry override instead of the default chord", () => {
    const page = controller();
    page.setGuestShortcutBindings({ ...BINDINGS, navigateBack: { keys: ["mod", "j"] } });

    expect(page.matchGuestShortcut(withMod("j", "KeyJ"))).toBe("navigate-back");
    expect(page.matchGuestShortcut(withMod("[", "BracketLeft"))).toBeNull();
  });
});

describe("BrowserPageController error clearing on navigation", () => {
  it("clears the tab error before goBack, goForward, and reload", () => {
    const order: string[] = [];
    const webContents = {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true),
      goBack: vi.fn(() => order.push("goBack")),
      goForward: vi.fn(() => order.push("goForward")),
      reload: vi.fn(() => order.push("reload")),
      stopFindInPage: vi.fn(),
    };
    const tab = {
      metadata: { id: "tab-1", scopeId: 1 },
      webContents,
    } as unknown as ManagedTab;
    const tabs = new Map<string, ManagedTab>([["tab-1", tab]]);
    const clearTabError = vi.fn(() => order.push("clearTabError"));
    const retryFailedLoad = vi.fn(() => false);
    const page = new BrowserPageController({
      tabs,
      requireTab: (id) => {
        const found = tabs.get(id);
        if (!found) throw new Error("missing");
        return found;
      },
      emitState: () => undefined,
      emitFindResult: () => undefined,
      clearTabError,
      retryFailedLoad,
    });

    page.goBack("tab-1");
    page.goForward("tab-1");
    page.reload("tab-1");

    expect(clearTabError).toHaveBeenCalledTimes(3);
    expect(clearTabError).toHaveBeenCalledWith(tab);
    expect(order).toEqual([
      "clearTabError",
      "goBack",
      "clearTabError",
      "goForward",
      "clearTabError",
      "reload",
    ]);

    retryFailedLoad.mockReturnValueOnce(true);
    webContents.reload.mockClear();
    clearTabError.mockClear();
    page.reload("tab-1");
    expect(webContents.reload).not.toHaveBeenCalled();
    expect(clearTabError).not.toHaveBeenCalled();

    clearTabError.mockClear();
    webContents.canGoBack.mockReturnValue(false);
    webContents.canGoForward.mockReturnValue(false);
    page.goBack("tab-1");
    page.goForward("tab-1");
    expect(clearTabError).not.toHaveBeenCalled();
  });
});
