import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/api-errors";
import type { VirtuosoHandle } from "react-virtuoso";
import type { DisplayItem } from "@/types/agent-stream";
import { useScopedShortcut } from "@/hooks/useShortcut";
import {
  adjacentMarkIndex,
  markIndexAtRow,
  type UserMessageMark,
} from "@/lib/agent-message-navigator";
import { jumpToRow, rowAtOffset } from "./message-navigator-scroll";
import { useSessionPromptMarks } from "./useSessionPromptMarks";

/**
 * Probe just below where a jump parks a prompt (12px down): the turn crossing
 * it is the current one, and ⌥↑ skips the prompt already sitting there. A
 * line further down misattributes short turns to the next prompt.
 */
const TOP_PROBE_PX = 16;

/** What the navigator needs from the session's scroll owner. */
export interface MessageNavigatorControls {
  prepareJump: () => void;
  /**
   * Loads one unloaded prompt and the start of its turn in a single request;
   * resolves with whether the prompt is now in the transcript.
   */
  loadPromptTurn: (messageDbId: number) => Promise<boolean>;
}

interface UseMessageNavigatorArgs {
  items: readonly DisplayItem[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  controls: MessageNavigatorControls;
  /** Agent tab focused — gates the ⌥↑ / ⌥↓ shortcuts. */
  shortcutsEnabled: boolean;
}

export interface MessageNavigatorState {
  marks: UserMessageMark[];
  /** Index (into `marks`) of the prompt whose turn is on screen, or -1. */
  activeIndex: number;
  /** Key of a prompt whose turn is being loaded before the jump. */
  pendingKey: string | null;
  jumpTo: (index: number) => void;
}

/**
 * Row of each display item, keyed by every block id it renders: a compact run's
 * first anchor in the DOM is its newest step, not its first block.
 */
export function rowsByBlockId(items: readonly DisplayItem[]): Map<string, number> {
  const rows = new Map<string, number>();
  for (const [row, item] of items.entries()) {
    if (item.kind === "block") rows.set(item.block.id, row);
    else for (const block of item.blocks) rows.set(block.id, row);
  }
  return rows;
}

/**
 * {@link rowsByBlockId}, built on first use: `items` changes on every streaming
 * delta, but rows are only looked up on scroll and on ⌥↑ / ⌥↓.
 */
function useRowByBlockId(items: readonly DisplayItem[]): () => Map<string, number> {
  return useMemo(() => {
    let map: Map<string, number> | null = null;
    return () => (map ??= rowsByBlockId(items));
  }, [items]);
}

/** Tracks which prompt's turn is at the top of the view, re-evaluated per scroll frame. */
function useActiveMarkIndex(
  marks: UserMessageMark[],
  rowByBlockId: () => Map<string, number>,
  scrollerRef: RefObject<HTMLElement | null>,
): number {
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputsRef = useRef({ marks, rowByBlockId });
  inputsRef.current = { marks, rowByBlockId };

  const measure = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { marks: currentMarks, rowByBlockId: rows } = inputsRef.current;
    const row = rowAtOffset(scroller, rows(), TOP_PROBE_PX);
    setActiveIndex(row === null ? -1 : markIndexAtRow(currentMarks, row));
  }, [scrollerRef]);

  // Captured at the document rather than bound to the scroller: Virtuoso hands
  // its scroller over in its own effects, which run after this one, so the
  // element is not there yet when we subscribe.
  useEffect(() => {
    let raf = 0;
    const onScroll = (event: Event): void => {
      if (raf || event.target !== scrollerRef.current) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      if (raf) cancelAnimationFrame(raf);
    };
  }, [measure, scrollerRef]);

  // A new prompt (or a history page) shifts rows without a scroll event.
  useEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [marks, measure]);

  return activeIndex;
}

const MISSING_PROMPT = "That message is no longer in the conversation.";

/**
 * Jumps to a prompt. One still in unloaded history is marked pending while its
 * turn loads; the jump runs once the prompt has a row.
 */
function useJumpToMark(
  marks: UserMessageMark[],
  virtuosoRef: RefObject<VirtuosoHandle | null>,
  scrollerRef: RefObject<HTMLElement | null>,
  { prepareJump, loadPromptTurn }: MessageNavigatorControls,
) {
  const cancelJumpRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelJumpRef.current?.(), []);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // Mirrors `pendingKey` for async callbacks: a settled load only acts if its
  // prompt is still the pending one (not cancelled, nor replaced by another).
  const pendingRef = useRef<string | null>(null);
  const setPending = useCallback((key: string | null): void => {
    pendingRef.current = key;
    setPendingKey(key);
  }, []);

  const scrollToMark = useCallback(
    (mark: UserMessageMark): void => {
      const scroller = scrollerRef.current;
      if (!scroller || mark.rowIndex === null || mark.blockId === null) return;
      prepareJump();
      cancelJumpRef.current?.();
      cancelJumpRef.current = jumpToRow({
        scroller,
        virtuoso: virtuosoRef.current,
        blockId: mark.blockId,
        rowIndex: mark.rowIndex,
      });
    },
    [prepareJump, scrollerRef, virtuosoRef],
  );

  const loadThenJump = useCallback(
    (key: string, messageDbId: number): void => {
      const fail = (report: () => void): void => {
        if (pendingRef.current !== key) return;
        setPending(null);
        report();
      };
      setPending(key);
      loadPromptTurn(messageDbId).then(
        (found) => {
          if (!found) fail(() => toast.error(MISSING_PROMPT));
        },
        (error: unknown) => fail(() => toastError(error, "Could not load that message")),
      );
    },
    [loadPromptTurn, setPending],
  );

  const jumpTo = useCallback(
    (index: number): void => {
      const mark = marks[index];
      if (!mark) return;
      if (mark.rowIndex !== null) {
        setPending(null);
        scrollToMark(mark);
      } else if (pendingRef.current === mark.key) {
        // Clicking the prompt being loaded again calls the load off.
        setPending(null);
      } else if (mark.messageDbId !== undefined) {
        loadThenJump(mark.key, mark.messageDbId);
      }
    },
    [marks, loadThenJump, scrollToMark, setPending],
  );

  // The loaded turn reaches the marks a render later: jump once it has a row.
  useEffect(() => {
    if (pendingKey === null) return;
    const mark = marks.find((candidate) => candidate.key === pendingKey);
    if (mark?.rowIndex === null) return;
    setPending(null);
    if (mark) scrollToMark(mark);
  }, [pendingKey, marks, scrollToMark, setPending]);

  return { jumpTo, pendingKey };
}

export function useMessageNavigator({
  items,
  virtuosoRef,
  scrollerRef,
  controls,
  shortcutsEnabled,
}: UseMessageNavigatorArgs): MessageNavigatorState {
  const marks = useSessionPromptMarks(items);
  const rowByBlockId = useRowByBlockId(items);
  const activeIndex = useActiveMarkIndex(marks, rowByBlockId, scrollerRef);
  const { jumpTo, pendingKey } = useJumpToMark(marks, virtuosoRef, scrollerRef, controls);

  const jumpAdjacent = useCallback(
    (direction: -1 | 1): void => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const row = rowAtOffset(scroller, rowByBlockId(), TOP_PROBE_PX);
      if (row === null) return;
      const target = adjacentMarkIndex(marks, row, direction);
      if (target >= 0) jumpTo(target);
    },
    [jumpTo, marks, rowByBlockId, scrollerRef],
  );

  const shortcutOptions = { enabled: shortcutsEnabled && marks.length > 0, preventDefault: true };
  useScopedShortcut("agent-previous-message", () => jumpAdjacent(-1), "agent", shortcutOptions);
  useScopedShortcut("agent-next-message", () => jumpAdjacent(1), "agent", shortcutOptions);

  return useMemo(
    () => ({ marks, activeIndex, pendingKey, jumpTo }),
    [marks, activeIndex, pendingKey, jumpTo],
  );
}
