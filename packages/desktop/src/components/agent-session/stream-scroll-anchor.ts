import type { SizeFunction } from "react-virtuoso";
import { isIos } from "@/lib/is-ios";
import { findStreamItemList, USER_SCROLL_EVENTS } from "./agent-session-scroll-utils";
import type { StreamScrollWriter } from "./stream-scroll-writer";

/** Absolute row index (`firstItemIndex`-based), aligned across prepends. */
const ITEM_INDEX_ATTRIBUTE = "data-item-index";
/** Local row index: "0" is the list's first row. */
const LOCAL_INDEX_ATTRIBUTE = "data-index";
const BLOCK_ID_ATTRIBUTE = "data-block-id";
/** Fractional layout noise: never worth moving the view for. */
const DRIFT_EPSILON_PX = 0.5;

/** Everything the guard holds while attached to a stream scroller. */
interface Attachment {
  scroller: HTMLElement;
  writer: StreamScrollWriter;
  list: HTMLElement;
  resizeObserver: ResizeObserver;
  mutationObserver: MutationObserver;
}

interface Anchor {
  itemIndex: string;
  /** First block the row renders, so a re-keyed row is not mistaken for it. */
  blockId: string | null;
  /** The list's first row, which older history is inserted below (see `pickAnchor`). */
  listHead: boolean;
  /** Row top in layout content coordinates: independent of scroll and of the bridge. */
  top: number;
}

/** The part of `requested` that moves in the direction of `pending`, capped at it. */
function clampToward(requested: number, pending: number): number {
  if (requested === 0 || Math.sign(requested) !== Math.sign(pending)) return 0;
  return Math.sign(requested) * Math.min(Math.abs(requested), Math.abs(pending));
}

function firstBlockId(row: Element): string | null {
  return row.querySelector(`[${BLOCK_ID_ATTRIBUTE}]`)?.getAttribute(BLOCK_ID_ATTRIBUTE) ?? null;
}

function isListHead(row: Element): boolean {
  return row.getAttribute(LOCAL_INDEX_ATTRIBUTE) === "0";
}

/**
 * The anchor's row: its block wherever it now sits, else the row now holding
 * its absolute index. The second case is a row re-keyed in place — summary
 * mode re-keys a recap when older history extends its turn — and
 * `firstItemIndex` keeps absolute indices aligned across prepends, so that
 * row is still the one the reader was looking at.
 *
 * The list's first row goes by position outright: a page inserted below it
 * takes over its absolute index with the newest loaded row, which is what
 * Virtuoso keeps in place too — the reader lands in the page they asked for
 * and can keep scrolling up through it.
 */
function findAnchorRow(list: HTMLElement, anchor: Anchor): Element | null {
  const byIndex = list.querySelector(`[${ITEM_INDEX_ATTRIBUTE}="${anchor.itemIndex}"]`);
  if (byIndex && (anchor.listHead || firstBlockId(byIndex) === anchor.blockId)) return byIndex;
  const block =
    anchor.blockId === null
      ? null
      : list.querySelector(`[${BLOCK_ID_ATTRIBUTE}="${CSS.escape(anchor.blockId)}"]`);
  return block?.closest(`[${ITEM_INDEX_ATTRIBUTE}]`) ?? byIndex;
}

/**
 * Keeps the agent stream's reading position still while rows above it change
 * height — the "jumps when scrolling up".
 *
 * Virtuoso places rows from a size table in which a row it never rendered
 * carries an estimate: `defaultItemHeight`, or the last row's size for
 * prepended history. Scrolling up mounts those rows above the viewport at their
 * real height — hundreds to thousands of pixels for a Maximal-mode tool call —
 * and everything below is pushed down. Virtuoso does compensate, but a frame
 * late (its ResizeObserver work is deferred to the next animation frame) and
 * only while it believes the user is scrolling up: the reader sees frames of
 * another part of the conversation, blank frames, and compensation for growth
 * *below* the viewport too, such as a streamed reply.
 *
 * The guard owns that compensation against ground truth instead:
 *
 * 1. **Measure.** An anchor row — the first one whose top edge is on screen —
 *    is tracked in layout content coordinates. After every list commit
 *    (MutationObserver) and row resize (ResizeObserver), both of which run
 *    before paint, its drift is exactly how far content above it moved.
 * 2. **Bridge.** The drift is cancelled visually in the same frame with a
 *    `transform` on the item list. Scrolling instead would hand Virtuoso a
 *    scroll position its still-estimated size table maps to other rows, and it
 *    would render those. The footer stays put, so `scrollHeight` (and with it
 *    the scroll position) can't be clamped by the bridge.
 * 3. **Settle.** The bridge is converted into a real scroll offset inside
 *    Virtuoso's measurement pass (its `itemSize` callback, see
 *    {@link ScrollAnchorGuard.measureItem}): the one moment its size table
 *    catches up with the DOM, right before it re-reads `scrollTop`. Sizes and
 *    offset land together, so it never renders one without the other. A
 *    two-frame fallback settles drift that no measurement pass follows.
 * 4. **Arbitrate.** Virtuoso's own compensation still arrives through
 *    `scrollBy`, which the {@link StreamScrollWriter} hands to the guard; it
 *    is honoured only up to the drift measured and still pending — anything
 *    beyond that is growth it attributed to the wrong side of the viewport.
 *
 * Every offset it moves goes through the writer as `keep-anchor`.
 *
 * Idle while bottom-stick is engaged (the bottom pin owns the viewport then)
 * and between a programmatic jump and the next user scroll input. Not used on
 * iOS: Virtuoso corrects through its own deviation offset there, and writing
 * `scrollTop` during momentum scrolling fights it (see `observeListGrowth`).
 */
export class ScrollAnchorGuard {
  private attached: Attachment | null = null;
  /** Null until a scroll sets a baseline, and again whenever the guard stands down. */
  private anchor: Anchor | null = null;
  /** Measured drift not yet absorbed by the scroll offset (px, + = content moved down). */
  private pending = 0;
  private suspended = false;
  private fallbackFrame = 0;

  /** `isEngaged` reports bottom-stick: the guard stands down while it holds. */
  constructor(private readonly isEngaged: () => boolean) {}

  attach(scroller: HTMLElement, writer: StreamScrollWriter): void {
    this.detach();
    if (isIos()) return;
    // Degrades to Virtuoso's own compensation if its DOM contract changes.
    const list = findStreamItemList(scroller);
    if (!list) return;
    const resizeObserver = new ResizeObserver(this.check);
    for (const row of list.children) resizeObserver.observe(row);
    const mutationObserver = new MutationObserver(this.onListMutation);
    mutationObserver.observe(list, {
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    this.attached = { scroller, writer, list, resizeObserver, mutationObserver };
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    for (const type of USER_SCROLL_EVENTS) {
      scroller.addEventListener(type, this.resume, { passive: true });
    }
    writer.setCompensationArbiter(this.arbitrateScrollBy);
  }

  detach(): void {
    const attached = this.attached;
    if (!attached) return;
    this.reset();
    attached.resizeObserver.disconnect();
    attached.mutationObserver.disconnect();
    attached.scroller.removeEventListener("scroll", this.onScroll);
    for (const type of USER_SCROLL_EVENTS) {
      attached.scroller.removeEventListener(type, this.resume);
    }
    attached.writer.setCompensationArbiter(null);
    this.attached = null;
  }

  /** Hands the viewport to a programmatic jump until the next user scroll input. */
  suspend(): void {
    this.suspended = true;
    this.reset();
  }

  /**
   * Virtuoso `itemSize`: Virtuoso's default measurement, preceded by settling
   * the bridged drift. Virtuoso calls it at the start of each measurement pass,
   * before it re-reads `scrollTop`, so the settled offset is what it sees.
   */
  readonly measureItem: SizeFunction = (el, field) => {
    this.settle();
    return Math.round(el.getBoundingClientRect()[field === "offsetWidth" ? "width" : "height"]);
  };

  /** The attachment while the guard should act; otherwise drops any bridge. */
  private activeAttachment(): Attachment | null {
    const attached = this.attached;
    // The layout read goes last: this runs on every list commit, including
    // every streamed chunk while bottom-stick is engaged.
    if (attached && !this.suspended && !this.isEngaged() && attached.scroller.clientHeight > 0) {
      return attached;
    }
    this.reset();
    return null;
  }

  private readonly resume = (): void => {
    this.suspended = false;
  };

  private readonly onScroll = (): void => {
    // Content coordinates don't move with the scroll offset, so this only
    // keeps the anchor on screen; drift is measured against it by `check`.
    const attached = this.activeAttachment();
    if (attached) this.anchor = this.pickAnchor(attached);
  };

  private readonly onListMutation = (records: MutationRecord[]): void => {
    const resizeObserver = this.attached?.resizeObserver;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) resizeObserver?.observe(node);
      }
      for (const node of record.removedNodes) {
        if (node instanceof Element) resizeObserver?.unobserve(node);
      }
    }
    this.check();
  };

  private readonly check = (): void => {
    const attached = this.activeAttachment();
    const anchor = this.anchor;
    if (!attached || !anchor) return;
    const row = findAnchorRow(attached.list, anchor);
    if (!row) {
      // The anchor's row left the list (unmounted, or the data was replaced):
      // whatever moved went unmeasured, so Virtuoso's compensation is trusted
      // as-is until the next scroll sets a new baseline.
      this.reset();
      return;
    }
    const drift = this.layoutTop(attached.scroller, row) - anchor.top;
    if (Math.abs(drift) > DRIFT_EPSILON_PX) {
      this.pending += drift;
      this.applyBridge();
      this.scheduleFallbackSettle();
    }
    this.anchor = this.pickAnchor(attached);
  };

  /** Virtuoso's `scrollBy`; false lets it run natively. */
  private readonly arbitrateScrollBy = (requestedTop: number): boolean => {
    // Without a measured anchor there is no ground truth to arbitrate with.
    const attached = this.anchor ? this.activeAttachment() : null;
    if (!attached) return false;
    const applied = clampToward(requestedTop, this.pending);
    if (applied !== 0) this.absorb(attached, applied);
    return true;
  };

  /** Converts the whole bridge into scroll offset. */
  private settle(): void {
    if (this.pending === 0) return;
    const attached = this.activeAttachment();
    if (!attached) return;
    this.cancelFallback();
    this.absorb(attached, this.pending);
  }

  /** Moves `amount` of bridged drift into the scroll offset; the view does not move. */
  private absorb(attached: Attachment, amount: number): void {
    this.pending -= amount;
    this.applyBridge();
    attached.writer.scrollBy("keep-anchor", amount);
  }

  private scheduleFallbackSettle(): void {
    if (this.fallbackFrame) return;
    this.fallbackFrame = requestAnimationFrame(() => {
      this.fallbackFrame = requestAnimationFrame(() => {
        this.fallbackFrame = 0;
        this.settle();
      });
    });
  }

  private cancelFallback(): void {
    if (!this.fallbackFrame) return;
    cancelAnimationFrame(this.fallbackFrame);
    this.fallbackFrame = 0;
  }

  private applyBridge(): void {
    const list = this.attached?.list;
    if (!list) return;
    list.style.transform =
      Math.abs(this.pending) > DRIFT_EPSILON_PX ? `translateY(${-this.pending}px)` : "";
  }

  /** Drops any bridge and the anchor; the next scroll starts afresh. */
  private reset(): void {
    this.cancelFallback();
    this.anchor = null;
    if (this.pending === 0) return;
    this.pending = 0;
    this.applyBridge();
  }

  private layoutTop(scroller: HTMLElement, row: Element): number {
    const viewportTop = scroller.getBoundingClientRect().top;
    return row.getBoundingClientRect().top - viewportTop + scroller.scrollTop + this.pending;
  }

  /**
   * The first row whose top edge is on screen, else the row spanning the top
   * edge. The list's first row only anchors when nothing else is on screen:
   * while older history remains it is the session's first prompt, shipped
   * ahead of the loaded window, and older pages are inserted *below* it —
   * holding it in place would let each page push the reader's rows away. When
   * it does anchor, it is followed by position, not identity (`findAnchorRow`).
   */
  private pickAnchor({ scroller, list }: Attachment): Anchor | null {
    const viewportTop = scroller.getBoundingClientRect().top;
    const viewportBottom = viewportTop + scroller.clientHeight;
    let spanning: Element | null = null;
    let listHead: Element | null = null;
    for (const row of list.children) {
      if (!row.hasAttribute(ITEM_INDEX_ATTRIBUTE)) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewportTop) continue;
      if (rect.top >= viewportBottom) break;
      if (isListHead(row)) {
        listHead = row;
        continue;
      }
      if (rect.top >= viewportTop) return this.toAnchor(scroller, row);
      spanning ??= row;
    }
    const fallback = spanning ?? listHead;
    return fallback ? this.toAnchor(scroller, fallback) : null;
  }

  private toAnchor(scroller: HTMLElement, row: Element): Anchor {
    return {
      itemIndex: row.getAttribute(ITEM_INDEX_ATTRIBUTE) ?? "",
      blockId: firstBlockId(row),
      listHead: isListHead(row),
      top: this.layoutTop(scroller, row),
    };
  }
}
