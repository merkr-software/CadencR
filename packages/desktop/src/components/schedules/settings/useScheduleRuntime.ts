/**
 * What a scheduled run will actually be configured with.
 *
 * Every chip in the schedule editor answers the same two questions — what does
 * this run inherit, and what has the user pinned — so they resolve it once here
 * rather than each re-deriving the provider from the target.
 *
 * Inheritance differs by target kind. A schedule that creates the conversation
 * inherits the project's defaults (the same cascade "New session" walks); one
 * that posts into an existing conversation inherits that conversation's own
 * settings, which the features list already carries.
 */
import { useMemo } from "react";
import {
  useListFeatures,
  type Feature,
  type ScheduleTarget,
  type TargetKind,
} from "@/api/generated";
import {
  useAgentCatalog,
  type RuntimeModelOption,
  type RuntimeProviderOption,
} from "@/api/agentRuntime";
import type { Provider } from "@/components/agent-session/ModelMetaChip";
import { useProjectRuntimeSelection } from "@/hooks/useProjectRuntimeSelection";
import { resolveProviderModelAlias } from "@/lib/provider-model-aliases";
import { defaultEditModeFor } from "@/lib/provider-modes";
import { availableCatalogProviders } from "@/shared/models";
import { parseThinkingEffort, type ThinkingEffortLevel } from "@/shared/thinking-effort";
import type { PermissionMode } from "@/types/permission-mode";
import { parseAccessMode, type AccessMode } from "@/types/access-mode";

export interface ScheduleRuntime {
  /** Agent the run will use — pinned, inherited from the conversation, or the
   *  project default. */
  providerId: string | undefined;
  /** Catalog entry for that agent: its modes, access modes and models. */
  provider: RuntimeProviderOption | undefined;
  modelId: string | undefined;
  /** Catalog entry for the effective model — thinking-effort levels live here. */
  model: RuntimeModelOption | undefined;
  /** Agents the model picker may offer. An existing conversation is bound to
   *  its own, so only that one is listed. */
  pickerProviders: Provider[];
  permissionMode: PermissionMode;
  thinkingLevel: ThinkingEffortLevel | undefined;
  accessMode: AccessMode;
  profile: string | undefined;
  isCatalogLoading: boolean;
  /** `true` once the conversation a `conversation` target names has loaded, so
   *  chips don't flash the project's defaults before the real ones arrive. */
  isTargetLoading: boolean;
}

export function useScheduleRuntime(target: ScheduleTarget): ScheduleRuntime {
  const { data: catalog } = useAgentCatalog();
  const catalogProviders = useMemo(
    () => availableCatalogProviders(catalog?.providers),
    [catalog?.providers],
  );
  const projectDefault = useProjectRuntimeSelection(target.project_id ?? undefined);
  const conversation = useTargetedConversation(target);

  return useMemo(() => {
    const inherited = inheritedRuntime(target.kind, conversation.feature, projectDefault);
    const providerId = target.provider ?? inherited.providerId;
    const provider = catalogProviders.find((entry) => entry.id === providerId);
    const modelId = target.model ?? inherited.modelId;
    return {
      providerId,
      provider,
      modelId,
      model: findModel(provider, providerId, modelId),
      pickerProviders: pickerProviders(catalogProviders, target.kind, providerId),
      permissionMode:
        (target.permission_mode as PermissionMode | undefined) ??
        (inherited.permissionMode as PermissionMode | undefined) ??
        defaultEditModeFor(providerId),
      thinkingLevel: parseThinkingEffort(target.thinking_level ?? inherited.thinkingLevel),
      accessMode: parseAccessMode(target.access_mode ?? inherited.accessMode ?? undefined),
      profile: target.profile ?? inherited.profile,
      isCatalogLoading: catalog === undefined,
      isTargetLoading: conversation.isLoading,
    };
  }, [catalog, catalogProviders, conversation, projectDefault, target]);
}

interface InheritedRuntime {
  providerId: string | undefined;
  modelId: string | undefined;
  thinkingLevel: string | undefined;
  permissionMode: string | undefined;
  accessMode: string | undefined;
  profile: string | undefined;
}

function inheritedRuntime(
  kind: TargetKind,
  conversation: Feature | undefined,
  projectDefault: { providerId: string | undefined; modelId: string | undefined },
): InheritedRuntime {
  if (kind !== "conversation") {
    // A conversation that doesn't exist yet has no settings of its own; it will
    // start on the project's, so that is what the chips show.
    return {
      providerId: projectDefault.providerId,
      modelId: projectDefault.modelId,
      thinkingLevel: undefined,
      permissionMode: undefined,
      accessMode: undefined,
      profile: undefined,
    };
  }
  return {
    providerId: conversation?.runtime_provider ?? undefined,
    modelId: conversation?.model_session ?? undefined,
    thinkingLevel: conversation?.thinking_effort ?? undefined,
    permissionMode: conversation?.permission_mode ?? undefined,
    accessMode: conversation?.access_mode ?? undefined,
    profile: conversation?.profile ?? undefined,
  };
}

/**
 * Settings store coarse aliases ("opus"); the catalog advertises concrete ids
 * ("opus[1m]"). Resolve through the same map the picker highlights with, so the
 * chip names the model and knows its effort levels.
 */
function findModel(
  provider: RuntimeProviderOption | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): RuntimeModelOption | undefined {
  const models = provider?.models ?? [];
  if (!providerId || !modelId) return undefined;
  const resolved = resolveProviderModelAlias(providerId, modelId, models);
  return models.find((entry) => entry.id === modelId || entry.id === resolved);
}

function pickerProviders(
  catalogProviders: RuntimeProviderOption[],
  kind: TargetKind,
  providerId: string | undefined,
): Provider[] {
  return catalogProviders
    .filter((provider) => kind !== "conversation" || provider.id === providerId)
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      disabled: false,
      models: provider.models,
    }));
}

/**
 * The conversation a `conversation` target names, read from the list the target
 * picker already loaded — so its settings cost no extra request.
 */
function useTargetedConversation(target: ScheduleTarget): {
  feature: Feature | undefined;
  isLoading: boolean;
} {
  const projectId = target.project_id ?? undefined;
  const enabled = projectId != null && target.kind === "conversation";
  const { data: features, isLoading } = useListFeatures(
    { project_id: projectId ?? 0 },
    { query: { enabled } },
  );
  return useMemo(
    () => ({
      feature: Array.isArray(features)
        ? features.find((entry) => entry.id === target.feature_id)
        : undefined,
      isLoading: enabled && isLoading,
    }),
    [enabled, features, isLoading, target.feature_id],
  );
}
