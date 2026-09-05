/**
 * macOS line-navigation shortcuts the terminal itself will not encode.
 *
 * celeritty deliberately drops every Meta-held key — Meta belongs to the host
 * application's shortcut system, per `encode_key` in its Rust input encoder —
 * so Cmd+Left / Cmd+Right reach nothing unless the host sends them. These two
 * map to readline's start-of-line (Ctrl+A) and end-of-line (Ctrl+E), matching
 * what the xterm.js implementation did through
 * `attachCustomKeyEventHandler`.
 *
 * **Alt+Left / Alt+Right are deliberately not handled here.** The xterm.js
 * version mapped them to `ESC b` / `ESC f` (readline word-back / word-forward).
 * celeritty already encodes Alt as an ESC prefix on whatever the key emits, so
 * Alt+Left produces `ESC` + the left-arrow sequence instead. Whether shells
 * treat that equivalently depends on the shell and its keymap, and adding a
 * host-side override on top would double-send. Left as a followup to settle
 * against a real shell rather than guessed at here.
 */

const META_KEY_MAP: Record<string, string> = {
  // Ctrl+A — beginning of line.
  ArrowLeft: "\x01",
  // Ctrl+E — end of line.
  ArrowRight: "\x05",
};

export interface NavigationKeyDeps {
  /** Whether a PTY is live; no point sending to a dead session. */
  isActive: () => boolean;
  /** Sends the bytes to the process. */
  write: (data: string) => void;
}

/**
 * Listen for the Meta-held navigation keys on `surface` and write their
 * readline equivalents. Returns a cleanup fn.
 *
 * Safe to register alongside celeritty's own keydown listener on the same
 * element: the keys handled here are exactly the ones it returns `undefined`
 * for, so there is no double-send regardless of listener order.
 */
export function attachNavigationKeys(surface: HTMLElement, deps: NavigationKeyDeps): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!deps.isActive()) return;
    const isOnlyMeta = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
    if (!isOnlyMeta) return;
    const sequence = META_KEY_MAP[event.key];
    if (!sequence) return;
    event.preventDefault();
    deps.write(sequence);
  };

  surface.addEventListener("keydown", onKeyDown);
  return () => surface.removeEventListener("keydown", onKeyDown);
}
