import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { apiErrorMessage } from "@/lib/api-errors";
import type { HistoryGapFillDirection } from "@/stores/ws-history-gaps";
import type { HistoryGap } from "@/types/agent-stream";
import { useWorkspaceActivity } from "@/components/workspace-pool/workspace-activity";
import {
  findStreamItemList,
  HISTORY_GAP_ATTRIBUTE,
  HISTORY_GAP_HAS_ABOVE_ATTRIBUTE,
  readerFocusRow,
} from "./agent-session-scroll-utils";

const GAP_FAILURE_FALLBACK = "The service didn't return these messages.";

/** `shouldContinue` is read before each page lands; false stops the fill there. */
export type FillHistoryGap = (
  gapId: string,
  direction: HistoryGapFillDirection,
  shouldContinue: () => boolean,
) => Promise<void>;

/** What the transcript's gap rows show and report: the one loading, the ones that failed. */
export interface HistoryGapStatus {
  fillingGapId: string | null;
  /** Why each failed gap did not load, by gap id. */
  failures: ReadonlyMap<string, string>;
  retry: () => void;
  /** A gap row mounted (it entered Virtuoso's rendered range); returns its unmount. */
  trackRow: (row: HTMLElement) => () => void;
}

interface Target {
  gapId: string;
  direction: HistoryGapFillDirection;
}

/**
 * The mounted gap row nearest the viewport (Virtuoso renders a screen or so
 * past each edge), and the side to fill it from: the reader's
 * (`readerFocusRow`). Before the reader has scrolled or jumped, only a row
 * actually on screen counts: a conversation being opened does not prefetch.
 * While the view follows the bottom, the reader is the bottom: every gap fills
 * from below, so the rows it adds push it up and away, and the fill stops.
 */
function pickTarget(
  scroller: HTMLElement,
  rows: ReadonlySet<HTMLElement>,
  {
    failed,
    prefetch,
    following,
  }: { failed: ReadonlyMap<string, string>; prefetch: boolean; following: boolean },
): Target | null {
  const viewport = scroller.getBoundingClientRect();
  if (viewport.height === 0) return null;
  let best: { row: HTMLElement; gapId: string; rect: DOMRect; distance: number } | null = null;
  for (const row of rows) {
    const gapId = row.getAttribute(HISTORY_GAP_ATTRIBUTE);
    if (!gapId || failed.has(gapId)) continue;
    const rect = row.getBoundingClientRect();
    const distance = Math.max(0, viewport.top - rect.bottom, rect.top - viewport.bottom);
    if ((distance > 0 && !prefetch) || (best && best.distance <= distance)) continue;
    best = { row, gapId, rect, distance };
  }
  if (!best) return null;
  if (following || !best.row.hasAttribute(HISTORY_GAP_HAS_ABOVE_ATTRIBUTE)) {
    return { gapId: best.gapId, direction: "older" };
  }
  const list = findStreamItemList(scroller);
  const focus = list ? readerFocusRow(list, viewport.top, viewport.bottom) : null;
  const below = focus !== null && best.rect.top > focus.rect.top;
  return { gapId: best.gapId, direction: below ? "newer" : "older" };
}

interface GapFillerOptions {
  scrollerElRef: React.MutableRefObject<HTMLElement | null>;
  conversationKey: string | null;
  historyGaps: readonly HistoryGap[];
  onFillGap: FillHistoryGap | undefined;
  /** Milliseconds before rows may land around the view (an index scroll still settling). */
  delayBeforeFill?: () => number;
  /** Bottom-stick engaged: the view follows the end of the conversation. */
  isFollowing?: () => boolean;
}

/**
 * The filler's working state, read and written outside React's render cycle.
 * Created once per mount, so every callback closing over it stays stable.
 */
interface FillerState {
  onFillGap: FillHistoryGap | undefined;
  gaps: readonly HistoryGap[];
  delayBeforeFill: (() => number) | undefined;
  isFollowing: (() => boolean) | undefined;
  rows: Set<HTMLElement>;
  filling: string | null;
  /** Failed gaps (id → why), skipped until `retry` or until another load closes them. */
  failed: Map<string, string>;
  /** The jump holding the view: 0 when none, else its hold's token. */
  paused: number;
  holdCount: number;
  /** The reader scrolled or jumped since the conversation opened. */
  engaged: boolean;
  generation: number;
  frame: number;
  delayTimer: ReturnType<typeof setTimeout> | null;
}

function useFillerState({
  historyGaps,
  onFillGap,
  delayBeforeFill,
  isFollowing,
}: GapFillerOptions): FillerState {
  const [state] = useState<FillerState>(() => ({
    onFillGap,
    gaps: historyGaps,
    delayBeforeFill,
    isFollowing,
    rows: new Set(),
    filling: null,
    failed: new Map(),
    paused: 0,
    holdCount: 0,
    engaged: false,
    generation: 0,
    frame: 0,
    delayTimer: null,
  }));
  state.onFillGap = onFillGap;
  state.gaps = historyGaps;
  state.delayBeforeFill = delayBeforeFill;
  state.isFollowing = isFollowing;
  return state;
}

/**
 * Fills history gaps as they come near the viewport, one page run at a time.
 * Nothing waits for a click: whenever the reader scrolls, a gap row mounts, a
 * fill lands or a jump settles, the nearest mounted gap row is filled from the
 * reader's side, until none is left in Virtuoso's rendered range. A reader
 * therefore never reaches a gap they can't see past, whichever way they came.
 *
 * Stands down while a programmatic jump settles (`holdForJump`: a page landing
 * above the jump's target would move it), while Virtuoso still re-aims an
 * index scroll (`delayBeforeFill`) and while its workspace is hidden — a fill
 * in flight stops at its next page then. A gap that failed is skipped until
 * `retry`; the others go on.
 */
export function useHistoryGapFiller(options: GapFillerOptions) {
  const { scrollerElRef, conversationKey, historyGaps } = options;
  const activity = useWorkspaceActivity();
  const work = useFillerState(options);
  const [fillingGapId, setFillingGapId] = useState<string | null>(null);
  // A copy of `work.failed`, so the rows re-render when it changes.
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const publishFailures = useCallback((): void => setFailures(new Map(work.failed)), [work]);

  const shouldContinue = useCallback(
    (generation: number): boolean =>
      generation === work.generation && work.paused === 0 && activity.isActive(),
    [activity, work],
  );

  const fill = useCallback(
    (target: Target, run: FillHistoryGap, schedule: () => void): void => {
      const generation = work.generation;
      const gapsBefore = work.gaps;
      work.filling = target.gapId;
      setFillingGapId(target.gapId);
      const settle = (message: string | null): void => {
        if (generation !== work.generation) return;
        work.filling = null;
        setFillingGapId(null);
        if (message !== null) {
          work.failed.set(target.gapId, message);
          publishFailures();
        }
        // Go on only once the fill moved a gap: one that changed nothing would
        // be picked again at once. Gaps not re-rendered yet wake the filler
        // from the effect below when they are.
        if (message !== null || work.gaps !== gapsBefore) schedule();
      };
      run(target.gapId, target.direction, () => shouldContinue(generation)).then(
        () => settle(null),
        (error: unknown) => settle(apiErrorMessage(error, GAP_FAILURE_FALLBACK)),
      );
    },
    [publishFailures, work, shouldContinue],
  );

  const schedule = useCallback((): void => {
    if (work.frame || work.rows.size === 0) return;
    work.frame = requestAnimationFrame(() => {
      work.frame = 0;
      const run = work.onFillGap;
      const scroller = scrollerElRef.current;
      if (!run || !scroller || work.filling !== null) return;
      if (work.paused || !activity.isActive()) return;
      const delay = work.delayBeforeFill?.() ?? 0;
      if (delay > 0) {
        work.delayTimer ??= setTimeout(() => {
          work.delayTimer = null;
          schedule();
        }, delay);
        return;
      }
      const target = pickTarget(scroller, work.rows, {
        failed: work.failed,
        prefetch: work.engaged,
        following: work.isFollowing?.() ?? false,
      });
      if (target) fill(target, run, schedule);
    });
  }, [activity, fill, work, scrollerElRef]);

  const controls = useFillerControls(work, schedule, publishFailures);
  useFillerLifecycle({
    work,
    conversationKey,
    historyGaps,
    activity,
    schedule,
    setFillingGapId,
    publishFailures,
  });

  const status = useMemo<HistoryGapStatus>(
    () => ({ fillingGapId, failures, retry: controls.retry, trackRow: controls.trackRow }),
    [controls.retry, controls.trackRow, failures, fillingGapId],
  );
  return useMemo(
    () => ({
      status,
      schedule,
      /** Holds the filler (a jump, a prompt's turn loading); returns the release. */
      holdForJump: controls.holdForJump,
      resumeFromInput: controls.resumeFromInput,
    }),
    [controls.holdForJump, controls.resumeFromInput, schedule, status],
  );
}

/** What the gap rows, the jump owner and the reader's input call. */
function useFillerControls(work: FillerState, schedule: () => void, publishFailures: () => void) {
  const retry = useCallback((): void => {
    work.failed.clear();
    publishFailures();
    schedule();
  }, [work, schedule, publishFailures]);
  const trackRow = useCallback(
    (row: HTMLElement): (() => void) => {
      work.rows.add(row);
      schedule();
      return () => {
        work.rows.delete(row);
      };
    },
    [work, schedule],
  );
  // A jump, or a prompt's turn loading ahead of one, holds the filler until
  // it settles (or the reader's input does). A newer hold outlives an older
  // one's release.
  const holdForJump = useCallback((): (() => void) => {
    work.holdCount += 1;
    const hold = work.holdCount;
    work.paused = hold;
    work.engaged = true;
    return () => {
      if (work.paused !== hold) return;
      work.paused = 0;
      schedule();
    };
  }, [work, schedule]);
  const resumeFromInput = useCallback((): void => {
    work.engaged = true;
    work.paused = 0;
    schedule();
  }, [work, schedule]);
  return useMemo(
    () => ({ retry, trackRow, holdForJump, resumeFromInput }),
    [holdForJump, resumeFromInput, retry, trackRow],
  );
}

interface LifecycleArgs {
  work: FillerState;
  conversationKey: string | null;
  historyGaps: readonly HistoryGap[];
  activity: ReturnType<typeof useWorkspaceActivity>;
  schedule: () => void;
  setFillingGapId: (gapId: string | null) => void;
  publishFailures: () => void;
}

function useFillerLifecycle({
  work,
  conversationKey,
  historyGaps,
  activity,
  schedule,
  setFillingGapId,
  publishFailures,
}: LifecycleArgs): void {
  // Another conversation in the same scroller: a fill still in flight belongs
  // to the old one and must not clear the new one's state when it lands.
  useLayoutEffect(() => {
    work.generation += 1;
    work.filling = null;
    work.failed.clear();
    work.paused = 0;
    work.engaged = false;
    setFillingGapId(null);
    publishFailures();
  }, [conversationKey, work, publishFailures, setFillingGapId]);
  useEffect(() => {
    // A failed gap another load closed takes its failure with it.
    const open = new Set(historyGaps.map((gap) => gap.id));
    const before = work.failed.size;
    for (const gapId of work.failed.keys()) if (!open.has(gapId)) work.failed.delete(gapId);
    if (work.failed.size !== before) publishFailures();
    if (historyGaps.length > 0) schedule();
  }, [historyGaps, work, schedule, publishFailures]);
  useEffect(() => activity.subscribe(schedule), [activity, schedule]);
  useEffect(
    () => () => {
      // A fill in flight belongs to this mount: its next page must not land.
      work.generation += 1;
      cancelAnimationFrame(work.frame);
      work.frame = 0;
      if (work.delayTimer !== null) clearTimeout(work.delayTimer);
      work.delayTimer = null;
    },
    [work],
  );
}

export type HistoryGapFiller = ReturnType<typeof useHistoryGapFiller>;
