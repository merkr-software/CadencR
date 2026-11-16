import { useCallback, useMemo } from "react";
import { useGetPrComments, type CommentThread } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  isThreadUnresolved,
  reviewNavigationTargets,
  sortReviewThreadsForAction,
  summarizeReviewThreads,
  unresolvedThreadLinesByFile,
  type PrThreadLine,
  type ReviewNavigationTarget,
  type ReviewThreadSummary,
} from "@/lib/pr-review-threads";

/**
 * Every comments fetch reaches the forge over the network, so both surfaces
 * that show review threads — the PR tab and the branch diff — go through this
 * hook. Identical query options are what lets React Query serve one shared
 * cache entry instead of two observers racing each other's refetches.
 */
const REVIEW_THREADS_STALE_MS = 60_000;

export interface PrReviewThreads {
  threads: CommentThread[];
  unresolved: CommentThread[];
  unresolvedCount: number;
  /** Unresolved threads that anchor to a file and line, keyed by file path. */
  unresolvedLinesByFile: Map<string, PrThreadLine[]>;
  navigationTargets: ReviewNavigationTarget[];
  summary: ReviewThreadSummary;
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | undefined;
  retry: () => void;
}

/**
 * `prNumber` picks another of the conversation's proposals; leave it unset for
 * the current branch's, so the PR tab and the branch diff share one entry.
 */
export function usePrReviewThreads(
  featureId: number,
  enabled: boolean,
  prNumber?: number,
): PrReviewThreads {
  const query = useGetPrComments(
    prNumber == null ? { feature_id: featureId } : { feature_id: featureId, pr_number: prNumber },
    { query: { enabled, retry: false, staleTime: REVIEW_THREADS_STALE_MS } },
  );
  const { refetch } = query;
  const threads = useMemo(
    () => sortReviewThreadsForAction(query.data?.threads ?? []),
    [query.data],
  );
  const unresolved = useMemo(() => threads.filter(isThreadUnresolved), [threads]);
  const unresolvedLinesByFile = useMemo(
    () => unresolvedThreadLinesByFile(unresolved),
    [unresolved],
  );
  const navigationTargets = useMemo(() => reviewNavigationTargets(unresolved), [unresolved]);
  const summary = useMemo(() => summarizeReviewThreads(unresolved), [unresolved]);
  const errorMessage = query.isError
    ? apiErrorMessage(query.error, "Could not load review threads")
    : undefined;
  const retry = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return useMemo(
    () => ({
      threads,
      unresolved,
      unresolvedCount: unresolved.length,
      unresolvedLinesByFile,
      navigationTargets,
      summary,
      isLoading: query.isLoading && enabled,
      isRefreshing: query.isFetching && enabled,
      errorMessage,
      retry,
    }),
    [
      enabled,
      errorMessage,
      navigationTargets,
      query.isFetching,
      query.isLoading,
      retry,
      summary,
      threads,
      unresolved,
      unresolvedLinesByFile,
    ],
  );
}
