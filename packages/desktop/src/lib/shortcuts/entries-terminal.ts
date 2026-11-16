import type { Shortcut } from "./types";
import { PLATFORM_IS_MAC } from "./format";

// Off macOS a bare Ctrl chord belongs to the shell while the terminal has focus
// (see `shell-keys.ts`), so terminal actions take Ctrl+Shift — or Ctrl+Alt where
// a Ctrl+Shift combo is already bound in the feature workspace.

export const TERMINAL_SHORTCUTS = [
  {
    id: "terminal-focus",
    keys: ["mod", "t"],
    description: "Focus or open terminal",
    scope: "terminal",
  },
  {
    id: "terminal-clear",
    keys: PLATFORM_IS_MAC ? ["mod", "k"] : ["mod", "alt", "k"],
    description: "Clear terminal",
    scope: "terminal",
  },
  {
    id: "terminal-delete-line",
    keys: PLATFORM_IS_MAC ? ["mod", "backspace"] : ["mod", "shift", "backspace"],
    description: "Delete line",
    scope: "terminal",
  },
  {
    id: "terminal-split-h",
    keys: PLATFORM_IS_MAC ? ["mod", "d"] : ["mod", "shift", "d"],
    description: "Split horizontal",
    scope: "terminal",
  },
  {
    id: "terminal-split-v",
    keys: PLATFORM_IS_MAC ? ["mod", "shift", "d"] : ["mod", "alt", "d"],
    description: "Split vertical",
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-left",
    keys: ["mod", "alt", "left"],
    description: "Focus pane left",
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-right",
    keys: ["mod", "alt", "right"],
    description: "Focus pane right",
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-up",
    keys: ["mod", "alt", "up"],
    description: "Focus pane up",
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-down",
    keys: ["mod", "alt", "down"],
    description: "Focus pane down",
    scope: "terminal",
  },
  {
    id: "terminal-close",
    keys: PLATFORM_IS_MAC ? ["mod", "w"] : ["mod", "shift", "w"],
    description: "Close pane",
    scope: "terminal",
  },
  {
    id: "terminal-copy",
    keys: PLATFORM_IS_MAC ? ["mod", "c"] : ["mod", "shift", "c"],
    description: "Copy selection",
    scope: "terminal",
  },
  {
    id: "terminal-paste",
    keys: PLATFORM_IS_MAC ? ["mod", "v"] : ["mod", "shift", "v"],
    description: "Paste",
    scope: "terminal",
  },
  {
    // Ctrl+Shift+Enter off macOS too: no shell assigns it, and it matches the
    // Editor's binding for the same action.
    id: "terminal-add-selection-to-prompt",
    keys: ["mod", "shift", "enter"],
    description: "Add selection to the agent prompt",
    scope: "terminal",
    aliases: ["context", "agent", "prompt"],
  },
] as const satisfies readonly Shortcut[];
