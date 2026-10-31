import type { QueryClient } from "@tanstack/react-query";

import {
  getGetCustomActionRunsQueryKey,
  getListCustomActionsQueryKey,
  getListFeatureActivityQueryKey,
} from "@/api/generated";
import { announceFinishedRun } from "./launch";

/**
 * Turn a `custom_action_event` push into query invalidations.
 *
 * The service broadcasts a bare hint whenever an action is edited or one of
 * its runs starts, writes output or ends — including runs started by a
 * schedule or on another device — so the launcher status and an action's page
 * never wait on a poll. An empty payload means the stream lagged: everything
 * custom-action related is re-fetched.
 */
export function applyCustomActionEvent(
  client: QueryClient,
  payload: Record<string, unknown>,
): void {
  const kind = payload.kind;
  const actionId = typeof payload.action_id === "number" ? payload.action_id : null;
  const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;

  if (kind === "changed") {
    void client.invalidateQueries({ queryKey: getListCustomActionsQueryKey() });
    return;
  }
  if (
    (kind === "run_started" || kind === "run_output" || kind === "run_finished") &&
    actionId != null &&
    featureId != null
  ) {
    void client.invalidateQueries({
      queryKey: getGetCustomActionRunsQueryKey(actionId, { feature_id: featureId }),
    });
    if (kind === "run_output") return;
    if (kind === "run_finished" && typeof payload.run_id === "number") {
      void announceFinishedRun(payload.run_id);
    }
    // The list carries each action's `last_run`; the sidebar activity row
    // counts background runs.
    void client.invalidateQueries({
      queryKey: getListCustomActionsQueryKey({ feature_id: featureId }),
    });
    void client.invalidateQueries({ queryKey: getListFeatureActivityQueryKey() });
    return;
  }
  void client.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/custom-actions"),
  });
}
