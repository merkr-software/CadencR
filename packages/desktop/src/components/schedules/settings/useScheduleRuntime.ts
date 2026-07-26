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
import { useGetFeature, type Feature, type ScheduleTarget, type TargetKind } from "@/api/generated";
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
  /** `true` while any layer this resolves from is still in flight. Everything
   *  below is a placeholder until it clears — the chip row shows a skeleton
   *  rather than presenting a fallback as the run's real configuration. */
  isResolving: boolean;
}

export function useScheduleRuntime(target: ScheduleTarget): ScheduleRuntime {
  const { data: catalog } = useAgentCatalog();
  const catalogProviders = useMemo(
    () => availableCatalogProviders(catalog?.providers),
    [catalog?.providers],
  );
  // Only a target that creates the conversation inherits the project's
  // defaults. Passing the id for a `conversation` target would fire both
  // project-settings requests for a cascade `inheritedRuntime` then discards.
  const projectDefault = useProjectRuntimeSelection(
    target.kind === "conversation" ? undefined : (target.project_id ?? undefined),
  );
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
      isResolving:
        catalog === undefined ||
        conversation.isLoading ||
        // A new conversation starts on the project's defaults, so those queries
        // gate it; an existing one doesn't consult them at all.
        (target.kind !== "conversation" && projectDefault.isLoading),
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
 * The conversation a `conversation` target names.
 *
 * Fetched by id rather than found in the project's feature list: `project_id` is
 * only required for `new_conversation` targets, so a conversation target that
 * omits it (the composer's locked target, when the route didn't carry a project)
 * would otherwise resolve to nothing and silently inherit the project defaults
 * instead of the conversation's own agent, model, mode and profile.
 */
function useTargetedConversation(target: ScheduleTarget): {
  feature: Feature | undefined;
  isLoading: boolean;
} {
  const featureId = target.feature_id ?? undefined;
  const enabled = featureId != null && target.kind === "conversation";
  // Held briefly: clicking through the conversation picker mounts this once per
  // conversation, and orval's default of 0 would refetch each one on every
  // revisit. A schedule's inherited settings don't change mid-edit.
  const { data: feature, isLoading } = useGetFeature(featureId ?? 0, {
    query: { enabled, staleTime: 60_000 },
  });
  return useMemo(
    () => ({
      feature: enabled ? feature : undefined,
      isLoading: enabled && isLoading,
    }),
    [enabled, feature, isLoading],
  );
}
