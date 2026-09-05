import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_PROVIDER, type AgentTypeSetting } from "../shared/models";
import type { AgentType } from "../types/agent-types";
import type { RuntimeSelection } from "../shared/models";
import {
  getGetFeatureModelSettingsQueryKey,
  useSetFeatureModelSetting,
  useSetWorkspaceSetting,
  getGetAgentSelectionQueryKey,
} from "../api/generated";
import {
  getWorkspaceSettingsQueryKey,
  settingsArrayToMap,
  useGetWorkspaceSettings,
} from "@/api/settings";
import { useAgentCatalog, useSetFeatureProviderSetting } from "../api/agentRuntime";
import {
  isThinkingEffortSupported,
  parseThinkingEffort,
  supportedThinkingEffortLevels,
  thinkingEffortModelKey,
  type ThinkingEffortLevel,
} from "@/shared/thinking-effort";
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
  const setWorkspaceSettingMutation = useSetWorkspaceSetting({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getWorkspaceSettingsQueryKey() }),
    },
  });
  return { setModelMutation, setProviderMutation, setWorkspaceSettingMutation };
}

export function useResolvedModel(featureId: number, projectId: number) {
  const queryClient = useQueryClient();
  const selectionQuery = useResolvedSelection({ projectId, featureId });
  const agentCatalog = useAgentCatalog({ staleTime: RESOLVED_MODEL_STALE_MS });
  const workspaceKvSettings = useGetWorkspaceSettings();
  const { setModelMutation, setProviderMutation, setWorkspaceSettingMutation } =
    useResolvedModelMutations(queryClient, featureId);

  const workspaceSettingMap = useMemo(
    () => settingsArrayToMap(workspaceKvSettings.data),
    [workspaceKvSettings.data],
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

  const resolveModelThinkingEffort = useCallback(
    (providerId: string, modelId: string): ThinkingEffortLevel | undefined => {
      const model = agentCatalog.data?.providers
        .find((provider) => provider.id === providerId)
        ?.models.find((entry) => entry.id === modelId);
      const levels = supportedThinkingEffortLevels(model);
      const value = workspaceSettingMap[thinkingEffortModelKey(providerId, modelId)];
      const effort = parseThinkingEffort(value);
      return effort && isThinkingEffortSupported(levels, effort) ? effort : undefined;
    },
    [agentCatalog.data?.providers, workspaceSettingMap],
  );

  const setModelThinkingEffort = useCallback(
    (providerId: string, modelId: string, effort: ThinkingEffortLevel | undefined): void => {
      setWorkspaceSettingMutation.mutate({
        key: thinkingEffortModelKey(providerId, modelId),
        data: { value: effort ?? "" },
      });
    },
    [setWorkspaceSettingMutation],
  );

  return useMemo(
    () => ({
      resolveModel,
      resolveProvider,
      resolveSelection,
      resolveModelThinkingEffort,
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
      setModelThinkingEffort,
    }),
    [
      resolveModel,
      resolveProvider,
      resolveSelection,
      resolveModelThinkingEffort,
      setModelThinkingEffort,
      setModelMutation,
      setProviderMutation,
      featureId,
    ],
  );
}
