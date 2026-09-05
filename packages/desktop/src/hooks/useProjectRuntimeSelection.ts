/**
 * The agent and model a *new* conversation in a project would start with —
 * `useResolvedModel` minus the feature level, which doesn't exist yet.
 *
 * The schedule editor uses it so its model chip shows the concrete model a run
 * will use instead of the words "project default": a schedule is read months
 * after it is written, and "whatever the project says" is not something you can
 * check at a glance.
 *
 * The precedence cascade lives in the backend (`GET /agent/selection`); this
 * hook only reads the resolved pair.
 */
import { useMemo } from "react";
import { DEFAULT_PROVIDER, type RuntimeSelection } from "@/shared/models";
import { useAgentCatalog } from "@/api/agentRuntime";
import { useResolvedSelection, sessionSelectionOf } from "@/api/agentSelection";

const STALE_MS = 5 * 60 * 1000;

export interface ProjectRuntimeSelection extends RuntimeSelection {
  /** `true` until the backend has answered. Until then the selection
   *  is a fallback, not the project's real default — a chip that presented it
   *  as final would be showing the user the wrong model. */
  isLoading: boolean;
}

export function useProjectRuntimeSelection(projectId: number | undefined): ProjectRuntimeSelection {
  const catalog = useAgentCatalog({ staleTime: STALE_MS });
  const selectionQuery = useResolvedSelection({
    projectId,
    enabled: projectId != null,
  });

  const resolved = sessionSelectionOf(selectionQuery.data);
  const selection: RuntimeSelection =
    resolved != null
      ? { providerId: resolved.provider_id, modelId: resolved.model_id }
      : {
          providerId: catalog.data?.default_provider ?? DEFAULT_PROVIDER,
          modelId:
            catalog.data?.providers.find(
              (provider) => provider.id === (catalog.data?.default_provider ?? DEFAULT_PROVIDER),
            )?.default_model ?? "",
        };

  const isLoading =
    catalog.isLoading ||
    (projectId != null && (selectionQuery.isLoading || selectionQuery.isPending));

  const { providerId, modelId } = selection;
  return useMemo(() => ({ providerId, modelId, isLoading }), [providerId, modelId, isLoading]);
}
