import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { DisplayItem } from "@/types/agent-stream";
import { STREAM_TOP_GAP_PX } from "@/lib/stream-rhythm";
import { findStreamItemList } from "./agent-session-scroll-utils";

/**
 * Why the transcript has a preview at all.
 *
 * Virtuoso cannot show a conversation's tail in the commit that mounts it. Told
 * to open on the last row, it renders an empty list, measures its viewport
 * through a `ResizeObserver`, waits four animation frames, scrolls, and only
 * then renders rows and measures them: three to five frames (50–80 ms at 60 Hz)
 * during which an opened conversation shows nothing. The preview fills exactly
 * that hole: the last rows, rendered in place in the first commit, laid out and
 * scrolled like the list will be, and dropped once the list has caught up.
 */

/** Never fewer rows than this, however tall they are estimated to be. */
const MIN_TAIL_ROWS = 3;
/** Never more: each row is rendered a second time by the list. */
const MAX_TAIL_ROWS = 14;
/** How long the preview may stay if the list never reports settling. */
const LIST_SETTLE_DEADLINE_MS = 600;
/** Consecutive frames the list must rest on its bottom before it takes over. */
const SETTLED_FRAMES = 2;

/**
 * A reversed column rests on its bottom edge and stays there while its content
 * changes height (rows settle after their first layout: deferred paint,
 * highlighted code, a streamed line), with no scroll position to write. The
 * content's bottom auto margin takes the free space of a short transcript, so
 * it sits at the top as it does in the list.
 */
const PREVIEW_SCROLLER_CLASS =
  "absolute inset-0 flex flex-col-reverse overflow-x-hidden overflow-y-auto";

/** A rough row height, only to decide how many rows fill a viewport. */
function estimateRowHeight(item: DisplayItem): number {
  if (item.kind === "flow") return 32;
  if (item.kind === "gap") return 24;
  const { type, content } = item.block;
  if (type === "text" || type === "user_message" || type === "tool_result") {
    return Math.min(900, 48 + Math.ceil(content.length / 90) * 22);
  }
  return 36;
}

/** The last rows of `items`, enough to cover `viewportHeight` with some margin. */
export function selectTailItems(items: readonly DisplayItem[], viewportHeight: number): number {
  let height = 0;
  let count = 0;
  for (let i = items.length - 1; i >= 0 && count < MAX_TAIL_ROWS; i -= 1) {
    if (count >= MIN_TAIL_ROWS && height >= viewportHeight) break;
    const item = items[i];
    if (item) height += estimateRowHeight(item);
    count += 1;
  }
  return count;
}

interface TranscriptTailPreviewProps {
  items: readonly DisplayItem[];
  /** Renders one row exactly as the list does. */
  renderRow: (item: DisplayItem) => ReactNode;
  /** What the list renders under its last row (the working cursor, the bottom gap). */
  footer: ReactNode;
}

/**
 * The transcript's last rows in a plain scroller resting on its bottom: what the
 * list shows once it has opened, without the frames it takes to get there.
 */
export const TranscriptTailPreview = memo(function TranscriptTailPreview({
  items,
  renderRow,
  footer,
}: TranscriptTailPreviewProps) {
  // Fixed at mount: growing the tail under a stream would re-render rows the
  // list is about to take over anyway.
  const [tailCount] = useState(() => selectTailItems(items, window.innerHeight));
  const tail = items.slice(Math.max(0, items.length - tailCount));
  return (
    <div data-testid="agent-stream-tail-preview" className={PREVIEW_SCROLLER_CLASS}>
      <div className="mb-auto">
        {/* The list's room above its first row (`StreamHeader`), when that row is here. */}
        {tail.length === items.length && <div aria-hidden style={TOP_GAP_STYLE} />}
        {/* `data-tail-row` keeps a row's margins inside its box, by the rule
            the list's rows follow (index.css): the same height in both. */}
        {tail.map((item) => (
          <div key={item.key} data-tail-row>
            {renderRow(item)}
          </div>
        ))}
        {footer}
      </div>
    </div>
  );
});

function isRestingOnBottom(scroller: HTMLElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
}

function hasRows(scroller: HTMLElement): boolean {
  return (findStreamItemList(scroller)?.childElementCount ?? 0) > 0;
}

/** The list shows what the preview shows: its rows are in, resting on the bottom. */
function hasOpenedOnTail(scroller: HTMLElement | null): boolean {
  return scroller !== null && hasRows(scroller) && isRestingOnBottom(scroller);
}

/**
 * Whether the list behind the preview has rendered its rows and come to rest
 * on its bottom, i.e. shows what the preview shows. Latches: once the list has
 * taken over it keeps the transcript for good.
 *
 * `active` is false while there is nothing to wait for (an empty transcript).
 */
export function useListSettled(
  scrollerRef: RefObject<HTMLElement | null>,
  active: boolean,
): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled || !active) return undefined;
    // Nothing to stand in for: a list that rendered and placed its rows as it
    // mounted, or one that exposes no scroller to watch.
    const scroller = scrollerRef.current;
    if (scroller === null || hasOpenedOnTail(scroller)) {
      setSettled(true);
      return undefined;
    }
    let frame = 0;
    let restingFrames = 0;
    const deadline = window.setTimeout(() => setSettled(true), LIST_SETTLE_DEADLINE_MS);
    // A handful of frames, then never again: the reads are bounded by the latch.
    const check = (): void => {
      restingFrames = hasOpenedOnTail(scrollerRef.current) ? restingFrames + 1 : 0;
      if (restingFrames >= SETTLED_FRAMES) {
        setSettled(true);
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
    };
  }, [active, scrollerRef, settled]);
  return settled;
}

const TOP_GAP_STYLE: CSSProperties = { height: STREAM_TOP_GAP_PX };
const LIST_STYLE: CSSProperties = { height: "100%" };
// Behind the tail preview: laid out and scrollable (it is still opening), not painted.
const LIST_BEHIND_PREVIEW_STYLE: CSSProperties = { height: "100%", visibility: "hidden" };

interface TailPreviewOptions<TContext> {
  /** Off for a stream that renders no preview (an embedded card): the list shows at once. */
  enabled: boolean;
  /** The list's scroller, watched until it has opened on its last row. */
  scrollerRef: RefObject<HTMLElement | null>;
  items: DisplayItem[];
  /** The list's own row renderer, called as the list calls it. */
  renderItem: (index: number, item: DisplayItem, context: TContext) => ReactNode;
  context: TContext;
  /** The list's footer component, rendered under the preview's rows. */
  Footer: ComponentType<{ context?: TContext }>;
}

/**
 * The tail preview that stands in for the list until it has opened on its last
 * row, rendering rows and footer as the list does, and the style the list
 * takes meanwhile (laid out underneath, unpainted).
 */
export function useTailPreview<TContext>({
  enabled,
  scrollerRef,
  items,
  renderItem,
  context,
  Footer,
}: TailPreviewOptions<TContext>): { listStyle: CSSProperties; preview: ReactNode } {
  const settled = useListSettled(scrollerRef, enabled && items.length > 0);
  const listSettled = settled || !enabled;
  const renderRow = useCallback(
    (item: DisplayItem): ReactNode => renderItem(0, item, context),
    [context, renderItem],
  );
  const footer = useMemo(() => <Footer context={context} />, [Footer, context]);
  const preview = listSettled ? null : (
    <TranscriptTailPreview items={items} renderRow={renderRow} footer={footer} />
  );
  return { listStyle: listSettled ? LIST_STYLE : LIST_BEHIND_PREVIEW_STYLE, preview };
}
