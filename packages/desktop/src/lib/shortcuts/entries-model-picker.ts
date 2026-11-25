import type { Shortcut } from "./types";

export const MODEL_PICKER_SHORTCUTS = [
  {
    // ⌘S — stars the highlighted row. Bound only while a model picker popover
    // is open, so it never competes with the editor's ⌘S ("Save") or the
    // browser's ⌘S ("Add a page comment"): those are tab-scoped and the picker
    // owns focus whenever this one is live.
    id: "model-picker-favorite",
    keys: ["mod", "s"],
    describe(t) {
      return t(
        "shortcuts.descriptions.model-picker-favorite",
        "Star / unstar the highlighted model",
      );
    },
    scope: "model-picker",
  },
] as const satisfies readonly Shortcut[];
