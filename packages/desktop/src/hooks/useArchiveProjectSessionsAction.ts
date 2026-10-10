import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useArchiveProjectSessions } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateByUrlPrefix } from "@/lib/queryClient";

/**
 * Bulk-archives every eligible session of a project (not pinned, no agent
 * turn in flight). Refreshes the feature lists and reports how many sessions
 * were archived — and how many were kept — via a toast.
 */
export function useArchiveProjectSessionsAction() {
  const queryClient = useQueryClient();
  return useArchiveProjectSessions({
    mutation: {
      onSuccess: (response) => {
        void invalidateByUrlPrefix(queryClient, "/api/features");
        const archivedCount = response.archived_ids.length;
        if (archivedCount === 0) {
          toast.info("No sessions to archive in this project");
          return;
        }
        const kept: string[] = [];
        if (response.skipped_pinned > 0) kept.push(`${response.skipped_pinned} pinned`);
        if (response.skipped_running > 0) kept.push(`${response.skipped_running} running`);
        const keptSuffix = kept.length > 0 ? ` (${kept.join(" and ")} kept)` : "";
        toast.success(
          `Archived ${archivedCount} session${archivedCount === 1 ? "" : "s"}${keptSuffix}`,
        );
      },
      onError: (error) => {
        toast.error(`Could not archive sessions: ${apiErrorMessage(error, "Unknown error")}`);
      },
    },
  });
}
