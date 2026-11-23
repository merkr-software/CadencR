import type { FollowOutput, SizeFunction, VirtuosoHandle } from "react-virtuoso";
import { STREAM_BOTTOM_GAP_PX } from "./stream-fade";
import type { HistoryGapStatus } from "./useHistoryGapFiller";

export type ScrollRef = (el: HTMLElement | null) => void;

export const SCROLLBAR_HIT_TARGET_PX = 20;
/** Input that hands the viewport back to the reader after a programmatic jump. */
export const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** Marks a history gap's row content in the DOM, with the gap's id. */
export const HISTORY_GAP_ATTRIBUTE = "data-history-gap-id";
/** Set on a gap row when loaded history sits above it (the gap can fill downward). */
export const HISTORY_GAP_HAS_ABOVE_ATTRIBUTE = "data-history-gap-has-above";
/** Virtuoso's absolute row index attribute, on every rendered row. */
const ROW_INDEX_ATTRIBUTE = "data-item-index";

/** A rendered Virtuoso row standing for a history gap (its content is the gap's element). */
export function isHistoryGapRow(row: Element): boolean {
  return row.firstElementChild?.hasAttribute(HISTORY_GAP_ATTRIBUTE) ?? false;
}

/**
 * The row the reader reads from: the first rendered row whose top edge is on
 * screen, else the one spanning the top edge — never a gap row. The scroll
 * anchor guard holds it still, and a history gap fills toward it: a gap above
 * it loads the messages just over it, a gap below it those just under the
 * rows above that gap, so a page never lands between the reader and their row.
 */
export function readerFocusRow(
  list: Element,
  viewportTop: number,
  viewportBottom: number,
): { row: Element; rect: DOMRect } | null {
  let spanning: { row: Element; rect: DOMRect } | null = null;
  for (const row of list.children) {
    if (!row.hasAttribute(ROW_INDEX_ATTRIBUTE) || isHistoryGapRow(row)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= viewportTop) continue;
    if (rect.top >= viewportBottom) break;
    if (rect.top >= viewportTop) return { row, rect };
    spanning ??= { row, rect };
  }
  return spanning;
}

/** Virtuoso's item list: the direct parent of the stream's rendered rows. */
export function findStreamItemList(scroller: HTMLElement): HTMLElement | null {
  return scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
}

export function canScroll(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight;
}

/**
 * `canScroll` for the agent-stream scroller, which always carries a blank
 * `STREAM_BOTTOM_GAP_PX` spacer under the last message.
 *
 * That spacer is scrollable but empty, so the raw check reports overflow on a
 * conversation that visually fits — and every "did the user mean to scroll?"
 * gate hangs off it. Left unsubtracted, a stray wheel-up on a short session
 * disengages bottom-stick, and viewport backfill of older history stops before
 * it starts. Other scrollers (`useStickToBottom`) have no such spacer and want
 * the raw check.
 */
export function canScrollStream(el: HTMLElement): boolean {
  return el.scrollHeight - STREAM_BOTTOM_GAP_PX > el.clientHeight;
}

export function isVerticalScrollbarPointer(el: HTMLElement, e: PointerEvent): boolean {
  const rect = el.getBoundingClientRect();
  return e.clientX >= rect.right - SCROLLBAR_HIT_TARGET_PX && e.clientX <= rect.right + 1;
}

/**
 * Runs a programmatic jump (`run` starts it and returns its cancel) after
 * handing it the viewport and cancelling any jump still settling. The jump
 * calls `settled` once its row holds still, which hands the view back to the
 * scroll anchor guard and history gap loading. Returns the cancel, for a
 * caller that unmounts before the session does.
 */
export type StartJump = (run: (settled: () => void) => () => void) => () => void;

export interface UseAgentSessionScrollResult {
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  scrollContainerRef: ScrollRef;
  /** Virtuoso `itemSize`: lets the scroll anchor guard settle with each measurement pass. */
  itemSize: SizeFunction;
  followOutput: FollowOutput;
  onAtBottomStateChange: (atBottom: boolean) => void;
  onTotalListHeightChanged: (height: number) => void;
  autoScrollEnabled: boolean;
  /** Which history gap is loading or failed, for the gap rows to show. */
  historyGapStatus: HistoryGapStatus;
  /** Holds history gap loading (a prompt's turn loading ahead of a jump); returns the release. */
  holdHistoryFills: () => () => void;
  scrollToBottom: () => void;
  /** Hand the viewport to a programmatic jump (releases bottom-stick and the anchor guard). */
  startJump: StartJump;
}
