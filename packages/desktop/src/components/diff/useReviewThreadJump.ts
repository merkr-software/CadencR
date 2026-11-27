import { useEffect, type RefObject } from "react";
import type { ReviewNavigationTarget } from "@/lib/pr-review-threads";
import { scrollReviewThreadToCenter } from "./scroll-to-review-thread";
import type { DiffViewerNavigationState } from "./useDiffViewerNavigation";

/** Opens a review thread's file and scrolls the thread to the middle of the diff. */
export function useReviewThreadJump(
  target: ReviewNavigationTarget | null | undefined,
  navigation: DiffViewerNavigationState,
  diffAreaRef: RefObject<HTMLDivElement | null>,
): void {
  const selectPath = navigation.tree.navigation.selectPath;
  const revealFile = navigation.revealFile;
  const cancelRevealScroll = navigation.cancelRevealScroll;
  useEffect(() => {
    if (!target) return;
    selectPath(target.filePath);
    revealFile(target.filePath);
    let frame = 0;
    let attempts = 0;
    let cancelThreadScroll = (): void => {};
    const findAndFocus = (): void => {
      const container = diffAreaRef.current;
      const element = visibleReviewThread(container, target.threadId);
      if (container && element) {
        cancelRevealScroll();
        cancelThreadScroll = scrollReviewThreadToCenter(container, target.threadId);
        element.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      // The outer diff virtualizer can continue reconciling estimated file
      // heights after its first jump. Re-issue the intent periodically rather
      // than accepting a mounted-but-zero-size annotation as a finished jump.
      if (attempts % 12 === 0) revealFile(target.filePath);
      if (attempts < 180) frame = requestAnimationFrame(findAndFocus);
    };
    frame = requestAnimationFrame(findAndFocus);
    return () => {
      cancelAnimationFrame(frame);
      cancelRevealScroll();
      cancelThreadScroll();
    };
  }, [cancelRevealScroll, diffAreaRef, revealFile, selectPath, target]);
}

export function visibleReviewThread(
  container: HTMLElement | null,
  threadId: string,
): HTMLElement | null {
  const selector = `[data-review-thread-id="${CSS.escape(threadId)}"]`;
  const element = container?.querySelector<HTMLElement>(selector) ?? null;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
}
