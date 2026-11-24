import { useListCustomActions, type CustomAction } from "@/api/generated";
import { useSettledWorkspaceActive } from "@/components/workspace-pool/workspace-activity";
import { startingKey, useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";

/**
 * Safety net under the `custom_action_event` push: while a run is in flight, a
 * slow re-check catches an event lost to a dropped socket.
 */
const RUNNING_FALLBACK_POLL_MS = 10_000;

interface FeatureCustomActionsOptions {
  /** False skips the request (the list isn't shown). */
  enabled?: boolean;
  /**
   * False for a reader beside the header's launcher, which owns the fallback
   * poll: every observer runs its own interval, so a second one would poll twice.
   */
  poll?: boolean;
}

/**
 * The actions offered in a conversation (the project's, then the global ones).
 * The fallback poll runs only while the conversation is on screen: the top bar
 * of a workspace kept mounted but hidden (`WorkspacePool`) stays mounted.
 */
export function useFeatureCustomActions(
  projectId: number,
  featureId: number,
  { enabled = true, poll = true }: FeatureCustomActionsOptions = {},
) {
  const shown = useSettledWorkspaceActive();
  return useListCustomActions(
    { project_id: projectId, feature_id: featureId },
    {
      query: {
        enabled,
        refetchInterval: (query) =>
          poll &&
          shown &&
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
