import type { Shortcut } from "./types";

export const TERMINAL_SHORTCUTS = [
  {
    id: "terminal-focus",
    keys: ["mod", "t"],
    description: "Focus or open terminal",
    scope: "terminal",
  },
  {
    id: "terminal-clear",
    keys: ["mod", "k"],
    description: "Clear terminal",
    scope: "terminal",
  },
  {
    id: "terminal-delete-line",
    keys: ["mod", "backspace"],
    description: "Delete line",
    scope: "terminal",
  },
  {
    id: "terminal-split-h",
    keys: ["mod", "d"],
    description: "Split horizontal",
    scope: "terminal",
  },
  {
    id: "terminal-split-v",
    keys: ["mod", "shift", "d"],
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
  { id: "terminal-close", keys: ["mod", "w"], description: "Close pane", scope: "terminal" },
] as const satisfies readonly Shortcut[];
