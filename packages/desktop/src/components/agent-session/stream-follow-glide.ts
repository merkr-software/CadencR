import { findStreamItemList } from "./agent-session-scroll-utils";

/**
 * Angular frequency (1/s) of the critically damped spring that carries the
 * glide. A one-line kick from rest settles to 5% in ~220ms (ωt ≈ 4.74), the
 * duration of the app's `fade-up`.
 */
const GLIDE_OMEGA = 22;
/** Below this the glide is done: the rest is a sub-pixel the eye can't see. */
const SETTLED_PX = 0.5;
/** A frame longer than this (a long task, a hidden window) settles at once. */
const MAX_FRAME_S = 0.1;
/**
 * Growth past this share of the viewport is not streaming: a conversation
 * opening, a tall block landing in one commit. Gliding a whole screen would
 * read as a slow scroll the reader never asked for, so it snaps as before.
 */
const MAX_GLIDE_VIEWPORT_SHARE = 0.5;

/**
 * Bottom-stick's visible motion: the rows glide up toward where the bottom
 * pin has already put them, instead of jumping there.
 *
 * The pin itself is untouched — `scrollTop` lands on the bottom in the same
 * frame the content grows, so every layout read (Virtuoso, the at-bottom
 * checks, the anchor guard) sees the settled geometry. The glide is purely
 * visual: the rows are translated back down by the distance the pin moved,
 * then a spring brings the translation to zero. The list's footer (the working
 * cursor and its timer) is not translated, so it does not move at all.
 *
 * The rows are translated, not the list: a transformed box still counts toward
 * the scroller's scrollable overflow, so a list pushed past the footer would
 * inflate `scrollHeight` and every bottom pin would overshoot, then settle back
 * as the glide decays — moving the timer. With `overflow-y: clip` on the list,
 * the rows' overflow neither scrolls nor paints: the newest line rises out
 * from the footer's top edge instead of being drawn over the timer.
 *
 * Owns the rows' `transform` and the list's `overflow-y` only while
 * bottom-stick holds. `ScrollAnchorGuard` (which transforms the list) is idle
 * then, and `release` hands the remaining offset to the scroll position before
 * it wakes.
 */
export class StreamFollowGlide {
  private list: HTMLElement | null = null;
  private offset = 0;
  private velocity = 0;
  private frame = 0;
  private lastTime = 0;

  constructor(private readonly scroller: HTMLElement) {}

  /**
   * The pin just moved the view `delta` px down: show that move as a glide.
   * Returns false when the move is too large to glide (it then snaps).
   */
  absorb(delta: number): boolean {
    const viewport = this.scroller.clientHeight;
    const list = findStreamItemList(this.scroller);
    if (!list || delta <= 0 || delta > viewport * MAX_GLIDE_VIEWPORT_SHARE) {
      this.stop();
      return false;
    }
    if (list !== this.list) {
      this.stop();
      this.list = list;
    }
    // A kick displaces the spring without touching its velocity, so a glide
    // already under way carries on smoothly instead of restarting.
    this.offset = Math.min(this.offset + delta, viewport);
    this.apply();
    if (!this.frame) {
      this.lastTime = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
    return true;
  }

  /**
   * Ends the glide where it stands and returns the offset still in flight, so
   * the caller can move the scroll position by it and nothing jumps on screen.
   */
  release(): number {
    const rest = this.offset;
    this.stop();
    return rest;
  }

  /** Drops the glide at once. */
  stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.offset = 0;
    this.velocity = 0;
    this.apply();
  }

  private readonly tick = (now: number): void => {
    this.frame = 0;
    const dt = Math.min(Math.max(0, (now - this.lastTime) / 1000), MAX_FRAME_S);
    this.lastTime = now;
    this.step(dt);
    if (this.offset <= SETTLED_PX || dt >= MAX_FRAME_S) {
      this.stop();
      return;
    }
    this.apply();
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Closed-form critically damped spring: exact for any frame length. */
  private step(dt: number): void {
    const decay = Math.exp(-GLIDE_OMEGA * dt);
    const drive = this.velocity + GLIDE_OMEGA * this.offset;
    this.offset = (this.offset + drive * dt) * decay;
    this.velocity = (this.velocity - GLIDE_OMEGA * drive * dt) * decay;
    // Critically damped from a kick it never crosses zero, but a large
    // velocity left over from a previous kick could: never glide past rest.
    if (this.offset < 0) {
      this.offset = 0;
      this.velocity = 0;
    }
  }

  private apply(): void {
    const list = this.list;
    if (!list) return;
    // Every frame, not once: Virtuoso mounts rows as the range moves, and a
    // row mounted mid-glide must ride with the others.
    const transform = this.offset > 0 ? `translateY(${this.offset}px)` : "";
    for (const row of list.children) {
      if (row instanceof HTMLElement) row.style.transform = transform;
    }
    // Only on change: the anchor guard observes the list's style attribute,
    // and an unchanged write still queues it a mutation record.
    const overflowY = this.offset > 0 ? "clip" : "";
    if (list.style.overflowY !== overflowY) list.style.overflowY = overflowY;
    if (this.offset === 0) this.list = null;
  }
}
