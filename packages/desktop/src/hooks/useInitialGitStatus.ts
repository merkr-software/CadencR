import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetGitStatusQueryKey, getGitStatus, useGetGitStatus } from "@/api/generated";
import {
  useSettledWorkspaceActive,
  useWorkspaceActivity,
  whileActive,
} from "@/components/workspace-pool/workspace-activity";
import { apiErrorCode, apiErrorMessage, WORKTREE_UNAVAILABLE } from "@/lib/api-errors";
import { clearGitCheckoutQueries, notifyGitStatusHealth } from "@/stores/git-status-health";
import { useGitStatusStore } from "@/stores/useGitStatusStore";

export function useInitialGitStatus(featureId: number, enabled: boolean): void {
  const activity = useWorkspaceActivity();
  const active = useSettledWorkspaceActive();
  const queryClient = useQueryClient();
  const wsAnswered = useGitStatusStore(
    (state) => state.subscriptionByFeature[featureId] === "answered",
  );
  useEffect(() => {
    if (!enabled) return undefined;
    const filters = { queryKey: getGetGitStatusQueryKey({ feature_id: featureId }), exact: true };
    let reactivating = false;
    return whileActive(activity, () => {
      if (
        reactivating &&
        useGitStatusStore.getState().subscriptionByFeature[featureId] !== "answered"
      ) {
        void queryClient.refetchQueries({ ...filters, type: "active" });
      }
      reactivating = true;
      return () => {
        void queryClient.cancelQueries(filters);
      };
    });
  }, [activity, enabled, featureId, queryClient]);
  const params = { feature_id: featureId };
  useGetGitStatus(params, {
    query: {
      enabled: enabled && active && !wsAnswered,
      staleTime: 0,
      retry: (failures, error) => failures < 1 && apiErrorCode(error) !== WORKTREE_UNAVAILABLE,
      // Hydrate only from a request made for this view. Cached successes and
      // requests overtaken by a WS result cannot restore an earlier checkout.
      queryFn: async ({ signal }) => {
        const before = useGitStatusStore.getState();
        const health = before.healthByFeature[featureId];
        const isCurrent = (): boolean => {
          const now = useGitStatusStore.getState();
          return (
            !signal.aborted &&
            activity.isActive() &&
            now.subscriptionByFeature[featureId] !== "answered" &&
            now.healthByFeature[featureId] === health &&
            now.hydrationEpoch[featureId] === before.hydrationEpoch[featureId] &&
            now.watcherEpoch[featureId] === before.watcherEpoch[featureId]
          );
        };
        try {
          const status = await getGitStatus(params, signal);
          if (isCurrent()) {
            if (!useGitStatusStore.getState().byFeature[featureId]) {
              clearGitCheckoutQueries(queryClient, featureId);
            }
            before.hydrateStatus(featureId, status);
            if (health?.statusError) {
              notifyGitStatusHealth(
                featureId,
                health,
                useGitStatusStore.getState().healthByFeature[featureId],
              );
            }
          }
          return status;
        } catch (error) {
          if (isCurrent()) {
            const code = apiErrorCode(error) ?? undefined;
            before.hydrateStatus(
              featureId,
              apiErrorMessage(error, "Failed to load Git status"),
              code,
            );
            if (code === WORKTREE_UNAVAILABLE && health?.statusErrorCode !== code) {
              clearGitCheckoutQueries(queryClient, featureId);
            }
          }
          throw error;
        }
      },
    },
  });
}
