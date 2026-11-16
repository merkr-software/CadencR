import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommentThread, PrSummary } from "@/api/generated";
import type { PrReviewThreads } from "@/hooks/usePrReviewThreads";
import { useSendUnresolvedPrComments } from "@/hooks/useSendUnresolvedPrComments";
import type { AgentPathMapper } from "@/lib/git-paths";
import {
  isThreadAnchored,
  type PrThreadLine,
  type ReviewNavigationTarget,
  type ReviewThreadSummary,
} from "@/lib/pr-review-threads";
import type { GitViewMode } from "./GitTabToggle";

export interface GitTabReviews {
  /** True on the two surfaces that show review threads at all. */
  visible: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | undefined;
  retry: () => void;
  unresolved: CommentThread[];
  summary: ReviewThreadSummary;
  /** Per-file anchors for the branch diff; `undefined` everywhere else. */
  remoteThreadLinesByFile: Map<string, PrThreadLine[]> | undefined;
  reviewCountsByFile: ReadonlyMap<string, number>;
  activeTarget: ReviewNavigationTarget | null;
  activePosition: number;
  targetCount: number;
  focusThread: (thread: CommentThread) => void;
  previousThread: () => void;
  nextThread: () => void;
  selectedThreadIds: ReadonlySet<string>;
  selectedCount: number;
  setThreadSelected: (threadId: string, selected: boolean) => void;
  setAllThreadsSelected: (selected: boolean) => void;
  sendSelected: () => void;
  /** Sends one thread on its own — the common case, without a round trip
   *  through the checkbox column. `undefined` when the forge isn't sendable. */
  sendThread: ((thread: CommentThread) => void) | undefined;
  sendDisabled: boolean;
  canSend: boolean;
}

function useReviewThreadNavigation(targets: ReviewNavigationTarget[]) {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const activeIndex = targets.findIndex((target) => target.threadId === activeThreadId);
  useEffect(() => {
    if (activeThreadId && activeIndex < 0) setActiveThreadId(null);
  }, [activeIndex, activeThreadId]);
  const focusThread = useCallback((thread: CommentThread): void => {
    if (isThreadAnchored(thread)) setActiveThreadId(thread.id);
  }, []);
  const moveThread = useCallback(
    (offset: -1 | 1): void => {
      if (targets.length === 0) return;
      const current = activeIndex < 0 ? (offset === 1 ? -1 : 0) : activeIndex;
      const next = (current + offset + targets.length) % targets.length;
      setActiveThreadId(targets[next]?.threadId ?? null);
    },
    [activeIndex, targets],
  );
  return {
    activeIndex,
    activeTarget: activeIndex >= 0 ? targets[activeIndex] : null,
    focusThread,
    previousThread: useCallback((): void => moveThread(-1), [moveThread]),
    nextThread: useCallback((): void => moveThread(1), [moveThread]),
  };
}

function useReviewThreadSelection(unresolved: readonly CommentThread[]) {
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());
  const unresolvedIds = useMemo(() => new Set(unresolved.map((thread) => thread.id)), [unresolved]);
  useEffect(() => {
    setSelectedThreadIds((previous) => {
      const next = new Set([...previous].filter((id) => unresolvedIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [unresolvedIds]);
  const selectedThreads = useMemo(
    () => unresolved.filter((thread) => selectedThreadIds.has(thread.id)),
    [selectedThreadIds, unresolved],
  );
  const setThreadSelected = useCallback(
    (threadId: string, selected: boolean): void => {
      setSelectedThreadIds((previous) => {
        const shouldSelect = selected && unresolvedIds.has(threadId);
        if (previous.has(threadId) === shouldSelect) return previous;
        const next = new Set(previous);
        if (shouldSelect) next.add(threadId);
        else next.delete(threadId);
        return next;
      });
    },
    [unresolvedIds],
  );
  const clearSelection = useCallback(
    (): void => setSelectedThreadIds((previous) => (previous.size === 0 ? previous : new Set())),
    [],
  );
  /**
   * Select-all covers the unresolved threads, which is exactly the set the
   * send action can act on — a resolved thread has no checkbox to tick, so
   * including it would make the header read "all" while the count disagreed.
   */
  const setAllSelected = useCallback(
    (selected: boolean): void =>
      setSelectedThreadIds((previous) => {
        if (!selected) return previous.size === 0 ? previous : new Set();
        if (previous.size === unresolvedIds.size) return previous;
        return new Set(unresolvedIds);
      }),
    [unresolvedIds],
  );
  return useMemo(
    () => ({
      selectedThreadIds,
      selectedThreads,
      setThreadSelected,
      setAllSelected,
      clearSelection,
    }),
    [clearSelection, selectedThreadIds, selectedThreads, setAllSelected, setThreadSelected],
  );
}

/**
 * Owns the Git tab's relationship to the forge's review threads: when to fetch
 * them, which view may anchor them to diff rows, and how they reach the agent.
 *
 * Only the PR view and the branch diff fetch. The working-tree diff has no
 * relationship to the proposal's diff, so asking the forge there would be a
 * round trip whose answer could never be drawn.
 */
export function useGitTabReviews(
  viewMode: GitViewMode,
  pr: PrSummary | null | undefined,
  onSendComments: ((message: string) => void) | undefined,
  reviews: PrReviewThreads,
  toAgentPath: AgentPathMapper | undefined,
): GitTabReviews {
  const visible = (viewMode === "pr" || viewMode === "vs-target") && pr != null;
  const sendReviews = useSendUnresolvedPrComments({
    unresolved: reviews.unresolved,
    pr,
    toAgentPath,
    onSend: onSendComments,
  });
  const sendReviewThreads = sendReviews.send;
  const selection = useReviewThreadSelection(reviews.unresolved);
  const navigation = useReviewThreadNavigation(reviews.navigationTargets);
  const canSend = sendReviews.shouldRender && visible;
  const sendDisabled = sendReviews.disabled || selection.selectedThreads.length === 0;
  // A card's own button is not offered while the paths cannot be named for the
  // agent yet: it would send nothing and drop the thread's pick.
  const canSendThread = canSend && !sendReviews.disabled;
  const sendSelected = useCallback((): void => {
    if (sendDisabled) return;
    sendReviewThreads(selection.selectedThreads);
    selection.clearSelection();
  }, [selection, sendDisabled, sendReviewThreads]);
  const sendOne = useCallback(
    (thread: CommentThread): void => {
      sendReviewThreads([thread]);
      // Drops this thread's own pick, since it has now been sent — but leaves
      // the rest of the batch standing. Clearing the whole selection here would
      // throw away picking work the developer cannot see from this button.
      selection.setThreadSelected(thread.id, false);
    },
    // `selection` as a whole changes identity on every pick; `setThreadSelected`
    // does not. Depending on the bag would hand every review card a new
    // `onSendThread` each time a checkbox moved, undoing the card's `memo`.
    [selection.setThreadSelected, sendReviewThreads],
  );

  return useMemo(
    () => ({
      visible,
      isLoading: reviews.isLoading,
      isRefreshing: reviews.isRefreshing,
      errorMessage: reviews.errorMessage,
      retry: reviews.retry,
      unresolved: reviews.unresolved,
      summary: reviews.summary,
      // Review threads anchor to the proposal's diff, so they only overlay the
      // branch view — replaying those line numbers onto the working tree would
      // point at rows the reviewer never saw.
      remoteThreadLinesByFile: viewMode === "vs-target" ? reviews.unresolvedLinesByFile : undefined,
      reviewCountsByFile: reviews.summary.byFile,
      activeTarget: navigation.activeTarget,
      activePosition: navigation.activeIndex + 1,
      targetCount: reviews.navigationTargets.length,
      focusThread: navigation.focusThread,
      previousThread: navigation.previousThread,
      nextThread: navigation.nextThread,
      selectedThreadIds: selection.selectedThreadIds,
      selectedCount: selection.selectedThreads.length,
      setThreadSelected: selection.setThreadSelected,
      setAllThreadsSelected: selection.setAllSelected,
      sendSelected,
      sendThread: canSendThread ? sendOne : undefined,
      sendDisabled,
      canSend,
    }),
    [
      canSend,
      canSendThread,
      sendOne,
      navigation.activeIndex,
      navigation.activeTarget,
      navigation.focusThread,
      navigation.nextThread,
      navigation.previousThread,
      reviews.errorMessage,
      reviews.isLoading,
      reviews.isRefreshing,
      reviews.navigationTargets.length,
      reviews.retry,
      reviews.summary,
      reviews.unresolved,
      reviews.unresolvedLinesByFile,
      selection,
      sendDisabled,
      sendSelected,
      viewMode,
      visible,
    ],
  );
}
