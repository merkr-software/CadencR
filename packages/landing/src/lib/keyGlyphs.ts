/**
 * Lucide glyphs for the keys the desktop app draws as icons
 * (packages/desktop/src/components/kbd-key.tsx), inlined so the docs need no
 * icon dependency. Source: https://lucide.dev — Lucide is ISC-licensed.
 */
export interface KeyGlyph {
  label: string;
  /** Inner SVG markup on Lucide's 24×24 grid. Static constants only. */
  paths: string;
}

const COMMAND: KeyGlyph = {
  label: "Command",
  paths: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />',
};
const OPTION: KeyGlyph = {
  label: "Option",
  paths: '<path d="M3 3h6l6 18h6" /><path d="M14 3h7" />',
};
const CONTROL: KeyGlyph = { label: "Control", paths: '<path d="m18 15-6-6-6 6" />' };
const SHIFT: KeyGlyph = {
  label: "Shift",
  paths:
    '<path d="M9 13a1 1 0 0 0-1-1H5.061a1 1 0 0 1-.75-1.811l6.836-6.835a1.207 1.207 0 0 1 1.707 0l6.835 6.835a1 1 0 0 1-.75 1.811H16a1 1 0 0 0-1 1v6a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z" />',
};
const RETURN: KeyGlyph = {
  label: "Return",
  paths: '<path d="M20 4v7a4 4 0 0 1-4 4H4" /><path d="m9 10-5 5 5 5" />',
};
const DELETE: KeyGlyph = {
  label: "Delete",
  paths:
    '<path d="M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" /><path d="m12 9 6 6" /><path d="m18 9-6 6" />',
};

/** Keyed by the glyph `formatKey` emits (and authors type in MDX). */
export const KEY_GLYPHS: Readonly<Record<string, KeyGlyph>> = {
  "⌘": COMMAND,
  "⌥": OPTION,
  "⌃": CONTROL,
  "⇧": SHIFT,
  "↵": RETURN,
  "⌫": DELETE,
  "↑": { label: "Up", paths: '<path d="m5 12 7-7 7 7" /><path d="M12 19V5" />' },
  "↓": { label: "Down", paths: '<path d="M12 5v14" /><path d="m19 12-7 7-7-7" />' },
  "←": { label: "Left", paths: '<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />' },
  "→": { label: "Right", paths: '<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />' },
};
