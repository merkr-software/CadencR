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
 * Alt+Left / Alt+Right retain readline's word-back / word-forward sequences.
 * Capture-phase interception prevents celeritty's bubble-phase input handler
 * from sending its own, different encoding for the same key.
 */

const META_KEY_MAP: Record<string, string> = {
  // Ctrl+A — beginning of line.
  ArrowLeft: "\x01",
  // Ctrl+E — end of line.
  ArrowRight: "\x05",
};
const ALT_KEY_MAP: Record<string, string> = {
  ArrowLeft: "\x1bb",
  ArrowRight: "\x1bf",
};

export interface NavigationKeyDeps {
  /** Whether a PTY is live; no point sending to a dead session. */
  isActive: () => boolean;
  /** Sends the bytes to the process. */
  write: (data: string) => void;
}

/**
 * Listen for the navigation keys on `surface` and write their
 * readline equivalents. Returns a cleanup fn.
 *
 * Capture runs before celeritty's keydown listener, regardless of listener
 * registration order, so handled keys are never sent twice.
 */
export function attachNavigationKeys(surface: HTMLElement, deps: NavigationKeyDeps): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!deps.isActive() || event.isComposing || event.keyCode === 229 || event.defaultPrevented)
      return;
    const isOnlyMeta = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
    const isOnlyAlt = event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
    const sequence = isOnlyMeta
      ? META_KEY_MAP[event.key]
      : isOnlyAlt
        ? ALT_KEY_MAP[event.key]
        : undefined;
    if (!sequence) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    deps.write(sequence);
  };

  surface.addEventListener("keydown", onKeyDown, true);
  return () => surface.removeEventListener("keydown", onKeyDown, true);
}
