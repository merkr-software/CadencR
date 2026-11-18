import { useCallback, useMemo } from "react";
import { apiErrorMessage } from "@/lib/api-errors";
import { canScrollStream, MAX_VIEWPORT_FILL_PAGES } from "./agent-session-scroll-utils";
import type { ScrollState } from "./useAgentSessionScroll";

const OLDER_HISTORY_FAILURE_FALLBACK = "The service didn't return the older messages.";

/**
 * Loads older history pages as the reader scrolls up (or the viewport isn't
 * full yet). A failed page is kept as `olderLoadError` until the next attempt.
 */
export function useHistoryLoader(state: ScrollState) {
  // Depends on the refs it reads rather than on `state`, which is rebuilt on
  // every stick and loading toggle: `onScroll` closes over this, and with it the
  // scroller ref, whose identity must hold (see `useScrollContainerRef`).
  const requestOlderHistory = useCallback((): void => {
    const loadOlder = state.onLoadOlderRef.current;
    if (!state.hasMoreRef.current || !loadOlder || state.loadingOlderRef.current) return;
    const generation = state.loadGenerationRef.current;
    state.loadingOlderRef.current = true;
    state.setIsLoadingOlder(true);
    state.setOlderLoadError(null);
    void loadOlder()
      .then(() => {
        if (generation !== state.loadGenerationRef.current) return;
        state.historyLoadArmedRef.current = false;
        state.userScrollIntentRef.current = false;
        state.loadingOlderRef.current = false;
        state.setIsLoadingOlder(false);
      })
      .catch((error: unknown) => {
        if (generation !== state.loadGenerationRef.current) return;
        state.historyLoadArmedRef.current = false;
        state.userScrollIntentRef.current = false;
        state.loadingOlderRef.current = false;
        state.setIsLoadingOlder(false);
        // Said at the top of the transcript, with a retry (see `OlderHistoryStatus`).
        state.setOlderLoadError(apiErrorMessage(error, OLDER_HISTORY_FAILURE_FALLBACK));
      });
  }, [
    state.hasMoreRef,
    state.historyLoadArmedRef,
    state.loadGenerationRef,
    state.loadingOlderRef,
    state.onLoadOlderRef,
    state.setIsLoadingOlder,
    state.setOlderLoadError,
    state.userScrollIntentRef,
  ]);
  const maybeFillViewport = useCallback((): void => {
    if (!state.stickRef.current || state.loadingOlderRef.current) return;
    if (!state.hasMoreRef.current || !state.onLoadOlderRef.current) return;
    if (state.viewportFillPagesRef.current >= MAX_VIEWPORT_FILL_PAGES) return;
    const element = state.scrollerElRef.current;
    if (!element || canScrollStream(element)) return;
    state.viewportFillPagesRef.current += 1;
    requestOlderHistory();
  }, [requestOlderHistory, state]);
  const resetIntent = useCallback((): void => {
    state.historyLoadArmedRef.current = false;
    state.userScrollIntentRef.current = false;
    state.lastScrollTopRef.current = state.scrollerElRef.current?.scrollTop ?? 0;
  }, [state]);
  const armUserScrollIntent = useCallback((): void => {
    state.userScrollIntentRef.current = true;
  }, [state.userScrollIntentRef]);
  return useMemo(
    () => ({ armUserScrollIntent, maybeFillViewport, requestOlderHistory, resetIntent }),
    [armUserScrollIntent, maybeFillViewport, requestOlderHistory, resetIntent],
  );
}

export type HistoryLoader = ReturnType<typeof useHistoryLoader>;
