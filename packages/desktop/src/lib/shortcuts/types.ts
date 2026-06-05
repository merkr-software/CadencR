/**
 * Shortcut types. `ShortcutKey` is the platform-agnostic token vocabulary
 * used in the registry; the formatter in `format.ts` and the resolver in
 * `resolve.ts` know how to turn each token into glyphs / engine names.
 */
import type { ShortcutScopeId } from "./scopes";

export type ShortcutKey =
  | "mod" // ⌘ on macOS, Ctrl elsewhere
  | "ctrl" // literal Control (vim-style ^J etc.)
  | "alt" // ⌥ on macOS, Alt elsewhere
  | "shift"
  | "enter"
  | "escape"
  | "tab"
  | "space"
  | "up"
  | "down"
  | "left"
  | "right"
  | "plus"
  | "minus"
  | "comma"
  | "slash"
  | "backtick"
  | "backspace"
  | "lbracket"
  | "rbracket"
  | "question" // Shift+/ on QWERTY — used by the help cheatsheet shortcut.
  | "f2" // F2 — used by Rename Symbol.
  // Letter / digit / single-char literals are passed through verbatim.
  | (string & {});

export interface Shortcut {
  id: string;
  keys: ShortcutKey[];
  /** Alternate combo, for shortcuts that intentionally bind two combos to the same action. */
  altKeys?: ShortcutKey[];
  description: string;
  scope: ShortcutScopeId;
  /** Search-only synonyms (e.g. "quit", "exit" for ⌘Q). Never rendered. */
  aliases?: string[];
}
