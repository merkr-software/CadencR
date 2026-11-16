import type { Input } from "electron";
import { describe, expect, it } from "vitest";

import { BrowserPageController } from "./browser-page-controller";
import { guestChrome } from "./browser-tab-events";

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
  return new BrowserPageController(
    new Map(),
    () => {
      throw new Error("no tab");
    },
    () => undefined,
    () => undefined,
  );
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
