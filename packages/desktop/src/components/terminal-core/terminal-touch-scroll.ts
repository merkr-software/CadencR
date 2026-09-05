import type { Terminal } from "celeritty";

/**
 * Make the terminal draggable by finger on touch devices.
 *
 * celeritty renders to a canvas and has no touch handling of its own — a
 * finger drag does nothing without this. Ported from the xterm.js
 * implementation it replaces (`xtermTouchScroll.ts`), which existed because
 * xterm 6's `ScrollableElement` never saw iOS touch gestures either. The
 * mechanism is the same: translate the vertical touch delta into whole-row
 * scrolls through the terminal's public `scrollLines()`, the same path the
 * wheel uses.
 *
 * Returns a cleanup fn; inert on non-touch input, since touch events never
 * fire there.
 */
export function attachTouchScroll(surface: HTMLElement, terminal: Terminal): () => void {
  let lastY = 0;
  // Sub-row pixels carried between moves so slow drags still scroll smoothly
  // instead of rounding every delta down to zero.
  let pixelRemainder = 0;
  // Row height in px, sampled once per drag at `touchstart`. Reading
  // `clientHeight` here (not on every `touchmove`) keeps a forced reflow off
  // the rapid-fire move path; the terminal can't resize mid-drag anyway.
  let rowHeight = 1;

  const onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (!touch) return;
    lastY = touch.clientY;
    pixelRemainder = 0;
    // celeritty exposes no row count, so derive it from the rendered height
    // and the line-height the options carry. A 1px floor keeps the division
    // safe while the host is still laying out.
    rowHeight = Math.max(1, surface.clientHeight / Math.max(1, estimateRows(surface)));
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (!touch) return;
    pixelRemainder += touch.clientY - lastY;
    lastY = touch.clientY;
    const rows = Math.trunc(pixelRemainder / rowHeight);
    if (rows === 0) return;
    pixelRemainder -= rows * rowHeight;
    // Finger down (rows > 0) reveals older output, i.e. scroll up → negative.
    terminal.scrollLines(-rows);
    e.preventDefault();
  };

  surface.addEventListener("touchstart", onTouchStart, { passive: true });
  surface.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => {
    surface.removeEventListener("touchstart", onTouchStart);
    surface.removeEventListener("touchmove", onTouchMove);
  };
}

/**
 * Rows currently on screen, from the canvas height and the computed line
 * height. Only used to size a touch delta, so an off-by-one costs a pixel of
 * drag precision, not correctness.
 */
function estimateRows(surface: HTMLElement): number {
  const lineHeight = Number.parseFloat(getComputedStyle(surface).lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    return Math.max(1, Math.round(surface.clientHeight / lineHeight));
  }
  return 24;
}
