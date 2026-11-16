import { toastError } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";

/**
 * Whether Cadencr's window has focus. In the desktop app the main process
 * says so: focus inside a guest view (a custom tab, a browser pane) blurs this
 * document while the window itself stays focused, so `document.hasFocus()`
 * would read "away" while the user works in that guest. Until the main
 * process has answered, and outside the desktop app, the document's own focus
 * stands in.
 */
let windowFocused: boolean | null = null;
const listeners = new Set<() => void>();
let tracking = false;

function set(focused: boolean): void {
  windowFocused = focused;
  for (const listener of listeners) listener();
}

function track(): void {
  if (tracking) return;
  tracking = true;
  const { isWindowFocused, onWindowFocusChange } = desktopBridge;
  if (!isWindowFocused || !onWindowFocusChange) return;
  onWindowFocusChange(set);
  isWindowFocused()
    .then((focused) => {
      // A focus change that arrived first is newer than this answer.
      if (windowFocused === null) set(focused);
    })
    .catch((error: unknown) =>
      toastError(error, "Could not tell whether Cadencr's window has focus"),
    );
}

export function isWindowFocused(): boolean {
  track();
  return windowFocused ?? document.hasFocus();
}

/** Called when the main process reports a change of the window's focus. */
export function onWindowFocusChange(listener: () => void): () => void {
  track();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetWindowFocusForTests(): void {
  windowFocused = null;
  tracking = false;
  listeners.clear();
}
