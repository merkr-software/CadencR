import { useMemo } from "react";
import type { AgentCatalog } from "@/api/agentRuntime";
import { pickerProviderFromCatalog } from "@/components/runtimeModelPickerGroups";
import { resolveProviderModelAlias } from "@/lib/provider-model-aliases";
import { availableCatalogProviders, DEFAULT_PROVIDER } from "@/shared/models";
import { supportedThinkingEffortLevels } from "@/shared/thinking-effort";

export const MODEL_CATALOG_LOADING_LABEL = "Loading model…";
export type ModelSelectionStatus = "catalog-loading" | "selection-pending" | "ready";

interface UseAgentSessionModelStateParams {
  agentCatalog: AgentCatalog | undefined;
  currentProviderId?: string;
  currentModelId?: string;
  runtimeProvider?: string;
  onProviderChange?: (providerId: string) => void;
  hasConversation: boolean;
}

export function useAgentSessionModelState(params: UseAgentSessionModelStateParams) {
  const {
    agentCatalog,
    currentProviderId,
    currentModelId,
    runtimeProvider,
    onProviderChange,
    hasConversation,
  } = params;

  const providerOptions = useMemo(
    () => availableCatalogProviders(agentCatalog?.providers).map(pickerProviderFromCatalog),
    [agentCatalog?.providers],
  );
  const isCatalogLoading = agentCatalog === undefined;

  const activeProviderId = useMemo(() => {
    const currentProvider = providerOptions.find((provider) => provider.id === currentProviderId);
    if (currentProvider) return currentProvider.id;
    const activeRuntimeProvider = providerOptions.find(
      (provider) => provider.id === runtimeProvider,
    );
    if (activeRuntimeProvider) return activeRuntimeProvider.id;
    const catalogDefault = providerOptions.find(
      (provider) => provider.id === agentCatalog?.default_provider,
    );

    return catalogDefault?.id ?? providerOptions[0]?.id ?? DEFAULT_PROVIDER;
  }, [agentCatalog?.default_provider, currentProviderId, providerOptions, runtimeProvider]);

  const hasCompleteSelection = Boolean(currentProviderId && currentModelId);
  const { visibleModels, selectedModel, hasSelectionMismatch } = useMemo(() => {
    const activeProvider = providerOptions.find((provider) => provider.id === activeProviderId);
    const models = activeProvider?.models ?? [];
    const resolvedModelId =
      currentModelId && activeProvider
        ? resolveProviderModelAlias(activeProvider.id, currentModelId, activeProvider.models)
        : currentModelId;
    const model = models.find((candidate) => candidate.id === resolvedModelId);
    const hasProviderMismatch = hasCompleteSelection && activeProviderId !== currentProviderId;
    let hasCatalogMismatch = false;
    if (hasCompleteSelection && activeProvider && currentModelId && !model) {
      hasCatalogMismatch = providerOptions.some((provider) => {
        if (provider.id === activeProviderId) return false;
        const candidateId = resolveProviderModelAlias(provider.id, currentModelId, provider.models);
        return provider.models.some((candidate) => candidate.id === candidateId);
      });
    }
    return {
      visibleModels: models,
      selectedModel: model,
      hasSelectionMismatch: hasProviderMismatch || hasCatalogMismatch,
    };
  }, [activeProviderId, currentModelId, currentProviderId, hasCompleteSelection, providerOptions]);
  const modelSelectionStatus: ModelSelectionStatus = isCatalogLoading
    ? "catalog-loading"
    : !hasCompleteSelection || hasSelectionMismatch
      ? "selection-pending"
      : "ready";
  const currentModelLabel =
    modelSelectionStatus !== "ready"
      ? MODEL_CATALOG_LOADING_LABEL
      : (selectedModel?.label ?? currentModelId ?? "Model");

  // Gate on conversation activity only. Backend-reported `status` races
  // with REST hydration: a freshly-created agent_sessions row is inserted
  // as 'paused' (session_bootstrap::find_or_create_session), so reading
  // status === "idle" here would lock the picker on ~20-25% of new sessions.
  const canChangeProvider = !!onProviderChange && !hasConversation;
  const readyModel = modelSelectionStatus === "ready" ? selectedModel : undefined;
  const supportedThinkingEfforts = useMemo(
    () => supportedThinkingEffortLevels(readyModel),
    [readyModel],
  );
  const supportsFastMode = readyModel?.supports_fast_mode === true;

  // Stable while nothing changed: the composer is memoized on these values.
  return useMemo(
    () => ({
      modelSelectionStatus,
      providerOptions,
      activeProviderId,
      visibleModels,
      currentModelLabel,
      canChangeProvider,
      supportedThinkingEfforts,
      supportsFastMode,
    }),
    [
      modelSelectionStatus,
      providerOptions,
      activeProviderId,
      visibleModels,
      currentModelLabel,
      canChangeProvider,
      supportedThinkingEfforts,
      supportsFastMode,
    ],
  );
}
