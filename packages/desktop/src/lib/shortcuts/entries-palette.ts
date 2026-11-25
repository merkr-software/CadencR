import type { Shortcut } from "./types";

/**
 * Keys that act while the command palette (⌘K) is open. The arrows, Enter,
 * Escape and Backspace-out-of-a-mode are the input's own and stay unlisted;
 * these are the ones a user has to learn.
 */
export const PALETTE_SHORTCUTS = [
  {
    // Tab, not ⌘K (Raycast's): ⌘K is what opens and closes the palette.
    id: "palette-actions",
    keys: ["tab"],
    describe(t) {
      return t("shortcuts.descriptions.palette-actions", "Show actions for the selected result");
    },
    scope: "command-palette",
  },
  {
    // ⌥S: S for scope. Letters fall back to e.code only when ⌥ mangles e.key
    // (macOS types "ß"), so AZERTY's S still works.
    id: "palette-scope",
    keys: ["alt", "s"],
    describe(t) {
      return t(
        "shortcuts.descriptions.palette-scope",
        "Search everything · this project · active conversations",
      );
    },
    scope: "command-palette",
  },
] as const satisfies readonly Shortcut[];
