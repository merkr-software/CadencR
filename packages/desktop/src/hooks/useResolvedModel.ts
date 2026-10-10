import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_PROVIDER, type AgentTypeSetting } from "../shared/models";
import type { AgentType } from "../types/agent-types";
import type { RuntimeSelection } from "../shared/models";
import {
  getGetFeatureModelSettingsQueryKey,
  useSetFeatureModelSetting,
  getGetAgentSelectionQueryKey,
} from "../api/generated";
import { useAgentCatalog, useSetFeatureProviderSetting } from "../api/agentRuntime";
import { useResolvedSelection } from "../api/agentSelection";
import { toastError } from "@/lib/api-errors";

const RESOLVED_MODEL_STALE_MS = 5 * 60 * 1000;

function useResolvedModelMutations(
  queryClient: ReturnType<typeof useQueryClient>,
  featureId: number,
) {
  const setModelMutation = useSetFeatureModelSetting({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetFeatureModelSettingsQueryKey(featureId) });
        queryClient.invalidateQueries({ queryKey: getGetAgentSelectionQueryKey() });
      },
    },
  });
  const setProviderMutation = useSetFeatureProviderSetting({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetAgentSelectionQueryKey() });
    },
  });
  return { setModelMutation, setProviderMutation };
}

export function useResolvedModel(featureId: number, projectId: number) {
  const queryClient = useQueryClient();
  const selectionQuery = useResolvedSelection({ projectId, featureId });
  const agentCatalog = useAgentCatalog({ staleTime: RESOLVED_MODEL_STALE_MS });
  const { setModelMutation, setProviderMutation } = useResolvedModelMutations(
    queryClient,
    featureId,
  );

  useEffect(() => {
    if (selectionQuery.error) {
      toastError(selectionQuery.error, "Failed to resolve the runtime selection");
    }
  }, [selectionQuery.error]);

  const resolveSelection = useCallback(
    (agentType: AgentType): RuntimeSelection | null => {
      const resolved = selectionQuery.data?.selections?.[agentType];
      return resolved ? { providerId: resolved.provider_id, modelId: resolved.model_id } : null;
    },
    [selectionQuery.data],
  );

  const resolveModel = useCallback(
    (agentType: AgentType): string => {
      const selection = resolveSelection(agentType);
      if (selection) return selection.modelId;
      const providerId = agentCatalog.data?.default_provider ?? DEFAULT_PROVIDER;
      const provider = agentCatalog.data?.providers.find((p) => p.id === providerId);
      // No hardcoded model fallback: an absent catalog default means "no
      // selection yet" (empty string), never a foreign provider's model id.
      return provider?.default_model ?? "";
    },
    [resolveSelection, agentCatalog.data],
  );

  const resolveProvider = useCallback(
    (agentType: AgentType): string => {
      const selection = resolveSelection(agentType);
      return selection?.providerId ?? agentCatalog.data?.default_provider ?? DEFAULT_PROVIDER;
    },
    [resolveSelection, agentCatalog.data],
  );

  return useMemo(
    () => ({
      resolveModel,
      resolveProvider,
      resolveSelection,
      handleModelChange: (agentType: AgentType, modelId: string) =>
        setModelMutation.mutate({
          id: featureId,
          data: { model_type: agentType, model: modelId },
        }),
      handleProviderChange: (agentType: AgentType, providerId: string) =>
        setProviderMutation.mutate({
          featureId,
          providerType: agentType as AgentTypeSetting,
          provider: providerId,
        }),
    }),
    [
      resolveModel,
      resolveProvider,
      resolveSelection,
      setModelMutation,
      setProviderMutation,
      featureId,
    ],
  );
}
