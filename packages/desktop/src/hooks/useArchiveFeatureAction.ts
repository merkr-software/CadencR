import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { isAxiosError } from "axios";
import { useArchiveFeature, type ArchiveRequest, type Feature } from "@/api/generated";
import {
  archiveNavigationTarget,
  archiveFeaturesInCachedLists,
  closeFeatureSession,
  isArchivedInCachedLists,
  navigateToFeatureOrHome,
} from "@/components/project-feature-navigation";
import {
  failArchiveProgress,
  finishArchiveProgress,
  startArchiveProgress,
} from "@/lib/archive-progress-toast";
import { invalidateByUrlPrefix } from "@/lib/queryClient";

export type ArchiveFeatureOptions = Required<ArchiveRequest>;

interface UseArchiveFeatureActionOptions {
  activeFeatureId: number | null;
  activeFeatures: readonly Feature[];
  projectId: number | null;
}

/**
 * Archives without holding the dialog: a toast follows the request — the
 * cleanup steps as the service runs them, then the outcome or the error.
 */
export function useArchiveFeatureAction({
  activeFeatureId,
  activeFeatures,
  projectId,
}: UseArchiveFeatureActionOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useArchiveFeature({
    mutation: {
      // The dialog closes as the request leaves: its project and the list to
      // navigate within are read now, not from the options when it answers.
      onMutate: ({ id }) => {
        startArchiveProgress(id);
        return { projectId, activeFeatures };
      },
      onSuccess: (response, { id }, context) => {
        const archivedIds = new Set(response.archived_ids);
        archiveFeaturesInCachedLists(queryClient, response.archived_ids);
        for (const featureId of response.archived_ids) closeFeatureSession(featureId);
        void invalidateByUrlPrefix(queryClient, "/api/features");
        finishArchiveProgress(id, response.cleanup);
        if (context.projectId == null) return;
        const target = archiveNavigationTarget(
          context.activeFeatures,
          activeFeatureId,
          archivedIds,
        );
        if (target === undefined) return;
        navigateToFeatureOrHome(navigate, context.projectId, target ?? undefined);
      },
      // A request that got no answer after `app/archive_cleanup` marked the
      // archive in the cached lists (it commits before any cleanup step) lost
      // only the report; any answer from the service is its own error.
      onError: (error, { id }) =>
        failArchiveProgress(
          id,
          error,
          isAxiosError(error) &&
            error.response === undefined &&
            isArchivedInCachedLists(queryClient, id),
        ),
    },
  });
  const { mutate } = mutation;
  return useCallback(
    (featureId: number, options: ArchiveFeatureOptions): void =>
      mutate({ id: featureId, data: options }),
    [mutate],
  );
}
