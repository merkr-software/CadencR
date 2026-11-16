/**
 * Docs-side shortcut formatter.
 *
 * The desktop app ships its own `formatKey` at
 * packages/desktop/src/lib/shortcuts/format.ts, but that module branches on
 * `navigator.platform` which does not exist at Astro build time. The docs
 * always render the macOS glyphs anyway, so we keep a tiny static map here
 * and re-use the registry types straight from the desktop package.
 */
import type { ShortcutKey } from "@desktop-shortcuts/registry";

const GLYPHS: Record<string, string> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  enter: "↵",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  plus: "+",
  minus: "−",
  comma: ",",
  slash: "/",
  backtick: "`",
  backspace: "⌫",
  question: "?",
  lbracket: "[",
  rbracket: "]",
};

export function formatKey(key: ShortcutKey): string {
  if (key in GLYPHS) return GLYPHS[key];
  if (key.length === 1 || /^f\d{1,2}$/.test(key)) return key.toUpperCase();
  // Tokens like "1-9" pass through verbatim.
  return key;
}
