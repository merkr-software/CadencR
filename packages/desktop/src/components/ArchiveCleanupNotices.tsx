import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useListArchiveCleanups } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { reportDescription, stepsNeedingAttention } from "@/lib/archive-cleanup-report";
import { useArchiveCleanupReviewStore } from "@/stores/archive-cleanup-review-store";

const LOAD_ERROR_TOAST_ID = "archive-cleanups-error";

function noticeId(featureId: number): string {
  return `archive-cleanup-${featureId}`;
}

/**
 * One lasting toast per archived conversation whose cleanup needs the user —
 * a step interrupted by a restart, failed, or blocked from losing work —
 * with a way to review it. Read from the service's journal and refetched on
 * every `app/archive_cleanup` event, so it shows wherever the archive came
 * from and disappears once the cleanup settles. Mount once.
 */
export function ArchiveCleanupNotices(): null {
  const query = useListArchiveCleanups({ query: { retry: false } });
  const shownRef = useRef(new Set<string>());

  useEffect(() => {
    const shown = new Set<string>();
    for (const status of query.data ?? []) {
      const attention = status.running ? [] : stepsNeedingAttention(status.cleanup);
      if (attention.length === 0) continue;
      const id = noticeId(status.feature_id);
      shown.add(id);
      toast.warning(`Cleanup of “${status.title}” is incomplete`, {
        id,
        duration: Infinity,
        description: reportDescription(attention),
        action: {
          label: "Review",
          onClick: () => useArchiveCleanupReviewStore.getState().open(status.feature_id),
        },
      });
    }
    for (const id of shownRef.current) if (!shown.has(id)) toast.dismiss(id);
    shownRef.current = shown;
  }, [query.data]);

  useEffect(() => {
    if (query.error == null) return;
    toast.error(apiErrorMessage(query.error, "Could not load archive cleanups"), {
      id: LOAD_ERROR_TOAST_ID,
    });
  }, [query.error]);

  return null;
}
