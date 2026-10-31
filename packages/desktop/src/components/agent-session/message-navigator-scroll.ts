import type { VirtuosoHandle } from "react-virtuoso";
import { isIos } from "@/lib/is-ios";
import { findStreamItemList, USER_SCROLL_EVENTS } from "./agent-session-scroll-utils";

/** Breathing room left above a prompt the navigator scrolls to. */
const JUMP_TOP_OFFSET_PX = 12;
/** Glide only to rows within this many viewports: their neighbours are measured. */
const SMOOTH_RANGE_VIEWPORTS = 1.5;
/** Frames the scroller and list must hold still before anything is measured. */
const SETTLE_FRAMES = 3;
/** Consecutive settled checks with the prompt in place that end the jump. */
const ALIGNED_CHECKS = 4;
/** Index scrolls re-issued when the first one landed far off. */
const MAX_REISSUES = 2;
/** Hard stop for the hold loop, so a jump never polls forever. */
const MAX_JUMP_MS = 2500;
const ARRIVAL_FLASH_CLASS = "user-message-arrival-flash";

function findRow(scroller: HTMLElement, blockId: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
}

/** Distance (px) between a mounted row's top and where a jump wants it. */
function rowOffset(scroller: HTMLElement, row: HTMLElement): number {
  const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  return delta - JUMP_TOP_OFFSET_PX;
}

function animationsEnabled(): boolean {
  return document.documentElement.dataset.animations !== "off";
}

const USER_BUBBLE_SELECTOR = '[data-testid="user-message-bubble"]';

function flashArrival(scroller: HTMLElement, blockId: string, selectors: readonly string[]): void {
  // With animations off the keyframes never run, so `animationend` would never
  // clear the class.
  if (!animationsEnabled()) return;
  const row = findRow(scroller, blockId);
  const target = selectors
    .map((selector) => row?.querySelector<HTMLElement>(selector))
    .find((element) => element != null);
  if (!target) return;
  target.classList.remove(ARRIVAL_FLASH_CLASS);
  // Restart the keyframes when the same target is jumped to twice in a row.
  void target.offsetWidth;
  target.classList.add(ARRIVAL_FLASH_CLASS);
  target.addEventListener("animationend", () => target.classList.remove(ARRIVAL_FLASH_CLASS), {
    once: true,
  });
}

interface JumpArgs {
  scroller: HTMLElement;
  virtuoso: VirtuosoHandle | null;
  blockId: string;
  rowIndex: number;
  /**
   * What flashes on arrival, first match inside the row: the user's bubble by
   * default (a prompt jump), a sub-agent card for the composer's agent list.
   */
  flashSelectors?: readonly string[];
}

function scrollToRowIndex({ virtuoso, rowIndex }: JumpArgs): void {
  virtuoso?.scrollToIndex({
    index: rowIndex,
    align: "start",
    offset: -JUMP_TOP_OFFSET_PX,
    behavior: "auto",
  });
}

/** Starts the scroll: a glide to a nearby row, an index jump otherwise. Returns whether it glides. */
function startJump(args: JumpArgs): boolean {
  const { scroller, blockId } = args;
  const row = findRow(scroller, blockId);
  const offset = row ? rowOffset(scroller, row) : null;
  const nearby =
    offset !== null && Math.abs(offset) < scroller.clientHeight * SMOOTH_RANGE_VIEWPORTS;
  if (offset !== null && nearby && animationsEnabled() && !isIos()) {
    scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: "smooth" });
    return true;
  }
  scrollToRowIndex(args);
  return false;
}

interface HoldStep {
  done: boolean;
  landed: boolean;
  /** The prompt sits in place this frame (more checks may follow). */
  aligned?: boolean;
}

/**
 * Per-frame settle loop of a jump. Nothing is measured while the scroller or
 * the list is still moving: mid-update, Virtuoso lays rows out from its
 * estimates, and "correcting" against that transient layout throws the view
 * thousands of pixels off (the list then shrinks back, clamps to the bottom,
 * and bottom-stick re-engages). Once both hold still, a small residual is
 * nudged away; a large one means the estimate was off, so the index scroll is
 * re-issued with the measurements Virtuoso now has.
 */
class JumpHold {
  private stillFrames = 0;
  private alignedChecks = 0;
  private reissues = 0;
  private lastTop: number;
  private lastHeight: number;

  constructor(
    private readonly args: JumpArgs,
    /** iOS corrects through Virtuoso's deviation offset; raw writes fight it. */
    private readonly canWrite: boolean,
  ) {
    this.lastTop = args.scroller.scrollTop;
    this.lastHeight = args.scroller.scrollHeight;
  }

  /** One frame. Returns whether the jump is over and whether it landed. */
  step(): HoldStep {
    const { scroller, blockId } = this.args;
    const top = scroller.scrollTop;
    const height = scroller.scrollHeight;
    const moving = Math.abs(top - this.lastTop) >= 1 || height !== this.lastHeight;
    this.lastTop = top;
    this.lastHeight = height;
    this.stillFrames = moving ? 0 : this.stillFrames + 1;
    if (this.stillFrames < SETTLE_FRAMES) return { done: false, landed: false };

    const row = findRow(scroller, blockId);
    const residual = row ? rowOffset(scroller, row) : null;
    if (residual !== null && Math.abs(residual) <= 1) {
      this.alignedChecks += 1;
      return { done: this.alignedChecks >= ALIGNED_CHECKS, landed: true, aligned: true };
    }
    this.alignedChecks = 0;
    if (residual !== null && Math.abs(residual) < scroller.clientHeight) {
      if (!this.canWrite) return { done: true, landed: true };
      scroller.scrollTop = top + residual;
      // A clamped write — a prompt near the end can't reach the top — has landed.
      if (Math.abs(scroller.scrollTop - top) < 1) return { done: true, landed: true };
      this.stillFrames = 0;
      return { done: false, landed: false };
    }
    if (this.reissues < MAX_REISSUES) {
      this.reissues += 1;
      this.stillFrames = 0;
      scrollToRowIndex(this.args);
      return { done: false, landed: false };
    }
    return { done: true, landed: row !== null };
  }
}

/**
 * Scrolls a row (a prompt, a sub-agent card) to the top of the stream and
 * flashes it on arrival.
 *
 * A nearby row glides there — everything between is already measured, so it
 * can't drift. A far row is brought in instantly by index: gliding across
 * unmeasured rows makes the target move as Virtuoso measures them, which reads
 * as a jump at the end. Either way the row is then held in place (see
 * {@link JumpHold}) while heights around it settle. Any user scroll input
 * ends the hold.
 *
 * Returns a cancel function for a newer jump or an unmount.
 */
export function jumpToRow(args: JumpArgs): () => void {
  const { scroller, blockId } = args;
  // A far jump lands through a few estimate corrections; the list stays
  // hidden until it settles, then fades in (see `data-nav-jumping` in
  // index.css) — a cut instead of a visible shuffle.
  if (!startJump(args)) scroller.dataset.navJumping = "";
  const hold = new JumpHold(args, !isIos());
  const deadline = performance.now() + MAX_JUMP_MS;
  let raf = 0;
  let done = false;

  const finish = (land: boolean): void => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, abort);
    delete scroller.dataset.navJumping;
    if (land) flashArrival(scroller, blockId, args.flashSelectors ?? [USER_BUBBLE_SELECTOR]);
  };
  function abort(): void {
    finish(false);
  }
  for (const type of USER_SCROLL_EVENTS) {
    scroller.addEventListener(type, abort, { passive: true });
  }

  const frame = (): void => {
    const { done: over, landed, aligned } = hold.step();
    // Reveal on the first aligned frame; the remaining checks run visibly.
    if (aligned) delete scroller.dataset.navJumping;
    if (over || performance.now() > deadline) {
      finish(over ? landed : findRow(scroller, blockId) !== null);
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return abort;
}

/**
 * Local row index of the stream row crossing `offsetPx` below the scroller's
 * top edge, or null when nothing is mounted there. Reads only the mounted
 * Virtuoso rows (a few dozen at most), so it is cheap enough per scroll frame.
 */
export function rowAtOffset(
  scroller: HTMLElement,
  rowByBlockId: ReadonlyMap<string, number>,
  offsetPx: number,
): number | null {
  const list = findStreamItemList(scroller);
  if (!list) return null;
  const lineY = scroller.getBoundingClientRect().top + offsetPx;
  let lastRow: number | null = null;
  for (const child of Array.from(list.children)) {
    const blockId = child.querySelector<HTMLElement>("[data-block-id]")?.dataset.blockId;
    const row = blockId === undefined ? undefined : rowByBlockId.get(blockId);
    if (row === undefined) continue;
    lastRow = row;
    if (child.getBoundingClientRect().bottom > lineY) return row;
  }
  return lastRow;
}
