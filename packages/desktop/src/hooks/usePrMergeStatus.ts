import { useCallback, useEffect, useMemo, useRef } from "react";
import { useGetPrMergeStatus } from "@/api/generated";
import type { PrMergeStatus, PrStatusSnapshot } from "@/api/generated";
import { useFeatureLayoutContext } from "@/components/feature-layout/FeatureLayoutContext";
import { useDocumentVisible } from "@/hooks/useDocumentVisible";
import { apiErrorMessage } from "@/lib/api-errors";
import { isOpenPr } from "@/lib/thread-prs";
import {
  isTabVisible,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";

/** While something is about to change on its own: a queue, auto-merge, a check. */
const MERGE_STATUS_ACTIVE_POLL_MS = 30_000;
/**
 * Otherwise. The snapshot pulse below already catches pushes, reviews and
 * checks; this only covers what the snapshot does not carry. Matches the
 * slowest forge's status poll so the pane never out-polls it.
 */
const MERGE_STATUS_SETTLED_POLL_MS = 120_000;

export interface PrMergeStatusQuery {
  status: PrMergeStatus | undefined;
  isLoading: boolean;
  /** Set when the last read failed — also while an older status is still shown. */
  errorMessage: string | null;
  refetch: () => void;
}

/**
 * Approvals and mergeability for the proposal the PR pane shows.
 *
 * Fetched on demand rather than carried by the status poller: it costs extra
 * forge calls per proposal, and only the one on screen needs them. The poller's
 * snapshot is still the heartbeat — a new head, a review, or a check finishing
 * moves `updated_at`, the head sha, or the rollup, and each of those refetches
 * here at once instead of waiting out the poll. Polling stops while the Git tab
 * or the window is hidden: the tab stays mounted behind the others.
 */
export function usePrMergeStatus(status: PrStatusSnapshot): PrMergeStatusQuery {
  const pr = status.pr;
  const enabled = pr != null && isOpenPr(pr);
  const layoutFeatureId = useFeatureLayoutContext()?.featureId ?? status.feature_id;
  const tabVisible = useFeatureLayoutStore((state) =>
    isTabVisible(selectFeatureLayout(layoutFeatureId)(state), "git"),
  );
  const documentVisible = useDocumentVisible();
  const polling = enabled && tabVisible && documentVisible;
  const query = useGetPrMergeStatus(
    { feature_id: status.feature_id, pr_number: pr?.number ?? 0 },
    {
      query: {
        enabled,
        retry: false,
        refetchInterval: (current) => (polling ? pollInterval(current.state.data) : false),
      },
    },
  );
  const { refetch: refetchQuery } = query;
  usePulseRefetch(status, enabled, refetchQuery);
  const refetch = useCallback((): void => void refetchQuery(), [refetchQuery]);
  const { data, isLoading, error } = query;
  return useMemo(
    () => ({
      status: data,
      isLoading,
      errorMessage: error ? apiErrorMessage(error, "Could not load merge status") : null,
      refetch,
    }),
    [data, isLoading, error, refetch],
  );
}

function pollInterval(status: PrMergeStatus | undefined): number {
  const moving =
    status?.readiness === "checking" || status?.queue_entry != null || status?.auto_merge != null;
  return moving ? MERGE_STATUS_ACTIVE_POLL_MS : MERGE_STATUS_SETTLED_POLL_MS;
}

/**
 * Refetches when the snapshot of the same proposal moves. Switching to another
 * proposal changes the query key, which fetches by itself — a second, forced
 * refetch there would only cancel that one.
 */
function usePulseRefetch(
  status: PrStatusSnapshot,
  enabled: boolean,
  refetch: () => Promise<unknown>,
): void {
  const pr = status.pr;
  const key = `${status.feature_id}#${pr?.number ?? ""}`;
  const pulse = pr ? `${pr.updated_at}|${pr.head_sha}|${pr.state}|${status.ci?.state ?? ""}` : "";
  const last = useRef({ key, pulse });
  useEffect(() => {
    const previous = last.current;
    last.current = { key, pulse };
    if (previous.key !== key || previous.pulse === pulse) return;
    if (enabled) void refetch();
  }, [enabled, key, pulse, refetch]);
}
