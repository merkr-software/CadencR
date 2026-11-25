import type { Shortcut } from "./types";
import { PLATFORM_IS_MAC } from "./format";

// Off macOS a bare Ctrl chord belongs to the shell while the terminal has focus
// (see `shell-keys.ts`), so terminal actions take Ctrl+Shift — or Ctrl+Alt where
// a Ctrl+Shift combo is already bound in the feature workspace.

export const TERMINAL_SHORTCUTS = [
  {
    id: "terminal-focus",
    keys: ["mod", "t"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-focus", "Focus or open terminal");
    },
    scope: "terminal",
  },
  {
    id: "terminal-clear",
    keys: PLATFORM_IS_MAC ? ["mod", "k"] : ["mod", "alt", "k"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-clear", "Clear terminal");
    },
    scope: "terminal",
  },
  {
    id: "terminal-delete-line",
    keys: PLATFORM_IS_MAC ? ["mod", "backspace"] : ["mod", "shift", "backspace"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-delete-line", "Delete line");
    },
    scope: "terminal",
  },
  {
    id: "terminal-split-h",
    keys: PLATFORM_IS_MAC ? ["mod", "d"] : ["mod", "shift", "d"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-split-h", "Split horizontal");
    },
    scope: "terminal",
  },
  {
    id: "terminal-split-v",
    keys: PLATFORM_IS_MAC ? ["mod", "shift", "d"] : ["mod", "alt", "d"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-split-v", "Split vertical");
    },
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-left",
    keys: ["mod", "alt", "left"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-nav-pane-left", "Focus pane left");
    },
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-right",
    keys: ["mod", "alt", "right"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-nav-pane-right", "Focus pane right");
    },
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-up",
    keys: ["mod", "alt", "up"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-nav-pane-up", "Focus pane up");
    },
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-down",
    keys: ["mod", "alt", "down"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-nav-pane-down", "Focus pane down");
    },
    scope: "terminal",
  },
  {
    id: "terminal-close",
    keys: PLATFORM_IS_MAC ? ["mod", "w"] : ["mod", "shift", "w"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-close", "Close pane");
    },
    scope: "terminal",
  },
  {
    id: "terminal-copy",
    keys: PLATFORM_IS_MAC ? ["mod", "c"] : ["mod", "shift", "c"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-copy", "Copy selection");
    },
    scope: "terminal",
  },
  {
    id: "terminal-paste",
    keys: PLATFORM_IS_MAC ? ["mod", "v"] : ["mod", "shift", "v"],
    describe(t) {
      return t("shortcuts.descriptions.terminal-paste", "Paste");
    },
    scope: "terminal",
  },
  {
    // Ctrl+Shift+Enter off macOS too: no shell assigns it, and it matches the
    // Editor's binding for the same action.
    id: "terminal-add-selection-to-prompt",
    keys: ["mod", "shift", "enter"],
    describe(t) {
      return t(
        "shortcuts.descriptions.terminal-add-selection-to-prompt",
        "Add selection to the agent prompt",
      );
    },
    scope: "terminal",
    aliases: ["context", "agent", "prompt"],
  },
] as const satisfies readonly Shortcut[];
