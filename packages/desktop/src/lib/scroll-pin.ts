/**
 * WebKit reports a fractional `scrollTop` while `scrollHeight`/`clientHeight`
 * are rounded, so "is it at the bottom" needs slack rather than equality.
 */
const PIN_EPSILON_PX = 1;

/**
 * Scroll `el` to the bottom, skipping the write when it is already there.
 * Returns whether it wrote.
 *
 * Idempotence is the point, not an optimization: a redundant `scrollTop` write
 * still emits a `scroll` event, and every scroll consumer reacts to it (a
 * virtual list's range recompute included). Writing on a loop that a scroll
 * event feeds is what wedged the iOS PWA's agent stream.
 */
export function pinToBottom(el: HTMLElement): boolean {
  const target = Math.max(0, el.scrollHeight - el.clientHeight);
  if (target - el.scrollTop <= PIN_EPSILON_PX) return false;
  el.scrollTop = target;
  return true;
}
