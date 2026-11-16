import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useArchiveProjectSessions, useListFeatures } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import {
  archiveFeaturesInCachedLists,
  closeFeatureSession,
  navigateToFeatureOrHome,
} from "@/components/project-feature-navigation";

interface UseArchiveProjectSessionsActionOptions {
  activeFeatureId: number | null;
  projectId: number;
}

function keptSuffix(skippedPinned: number, skippedRunning: number): string {
  const kept: string[] = [];
  if (skippedPinned > 0) kept.push(`${skippedPinned} pinned`);
  if (skippedRunning > 0) kept.push(`${skippedRunning} running`);
  return kept.length > 0 ? ` (${kept.join(" and ")} kept)` : "";
}

/**
 * Bulk-archives every eligible session of a project (not pinned, no agent
 * turn in flight). Closes the archived workspaces, navigates away when the
 * open session was archived, refreshes the feature lists, and reports how
 * many sessions were archived — and how many were kept — via a toast.
 */
export function useArchiveProjectSessionsAction({
  activeFeatureId,
  projectId,
}: UseArchiveProjectSessionsActionOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: features = [] } = useListFeatures({
    project_id: projectId,
    include_archived: true,
  });
  return useArchiveProjectSessions({
    mutation: {
      onSuccess: (response) => {
        const archivedIds = new Set(response.archived_ids);
        archiveFeaturesInCachedLists(queryClient, response.archived_ids);
        for (const featureId of response.archived_ids) closeFeatureSession(featureId);
        void invalidateByUrlPrefix(queryClient, "/api/features");
        if (activeFeatureId != null && archivedIds.has(activeFeatureId)) {
          const remaining = features.filter(
            (feature) => feature.status === "active" && !archivedIds.has(feature.id),
          );
          navigateToFeatureOrHome(navigate, projectId, remaining[0]);
        }
        const archivedCount = response.archived_ids.length;
        const suffix = keptSuffix(response.skipped_pinned, response.skipped_running);
        if (archivedCount === 0) {
          toast.info(`No sessions to archive in this project${suffix}`);
          return;
        }
        toast.success(
          `Archived ${archivedCount} session${archivedCount === 1 ? "" : "s"}${suffix}`,
        );
      },
      onError: (error) => {
        toast.error(`Could not archive sessions: ${apiErrorMessage(error, "Unknown error")}`);
      },
    },
  });
}
