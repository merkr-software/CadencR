/**
 * Brief, global "don't auto-pin to the bottom" window.
 *
 * Why this exists
 * ---------------
 * Expanding or collapsing a summary-mode recap animates the row's height, which
 * fires Virtuoso's `totalListHeightChanged`. While the view is stuck at the
 * bottom, the auto-scroll hook normally re-pins to the latest message on every
 * height delta — but for a *user-driven* toggle that yanks the clicked recap
 * out of view (the classic "click jumps the scroll" bug).
 *
 * The recap arms this window on click. The auto-scroll hook checks it and skips
 * its pin for the duration of the height animation, so the viewport stays
 * exactly where the user left it. It self-clears after the window, so normal
 * streaming auto-scroll resumes with no teardown.
 */
let suppressUntil = 0;

/** Arm the suppression window. Covers the collapsible's height animation + settle. */
export function suppressAutoScrollPin(durationMs = 320): void {
  const until = Date.now() + durationMs;
  if (until > suppressUntil) suppressUntil = until;
}

/** Whether an auto-scroll-to-bottom pin should be skipped right now. */
export function isAutoScrollPinSuppressed(): boolean {
  return Date.now() < suppressUntil;
}
