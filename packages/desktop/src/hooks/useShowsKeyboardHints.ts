import { useIsTouchDevice } from "./useIsTouchDevice";

/**
 * `false` where the primary pointer is a finger. Only for plain strings that
 * cite keys (a placeholder, a description passed as a string): they drop the
 * keys there. JSX that cites keys wraps the key clause in a `KBD_HINT_PROPS`
 * span instead, which the `[data-kbd-hint]` rule in `touch-shell.css` hides.
 */
export function useShowsKeyboardHints(): boolean {
  return !useIsTouchDevice();
}
