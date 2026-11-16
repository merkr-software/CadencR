import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  useDeleteFeature,
  useUpdateFeaturePinned,
  useUpdateFeatureStatus,
  type Feature,
} from "@/api/generated";
import {
  adjacentFeature,
  closeFeatureSession,
  navigateToFeatureOrHome,
  removeFeatureFromCachedLists,
} from "@/components/project-feature-navigation";
import { apiErrorMessage } from "@/lib/api-errors";
import { forgetFeatureProject } from "@/lib/plugin-tabs/feature-projects";
import { invalidateByUrlPrefix } from "@/lib/queryClient";

interface UseFeatureRowMutationsOptions {
  activeFeatureId: number | null;
  /** The project's active conversations: deleting the open one opens a neighbour. */
  activeFeatures: readonly Feature[];
  projectId: number;
}

export interface FeatureRowMutations {
  togglePin: (featureId: number, pinned: boolean) => void;
  unarchive: (featureId: number) => void;
  deleteFeature: (featureId: number) => void;
}

/**
 * The pin, unarchive and delete writes of a conversation row, wherever it is
 * shown. Each refreshes the feature lists once the backend confirms.
 */
export function useFeatureRowMutations({
  activeFeatureId,
  activeFeatures,
  projectId,
}: UseFeatureRowMutationsOptions): FeatureRowMutations {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invalidateFeatures = (): void => void invalidateByUrlPrefix(queryClient, "/api/features");
  const { mutate: updatePinned } = useUpdateFeaturePinned({
    mutation: {
      onSuccess: invalidateFeatures,
      onError: (error) => toast.error(apiErrorMessage(error, "Failed to update pinned state")),
    },
  });
  const { mutate: updateStatus } = useUpdateFeatureStatus({
    mutation: {
      onSuccess: invalidateFeatures,
      onError: (error) => toast.error(apiErrorMessage(error, "Failed to update feature status")),
    },
  });
  const { mutate: deleteMutate } = useDeleteFeature({
    mutation: {
      onSuccess: (_data, variables) => {
        removeFeatureFromCachedLists(queryClient, variables.id);
        closeFeatureSession(variables.id);
        forgetFeatureProject(variables.id);
        invalidateFeatures();
      },
      onError: (error) => toast.error(apiErrorMessage(error, "Failed to delete conversation")),
    },
  });
  const togglePin = useCallback(
    (featureId: number, pinned: boolean) => updatePinned({ id: featureId, data: { pinned } }),
    [updatePinned],
  );
  const unarchive = useCallback(
    (featureId: number) => updateStatus({ id: featureId, data: { status: "active" } }),
    [updateStatus],
  );
  // The neighbour is settled when the delete starts: the dialog closes before
  // the request returns, and the cross-project rows' project goes with it.
  const deleteFeature = useCallback(
    (featureId: number): void => {
      const leaveFor =
        featureId === activeFeatureId ? adjacentFeature(activeFeatures, featureId) : null;
      deleteMutate(
        { id: featureId },
        {
          onSuccess: () => {
            if (leaveFor !== null) navigateToFeatureOrHome(navigate, projectId, leaveFor);
          },
        },
      );
    },
    [activeFeatureId, activeFeatures, deleteMutate, navigate, projectId],
  );
  return useMemo(
    () => ({ togglePin, unarchive, deleteFeature }),
    [deleteFeature, togglePin, unarchive],
  );
}
