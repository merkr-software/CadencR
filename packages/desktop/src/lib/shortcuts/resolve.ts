/**
 * Pure resolver: registry tokens → engine combo string.
 *
 * `@tanstack/react-hotkeys` and our capture-phase `useGlobalShortcut` accept
 * the same TanStack hotkey syntax, so a single converter feeds both paths.
 * Going through this resolver — instead of hand-writing `"Mod+B"` at every
 * call site — is what makes the registry the actual source of truth:
 *
 * 1. `mod` stays as TanStack's platform-adaptive `Mod`, so Command is used
 *    on macOS and Control elsewhere.
 * 2. Display tokens like `plus` / `lbracket` are converted to the project
 *    hotkey names that the binding layer expands into layout-safe matches.
 *
 * No React. The override layer in `overrides.ts` wraps this in hooks.
 */
import { SHORTCUTS, type Shortcut, type ShortcutId, type ShortcutKey } from "./registry";

/**
 * Per-token engine name. Anything not listed falls through verbatim
 * (letters, digits, single chars).
 *
 * Punctuation tokens emit the project-level character token consumed by the
 * binding layer. Most are literal characters; `plus` stays named because `+`
 * itself is Shift-produced on many layouts.
 */
const TOKEN_TO_ENGINE: Record<string, string> = {
  // Modifier: platform-aware. TanStack resolves `Mod` to Meta on macOS and
  // Control on Windows/Linux.
  mod: "Mod",
  // Literal control (vim-style ^J etc.). Stable across platforms.
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  // `Plus` is a project-level token. The hotkey wrappers expand it to the
  // engine-specific punctuation keys that can emit the literal `+` character,
  // while still gating callbacks on `event.key === "+"`.
  plus: "Plus",
  minus: "-",
  comma: ",",
  slash: "/",
  backtick: "`",
  backspace: "Backspace",
  lbracket: "[",
  rbracket: "]",
  // Project-level token: the binding layer expands this to the
  // layout-specific key(s) that emit "?" and gates the callback on
  // `event.key === "?"`. On QWERTY that's Shift+/.
  question: "?",
  f2: "F2",
  f12: "F12",
};

function tokenToEngine(token: ShortcutKey): string {
  if (token in TOKEN_TO_ENGINE) return TOKEN_TO_ENGINE[token];
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  return token;
}

/** Convert a registry combo to the `"Mod+Shift+K"` form both engines accept. */
export function tokensToHotkeyString(keys: ShortcutKey[]): string {
  return keys.map(tokenToEngine).join("+");
}

function expandShortcutKeys(keys: ShortcutKey[]): string[] {
  if (keys.length !== 1) return [tokensToHotkeyString(keys)];

  const range = /^([0-9])-([0-9])$/.exec(keys[0]);
  if (!range) return [tokensToHotkeyString(keys)];

  const start = Number(range[1]);
  const end = Number(range[2]);
  if (start > end) return [tokensToHotkeyString(keys)];

  return Array.from({ length: end - start + 1 }, (_, index) => String(start + index));
}

/**
 * Resolve a shortcut id to its engine trigger.
 *
 * Returns:
 * - `string` for a single-combo shortcut (`"Mod+K"`)
 * - `string[]` when the shortcut has `altKeys` so the engine binds both
 *   (`["Mod+Shift+P", "Alt+P"]`)
 *
 * Callers pass the result straight to the project shortcut wrappers.
 */
export function resolveHotkeyTrigger(shortcut: {
  keys: ShortcutKey[];
  altKeys?: ShortcutKey[];
}): string | string[] {
  const primary = expandShortcutKeys(shortcut.keys);
  const alternate = shortcut.altKeys ? expandShortcutKeys(shortcut.altKeys) : [];
  const resolved = [...primary, ...alternate];
  return resolved.length === 1 ? resolved[0] : resolved;
}

/** Index registry by id once at module load — every call-site lookup is O(1). */
const REGISTRY_BY_ID: ReadonlyMap<ShortcutId, Shortcut> = new Map(
  SHORTCUTS.map((s) => [s.id, s as Shortcut]),
);

/**
 * Default (un-overridden) shortcut for an id. Throws on unknown ids in dev
 * so a typo surfaces immediately; in production the throw still happens —
 * `ShortcutId` typing already prevents the typo from compiling.
 */
export function getRegistryShortcut(id: ShortcutId): Shortcut {
  const entry = REGISTRY_BY_ID.get(id);
  if (!entry) throw new Error(`Unknown shortcut id "${id}"`);
  return entry;
}
