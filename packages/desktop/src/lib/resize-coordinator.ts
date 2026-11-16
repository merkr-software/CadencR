/**
 * Global "is the user actively dragging a resize handle?" flag.
 *
 * Why this exists
 * ---------------
 * react-resizable-panels resizes panel children per pointer-move. Heavy
 * children (xterm, agent stream, CodeMirror, …) each register their own
 * `ResizeObserver` to react to layout changes — and those observers run a
 * batch per animation frame. During an active drag, the cumulative cost of
 * every observer firing per frame (xterm refit, scroll-bottom catch-up with
 * forced sync layout reads, virtualization remeasures, …) snowballs into
 * sub-30 fps drags, especially with multiple split panes visible.
 *
 * We can't disable the observers entirely — they're needed for normal
 * mount/grow/shrink flows. But during a *manual* resize drag, the user
 * doesn't want auto-scroll-to-bottom or a per-frame xterm refit; they want
 * the panel boundary to follow their pointer at 60+ fps. So observers
 * subscribe to this coordinator, skip work while a drag is in progress, and
 * run a single catch-up pass when the drag ends.
 *
 * Wiring
 * ------
 * Each `<ResizableHandle>` calls `registerHandle(el)` on mount and
 * `unregisterHandle(el)` on unmount. The first registration installs a
 * single document-level *capture-phase* `pointerdown` listener that uses
 * geometric proximity (matching react-resizable-panels' own hit detection)
 * to decide whether a click is going to start a drag. On a hit it calls
 * `pushResize()` and arms window-level `pointerup` / `pointercancel`
 * listeners that call `popResize()`. Heavy observers subscribe via
 * `subscribeResize(cb)`.
 *
 * Why document-level (and not per-element)
 * ----------------------------------------
 * react-resizable-panels accepts clicks within ~5 px of a 1 px handle
 * (default `resizeTargetMinimumSize.fine = 10`, expanded centered around the
 * handle bbox). It uses geometric hit-testing, *not* DOM event targeting. A
 * per-element pointerdown listener only fires when the browser routes the
 * event to the handle node itself — and the handle's `::after` hit-zone
 * loses CSS stacking on the right side of a split (sibling main-panel
 * descendants paint above it). Clicks the library accepts can therefore
 * land on a non-handle element, the per-element listener never fires, and
 * `pushResize` never runs — surfacing as "slow drag sometimes" with no
 * freeze engaged. A document-level capture listener that matches against
 * the registered handles by coordinates dodges the issue entirely.
 *
 * Notification semantics
 * ----------------------
 * Every `pushResize()` fires `notify(true)`, even when `activeCount` was
 * already > 0. We *don't* gate on the 0→1 transition because the refcount
 * can drift if a previous drag's `pointerup` was missed (release outside
 * the window, alt-tab mid-drag, focus loss stealing pointer capture). With
 * a transition-only notify, the very next drag would silently skip the
 * listeners — and the content-width freeze would never engage.
 *
 * Listeners must therefore be idempotent for repeated `true` notifications:
 * applying the same lock twice is a no-op (e.g. setting `style.width` to the
 * already-locked value). `notify(false)` still only fires on the count→0
 * transition, so unlocks are not re-fired during normal nested drags.
 */

let activeCount = 0;
const listeners = new Set<(active: boolean) => void>();

function notify(active: boolean): void {
  for (const listener of listeners) listener(active);
}

export function pushResize(): void {
  activeCount += 1;
  notify(true);
}

export function popResize(): void {
  if (activeCount === 0) return;
  activeCount -= 1;
  if (activeCount === 0) notify(false);
}

export function isResizing(): boolean {
  return activeCount > 0;
}

export function subscribeResize(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

// --- handle registry + document-level pointerdown ---------------------------

const handles = new Set<HTMLElement>();
let docListenerInstalled = false;
// Tracks the in-flight drag (set on pointerdown, cleared on pointerup/cancel).
// Lets `unregisterHandle` release the global state if the dragged handle is
// torn down mid-drag (route swap, layout change, …) — otherwise the window
// listeners would leak and `activeCount` would stay incremented forever,
// freezing every subscriber permanently.
let activeDrag: { handle: HTMLElement; release: () => void } | null = null;

/**
 * Tolerance in px on the orientation axis. react-resizable-panels' default
 * `resizeTargetMinimumSize.fine` is 10 (centered on the 1 px handle, so ~5 px
 * each side). We use a slightly wider window to absorb sub-pixel rounding
 * and to catch any click the library would also accept. False positives are
 * cheap: `pushResize` triggers a freeze that's a no-op when no actual panel
 * resize follows (the lock width matches the natural width, nothing visibly
 * changes), then clears on pointerup.
 */
const HIT_TOLERANCE_PX = 8;

function isPointerNearHandle(e: PointerEvent, handle: HTMLElement): boolean {
  const r = handle.getBoundingClientRect();
  // `aria-orientation` reports the *line* direction (perpendicular to the
  // resize axis). "vertical" → horizontal panel group → tolerance widens X.
  // "horizontal" → vertical panel group → tolerance widens Y.
  const orientation = handle.getAttribute("aria-orientation");
  if (orientation === "vertical") {
    return (
      e.clientX >= r.left - HIT_TOLERANCE_PX &&
      e.clientX <= r.right + HIT_TOLERANCE_PX &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom
    );
  }
  return (
    e.clientY >= r.top - HIT_TOLERANCE_PX &&
    e.clientY <= r.bottom + HIT_TOLERANCE_PX &&
    e.clientX >= r.left - HIT_TOLERANCE_PX &&
    e.clientX <= r.right + HIT_TOLERANCE_PX
  );
}

function onDocumentPointerDown(e: PointerEvent): void {
  // Match react-resizable-panels' own filter: ignore non-primary mouse buttons.
  if (e.pointerType === "mouse" && e.button > 0) return;
  let hit: HTMLElement | undefined;
  for (const handle of handles) {
    // A disabled handle (a folded pop pane's) never starts a drag.
    if (handle.getAttribute("aria-disabled") === "true") continue;
    if (isPointerNearHandle(e, handle)) {
      hit = handle;
      break;
    }
  }
  if (!hit) return;
  // Defensive: if a previous drag's release was somehow missed, drop it
  // before opening a new one so the global counter stays sane.
  activeDrag?.release();
  const handle = hit;
  const release = (): void => {
    if (activeDrag?.release !== release) return;
    activeDrag = null;
    popResize();
    // react-resizable-panels focuses the separator on pointerdown to enable
    // arrow-key resize. After a mouse drag the handle keeps focus, which
    // fires the `focus-visible` ring (~3 px light bar) and reads as a thick
    // white line until the user clicks elsewhere. Blur explicitly so
    // pointer-driven resizes leave the handle in its resting state.
    handle.blur();
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
  };
  activeDrag = { handle, release };
  pushResize();
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
}

export function registerHandle(el: HTMLElement): void {
  handles.add(el);
  if (!docListenerInstalled && typeof document !== "undefined") {
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    docListenerInstalled = true;
  }
}

export function unregisterHandle(el: HTMLElement): void {
  // If the handle being torn down is currently mid-drag, release the global
  // state before forgetting about it.
  if (activeDrag?.handle === el) activeDrag.release();
  handles.delete(el);
  if (handles.size === 0 && docListenerInstalled && typeof document !== "undefined") {
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    docListenerInstalled = false;
  }
}
