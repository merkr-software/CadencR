import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  useArchiveFeature,
  type ArchiveRequest,
  type ArchiveResponse,
  type CleanupReport,
  type Feature,
} from "@/api/generated";
import {
  archiveNavigationTarget,
  archiveFeaturesInCachedLists,
  closeFeatureSession,
  navigateToFeatureOrHome,
} from "@/components/project-feature-navigation";
import {
  doneSummary,
  isSettledReport,
  reportDescription,
  reportedSteps,
  stepsNeedingAttention,
} from "@/lib/archive-cleanup-report";
import { invalidateByUrlPrefix } from "@/lib/queryClient";

export type ArchiveFeatureOptions = Required<ArchiveRequest>;

interface UseArchiveFeatureActionOptions {
  activeFeatureId: number | null;
  activeFeatures: readonly Feature[];
  projectId: number | null;
}

export function useArchiveFeatureAction({
  activeFeatureId,
  activeFeatures,
  projectId,
}: UseArchiveFeatureActionOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useArchiveFeature({
    mutation: {
      onSuccess: (response) => {
        const archivedIds = new Set(response.archived_ids);
        archiveFeaturesInCachedLists(queryClient, response.archived_ids);
        for (const featureId of response.archived_ids) closeFeatureSession(featureId);
        void invalidateByUrlPrefix(queryClient, "/api/features");
        showCleanupOutcome(response.cleanup);
        if (projectId == null) return;
        const target = archiveNavigationTarget(activeFeatures, activeFeatureId, archivedIds);
        if (target === undefined) return;
        navigateToFeatureOrHome(navigate, projectId, target ?? undefined);
      },
    },
  });
  const { mutateAsync } = mutation;
  return useCallback(
    (featureId: number, options: ArchiveFeatureOptions): Promise<ArchiveResponse> =>
      mutateAsync({ id: featureId, data: options }),
    [mutateAsync],
  );
}

/**
 * The service ran the whole cleanup before answering. Steps that need the
 * user (interrupted, failed, blocked) are surfaced by `ArchiveCleanupNotices`
 * from the service's journal, on every client; this toast covers the rest.
 */
function showCleanupOutcome(report: CleanupReport): void {
  const steps = reportedSteps(report);
  if (steps.length === 0 || stepsNeedingAttention(report).length > 0) return;
  if (isSettledReport(report)) {
    toast.success("Session archived", { description: doneSummary(report) });
    return;
  }
  const waiting = steps.filter(
    ({ step }) => step.status === "pending" || step.status === "running",
  );
  toast.success("Session archived", { description: reportDescription(waiting) });
}
