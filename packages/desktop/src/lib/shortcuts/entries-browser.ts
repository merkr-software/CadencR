/**
 * Browser-tab shortcut entries. Extracted from `entries.ts` to keep the
 * canonical file under the 400-line limit; merged back into the combined
 * `SHORTCUTS` array exported from `entries.ts`.
 *
 * These mirror real-browser chrome chords. They share combos with the agent
 * tab (⌘T) and the window-close fallback (⌘W) but are scoped to the Browser
 * tab, so the focus gate in `useScopedGlobalShortcut` keeps them from
 * colliding. When the guest page itself has keyboard focus the main process
 * relays the same chords (see `browser-tab-events.ts`).
 */
import type { Shortcut } from "./types";

export const BROWSER_SHORTCUTS = [
  {
    id: "browser-new-tab",
    keys: ["mod", "t"],
    describe(t) {
      return t("shortcuts.descriptions.browser-new-tab", "New browser tab");
    },
    scope: "browser",
  },
  {
    id: "browser-close",
    keys: ["mod", "w"],
    describe(t) {
      return t("shortcuts.descriptions.browser-close", "Close browser tab");
    },
    scope: "browser",
  },
  {
    // Chrome's customary Mod+Shift+T belongs to Cadencr's Terminal pane.
    id: "browser-reopen-tab",
    keys: ["mod", "shift", "u"],
    describe(t) {
      return t("shortcuts.descriptions.browser-reopen-tab", "Reopen last closed browser tab");
    },
    scope: "browser",
  },
  {
    id: "browser-prev-tab",
    keys: ["mod", "shift", "lbracket"],
    describe(t) {
      return t("shortcuts.descriptions.browser-prev-tab", "Previous browser tab");
    },
    scope: "browser",
  },
  {
    id: "browser-next-tab",
    keys: ["mod", "shift", "rbracket"],
    describe(t) {
      return t("shortcuts.descriptions.browser-next-tab", "Next browser tab");
    },
    scope: "browser",
  },
  {
    id: "browser-focus-url",
    keys: ["mod", "l"],
    describe(t) {
      return t("shortcuts.descriptions.browser-focus-url", "Focus the address bar");
    },
    scope: "browser",
  },
  {
    id: "browser-reload",
    keys: ["mod", "r"],
    describe(t) {
      return t("shortcuts.descriptions.browser-reload", "Reload the page");
    },
    scope: "browser",
  },
  {
    id: "browser-find",
    keys: ["mod", "f"],
    describe(t) {
      return t("shortcuts.descriptions.browser-find", "Find in page");
    },
    scope: "browser",
  },
  {
    id: "browser-add-comment",
    keys: ["mod", "s"],
    describe(t) {
      return t("shortcuts.descriptions.browser-add-comment", "Add a page comment");
    },
    scope: "browser",
  },
  {
    id: "browser-downloads",
    keys: ["mod", "shift", "j"],
    describe(t) {
      return t("shortcuts.descriptions.browser-downloads", "Show browser downloads");
    },
    scope: "browser",
  },
  {
    id: "browser-responsive",
    keys: ["mod", "shift", "m"],
    describe(t) {
      return t("shortcuts.descriptions.browser-responsive", "Toggle responsive mode");
    },
    scope: "browser",
  },
  {
    // Electron owns Cmd+Opt+I / Ctrl+Shift+I for the app renderer's DevTools.
    // F12 is also a standard browser binding and reaches the Browser guest in
    // both development and packaged builds without opening the wrong tools.
    id: "browser-devtools",
    keys: ["f12"],
    describe(t) {
      return t("shortcuts.descriptions.browser-devtools", "Toggle browser DevTools");
    },
    scope: "browser",
  },
] as const satisfies readonly Shortcut[];
