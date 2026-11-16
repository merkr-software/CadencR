import type { AgentCatalog, RuntimeModelOption } from "@/api/agentRuntime";
import type { AgentTypeSetting } from "@/shared/models";
import type { ModelSelectorRowProvider } from "@/components/ModelSelectorRow";

export type ModelSelectorLevel = "global" | "feature";

export const INHERIT_VALUE = "__inherit__";

export const WORKSPACE_ONLY_AGENT_TYPES: readonly AgentTypeSetting[] = ["auto_name"] as const;

export const MODEL_SELECTOR_AGENT_LABELS: Record<AgentTypeSetting, string> = {
  session: "Session",
  auto_name: "Auto-naming",
};

export interface ModelSelectorRowState {
  agentType: AgentTypeSetting;
  stateLabel: string;
  selectedProviderId: string;
  selectedProviderLabel: string;
  selectedModelId: string;
  selectedModelLabel: string;
  selectedModelDescription?: string;
  providers: ModelSelectorRowProvider[];
  isInherited: boolean;
  onInherit?: () => void;
  onSelect: (providerId: string, modelId: string) => void;
}

export interface UseModelSelectorStateParams {
  level: ModelSelectorLevel;
  featureId?: number;
  /** Rows to show; defaults to every agent type the level supports. */
  agentTypes?: readonly AgentTypeSetting[];
}

export interface UseModelSelectorStateResult {
  isLoading: boolean;
  hasCatalogError: boolean;
  hasSelectionError: boolean;
  rows: ModelSelectorRowState[];
}

export function getProviderLabel(
  providers: ModelSelectorRowProvider[],
  providerId: string,
): string {
  return providers.find((provider) => provider.id === providerId)?.label ?? providerId;
}

export function getModelOption(
  providers: AgentCatalog["providers"] | undefined,
  providerId: string,
  modelId: string,
): RuntimeModelOption | undefined {
  return providers
    ?.find((provider) => provider.id === providerId)
    ?.models.find((model) => model.id === modelId);
}

export function getModelLabel(
  providers: AgentCatalog["providers"] | undefined,
  providerId: string,
  modelId: string,
): string {
  return getModelOption(providers, providerId, modelId)?.label ?? modelId;
}

export function getModelDescription(
  providers: AgentCatalog["providers"] | undefined,
  providerId: string,
  modelId: string,
): string | undefined {
  return getModelOption(providers, providerId, modelId)?.description;
}
