import { useListCustomActions, type CustomAction } from "@/api/generated";
import { startingKey, useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";

/**
 * Safety net under the `custom_action_event` push: while a run is in flight, a
 * slow re-check catches an event lost to a dropped socket.
 */
const RUNNING_FALLBACK_POLL_MS = 10_000;

/** The actions offered in a conversation (the project's, then the global ones). */
export function useFeatureCustomActions(projectId: number, featureId: number) {
  return useListCustomActions(
    { project_id: projectId, feature_id: featureId },
    {
      query: {
        refetchInterval: (query) =>
          (query.state.data ?? []).some(
            (action) => action.last_run != null && action.last_run.ended_at == null,
          )
            ? RUNNING_FALLBACK_POLL_MS
            : false,
      },
    },
  );
}

/** True while this action's launch request is in flight in this conversation. */
export function useIsActionStarting(action: CustomAction | null, featureId: number): boolean {
  return useCustomActionsUiStore((state) =>
    action == null ? false : state.starting[startingKey(action.id, featureId)] === true,
  );
}
