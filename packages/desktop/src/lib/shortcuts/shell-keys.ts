import { isInTerminalFocusZone } from "./dom-targets";
import { PLATFORM_IS_MAC } from "./format";

/** Non-letter keys a terminal turns into control characters when Ctrl is held. */
const SHELL_CONTROL_CODES = new Set([
  "BracketLeft", // Ctrl+[ = Escape
  "BracketRight",
  "Backslash",
  "Slash",
  "Space",
  "Backspace",
]);

/**
 * Off macOS the app modifier is Ctrl, which is also how a shell reads control
 * characters (Ctrl+D EOF, Ctrl+R history search, Ctrl+W delete word…). A bare
 * Ctrl chord (no Shift/Alt/Meta) on a letter or one of the keys above is the
 * shell's, never an app shortcut's, while the terminal has focus. macOS app
 * shortcuts use Cmd, so nothing is reserved there.
 */
export function isShellControlChord(event: KeyboardEvent, isMac = PLATFORM_IS_MAC): boolean {
  if (isMac) return false;
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false;
  // `key` is layout-aware; `code` covers layouts whose letters are not Latin
  // and Ctrl+letter events whose `key` is a control character.
  return (
    /^[a-z]$/i.test(event.key) ||
    /^Key[A-Z]$/.test(event.code) ||
    SHELL_CONTROL_CODES.has(event.code)
  );
}

/** Whether an app shortcut must let `event` through to the focused terminal. */
export function shellOwnsKeyEvent(event: KeyboardEvent, isMac = PLATFORM_IS_MAC): boolean {
  return isShellControlChord(event, isMac) && isInTerminalFocusZone(event.target);
}
