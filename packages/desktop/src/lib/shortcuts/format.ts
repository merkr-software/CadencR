/**
 * Platform-aware shortcut formatting. The registry uses `mod` / `alt` /
 * `ctrl` tokens; this module turns them into the glyphs (or words) that
 * make sense on the current OS.
 *
 * We deliberately avoid trying to look "native" on every platform — Cadencr
 * is an Electron desktop app, and most surfaces in the app already render
 * the macOS glyphs even on Linux/Windows. The split lives here so a single
 * future tweak can flip every shortcut display.
 */
import type { ShortcutKey } from "./registry";

function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return true;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  // Case-insensitive: Chromium's `userAgentData.platform` reports "macOS" while
  // the older `navigator.platform` reports "MacIntel".
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const IS_MAC = detectIsMac();

const MAC_GLYPHS: Record<string, string> = {
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
  lbracket: "[",
  rbracket: "]",
  question: "?",
  f2: "F2",
  f12: "F12",
};

/** Tokens whose display differs from macOS. Anything not listed here falls
 *  through to `MAC_GLYPHS` (which already covers Esc, ↑↓←→, etc.). */
const NON_MAC_OVERRIDES: Record<string, string> = {
  mod: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
};

const GLYPHS = IS_MAC ? MAC_GLYPHS : { ...MAC_GLYPHS, ...NON_MAC_OVERRIDES };

/** Renders a single key token (`"mod"`, `"a"`, `"1-9"`, …) for display. */
export function formatKey(key: ShortcutKey): string {
  if (key in GLYPHS) return GLYPHS[key];
  if (key.length === 1) return key.toUpperCase();
  // Tokens like "1-9", "↑↓←→" pass through unchanged.
  return key;
}

/** Renders the full combo as an array of cells for the `KbdShortcut` chord. */
export function formatCombo(keys: ShortcutKey[]): string[] {
  return keys.map(formatKey);
}

/** Search-friendly flat string ("⌘ ⇧ N" or "Ctrl Shift N"). */
export function comboSearchText(keys: ShortcutKey[]): string {
  return keys.map(formatKey).join(" ").toLowerCase();
}

export const PLATFORM_IS_MAC = IS_MAC;
