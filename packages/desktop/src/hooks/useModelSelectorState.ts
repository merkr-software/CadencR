import { useEffect } from "react";
import { toast } from "sonner";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AGENT_TYPES,
  availableCatalogProviders,
  DEFAULT_PROVIDER,
  type AgentTypeSetting,
} from "@/shared/models";
import {
  useAgentCatalog,
  useSetFeatureProviderSetting,
  useSetProjectProviderSetting,
  useSetWorkspaceProviderSetting,
} from "@/api/agentRuntime";
import {
  getGetAgentSelectionQueryKey,
  getGetFeatureModelSettingsQueryKey,
  getGetProjectModelSettingsQueryKey,
  getGetWorkspaceModelSettingsQueryKey,
  useSetFeatureModelSetting,
  useSetProjectModelSetting,
  useSetWorkspaceModelSetting,
  type ResolvedSelection,
  type SelectionOrigin,
} from "@/api/generated";
import { useResolvedSelection } from "@/api/agentSelection";
import { toastError } from "@/lib/api-errors";
import type { ModelSelectorRowProvider } from "@/components/ModelSelectorRow";
import {
  getModelDescription,
  getModelLabel,
  getProviderLabel,
  INHERIT_VALUE,
  type UseModelSelectorStateParams,
  type UseModelSelectorStateResult,
  WORKSPACE_ONLY_AGENT_TYPES,
  type ModelSelectorLevel,
  type ModelSelectorRowState,
} from "@/hooks/modelSelectorShared";

type AgentCatalogQuery = ReturnType<typeof useAgentCatalog>;

/**
 * Maps a resolved origin to the badge shown for a row. `level === "global"` has
 * no parent to inherit from, so it always reads as the workspace default.
 */
export function stateLabelFor(
  level: ModelSelectorLevel,
  origin: SelectionOrigin,
): "Default" | "Override" | "Inherited" {
  if (level === "global") return "Default";
  return origin === level ? "Override" : "Inherited";
}

/** The raw value (explicit setting or the inherit sentinel) for the no-op mutation guard. */
function currentRawValue(
  level: ModelSelectorLevel,
  origin: SelectionOrigin | undefined,
  resolvedValue: string,
): string {
  if (level === "global") return resolvedValue;
  return origin === level ? resolvedValue : INHERIT_VALUE;
}

function defaultModelForProviderId(agentCatalog: AgentCatalogQuery, providerId: string): string {
  // An absent catalog default means "no selection yet" (empty string) — never
  // a hardcoded model id from a foreign provider.
  return agentCatalog.data?.providers.find((p) => p.id === providerId)?.default_model ?? "";
}

function useSelectorMutations(
  queryClient: QueryClient,
  projectId: number | undefined,
  featureId: number | undefined,
) {
  const invalidateSelection = (): void => {
    void queryClient.invalidateQueries({ queryKey: getGetAgentSelectionQueryKey() });
  };

  const globalMutation = useSetWorkspaceModelSetting({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetWorkspaceModelSettingsQueryKey() });
        invalidateSelection();
        toast.success("Settings saved");
      },
    },
  });
  const projectMutation = useSetProjectModelSetting({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getGetProjectModelSettingsQueryKey(projectId ?? 0),
        });
        invalidateSelection();
        toast.success("Settings saved");
      },
    },
  });
  const featureMutation = useSetFeatureModelSetting({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getGetFeatureModelSettingsQueryKey(featureId ?? 0),
        });
        invalidateSelection();
        toast.success("Settings saved");
      },
    },
  });
  const globalProviderMutation = useSetWorkspaceProviderSetting({
    onSuccess: () => {
      invalidateSelection();
      toast.success("Settings saved");
    },
    onError: () => toast.error("Failed to save provider setting"),
  });
  const projectProviderMutation = useSetProjectProviderSetting({
    onSuccess: () => {
      invalidateSelection();
      toast.success("Settings saved");
    },
    onError: () => toast.error("Failed to save provider setting"),
  });
  const featureProviderMutation = useSetFeatureProviderSetting({
    onSuccess: () => {
      invalidateSelection();
      toast.success("Settings saved");
    },
    onError: () => toast.error("Failed to save provider setting"),
  });

  return {
    globalMutation,
    projectMutation,
    featureMutation,
    globalProviderMutation,
    projectProviderMutation,
    featureProviderMutation,
  };
}

type SelectorMutations = ReturnType<typeof useSelectorMutations>;

function createSelectionActions(
  level: ModelSelectorLevel,
  projectId: number | undefined,
  featureId: number | undefined,
  agentCatalog: AgentCatalogQuery,
  selectionFor: (agentType: AgentTypeSetting) => ResolvedSelection | undefined,
  mutations: SelectorMutations,
) {
  function handleModelChange(agentType: AgentTypeSetting, value: string): void {
    const modelId = value === INHERIT_VALUE ? "" : value;
    if (level === "global") {
      mutations.globalMutation.mutate({
        data: {
          agent_type: agentType,
          model_id:
            modelId ||
            selectionFor(agentType)?.model_id ||
            defaultModelForProviderId(
              agentCatalog,
              agentCatalog.data?.default_provider ?? DEFAULT_PROVIDER,
            ),
        },
      });
      return;
    }
    if (level === "project" && projectId != null) {
      mutations.projectMutation.mutate({
        id: projectId,
        data: { model_type: agentType, model: modelId },
      });
      return;
    }
    if (level === "feature" && featureId != null) {
      mutations.featureMutation.mutate({
        id: featureId,
        data: { model_type: agentType, model: modelId },
      });
    }
  }

  function handleProviderChange(agentType: AgentTypeSetting, value: string): void {
    const providerId = value === INHERIT_VALUE ? "" : value;
    const resolvedProviderId =
      providerId || agentCatalog.data?.default_provider || DEFAULT_PROVIDER;
    const selectedProvider = agentCatalog.data?.providers.find((p) => p.id === resolvedProviderId);
    if (providerId !== "" && (!selectedProvider || selectedProvider.status !== "available")) {
      return;
    }

    if (level === "global") {
      mutations.globalProviderMutation.mutate({ agentType, providerId: resolvedProviderId });
      return;
    }
    if (level === "project" && projectId != null) {
      mutations.projectProviderMutation.mutate({
        projectId,
        providerType: agentType,
        provider: providerId,
      });
      return;
    }
    if (level === "feature" && featureId != null) {
      mutations.featureProviderMutation.mutate({
        featureId,
        providerType: agentType,
        provider: providerId,
      });
    }
  }

  function applySelection(
    agentType: AgentTypeSetting,
    providerValue: string,
    modelValue: string,
  ): void {
    if (providerValue === INHERIT_VALUE && modelValue === INHERIT_VALUE) {
      // Resolved origins hide invalid stored overrides, so they cannot prove
      // that either persisted field is already empty.
      handleProviderChange(agentType, INHERIT_VALUE);
      handleModelChange(agentType, INHERIT_VALUE);
      return;
    }
    const resolved = selectionFor(agentType);
    const providerId =
      resolved?.provider_id ?? agentCatalog.data?.default_provider ?? DEFAULT_PROVIDER;
    const modelId = resolved?.model_id ?? defaultModelForProviderId(agentCatalog, providerId);
    const currentProviderValue = currentRawValue(level, resolved?.provider_origin, providerId);
    const currentModelValue = currentRawValue(level, resolved?.model_origin, modelId);
    if (providerValue !== currentProviderValue) {
      handleProviderChange(agentType, providerValue);
    }
    if (modelValue !== currentModelValue) {
      handleModelChange(agentType, modelValue);
    }
  }

  return { applySelection };
}

function buildRow(
  agentType: AgentTypeSetting,
  level: ModelSelectorLevel,
  resolved: ResolvedSelection | undefined,
  agentCatalog: AgentCatalogQuery,
  providers: ModelSelectorRowProvider[],
  applySelection: (agentType: AgentTypeSetting, providerValue: string, modelValue: string) => void,
): ModelSelectorRowState {
  const providerId =
    resolved?.provider_id ?? agentCatalog.data?.default_provider ?? DEFAULT_PROVIDER;
  const modelId = resolved?.model_id ?? defaultModelForProviderId(agentCatalog, providerId);
  const providerState = resolved ? stateLabelFor(level, resolved.provider_origin) : "Override";
  const modelState = resolved ? stateLabelFor(level, resolved.model_origin) : "Override";
  const stateLabel =
    providerState === "Override" && modelState === "Override"
      ? "Override"
      : level === "global"
        ? "Default"
        : "Inherited";
  const isInherited = stateLabel === "Inherited";

  return {
    agentType,
    stateLabel,
    selectedProviderId: providerId,
    selectedProviderLabel: getProviderLabel(providers, providerId),
    selectedModelId: modelId,
    selectedModelLabel: getModelLabel(agentCatalog.data?.providers, providerId, modelId),
    selectedModelDescription: getModelDescription(
      agentCatalog.data?.providers,
      providerId,
      modelId,
    ),
    providers,
    isInherited,
    onInherit:
      level !== "global"
        ? () => applySelection(agentType, INHERIT_VALUE, INHERIT_VALUE)
        : undefined,
    onSelect: (nextProviderId: string, nextModelId: string) => {
      applySelection(agentType, nextProviderId, nextModelId);
    },
  } satisfies ModelSelectorRowState;
}

export function useModelSelectorState(
  params: UseModelSelectorStateParams,
): UseModelSelectorStateResult {
  const { level, projectId, featureId } = params;
  const queryClient = useQueryClient();
  const agentCatalog = useAgentCatalog();
  const selectionQuery = useResolvedSelection({
    ...(level !== "global" && projectId != null ? { projectId } : {}),
    ...(level === "feature" && featureId != null ? { featureId } : {}),
  });

  useEffect(() => {
    if (selectionQuery.error) {
      toastError(selectionQuery.error, "Failed to load the model selection");
    }
  }, [selectionQuery.error]);

  const mutations = useSelectorMutations(queryClient, projectId, featureId);

  const providers = availableCatalogProviders(agentCatalog.data?.providers).map(
    (provider): ModelSelectorRowProvider => ({
      id: provider.id,
      label: provider.label,
      disabled: false,
      status: provider.status,
      statusMessage: provider.status_message,
      models: provider.models,
    }),
  );

  const selectionFor = (agentType: AgentTypeSetting): ResolvedSelection | undefined =>
    selectionQuery.data?.selections?.[agentType];

  const { applySelection } = createSelectionActions(
    level,
    projectId,
    featureId,
    agentCatalog,
    selectionFor,
    mutations,
  );

  const visibleAgentTypes = AGENT_TYPES.filter(
    (agentType) => level === "global" || !WORKSPACE_ONLY_AGENT_TYPES.includes(agentType),
  );

  // A failed selection query means `selectionFor` returns undefined for every
  // row, which `buildRow` cannot distinguish from "no override set" — surface
  // the error instead of rendering rows with a misleading "Override" badge.
  const hasSelectionError = Boolean(selectionQuery.error);
  const rows = hasSelectionError
    ? []
    : visibleAgentTypes.map((agentType) =>
        buildRow(
          agentType,
          level,
          selectionFor(agentType),
          agentCatalog,
          providers,
          applySelection,
        ),
      );

  return {
    isLoading: selectionQuery.isLoading || agentCatalog.isLoading,
    hasCatalogError: Boolean(agentCatalog.error),
    hasSelectionError,
    rows,
  };
}
